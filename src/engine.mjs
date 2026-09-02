// engine.mjs — FreeModelRegistry, health state machine, runtime learning, ranking,
// task-aware selection, and fallback orchestration. Pure logic (I/O injected via adapters).
//
// Invariant: the route resolves to the best *current* model satisfying the
// agentic-frontier-free profile. No model id is hard-coded as the winner.
import {
  normalizeModel, stealthSimilarity, agenticQuality, contextScore, emptyRuntime,
  RANK_WEIGHTS, GOOD_FINISH_REASONS,
} from "./classify.mjs";

const DEFAULT_CONFIG = {
  policy: { freeOnly: true, paidFallback: false },
  strategy: {
    capabilityAware: true,
    adaptive: true,
    explorationRate: 0.05,
    // Min sample size before a candidate can outrank an incumbent with >100 successes.
    minSamples: 5,
    // Candidate must be within this fraction of the incumbent score to be explored.
    exploreGap: 0.15,
    // Exploration pool ceiling (also capped at half the ranked list).
    explorePoolMax: 4,
  },
  discovery: { enabled: true, ttlHours: 6 },
  fallback: { enabled: true, maxDepth: 4, attemptTimeoutMs: 45_000 },
  health: {
    cooldownEnabled: true,
    maxCooldownSec: 480,
    // Per-failure-type cap override (seconds). When unset, `maxCooldownSec` is
    // the global cap. These are *separate* from `cooldownByType` (the per-type
    // base); the base is what exponential backoff scales up from, and the cap
    // is what clamps it. Letting `model_not_found`/`client_error` extend to
    // 1h lets the catalog refresh + retry-after-cadence cycle naturally —
    // a single 404 should *not* come back into rotation after only 8 min if
    // the underlying provider actually removed the model.
    maxCooldownSecByType: {
      rate_limit: 480,        // 8 min — short rate-limit window
      timeout: 480,           // 8 min
      transport: 480,         // 8 min
      server_error: 480,      // 8 min
      finish_error: 600,      // 10 min
      model_not_found: 3600,  // 1 h — free-tier models cycle out/in; allow recovery within a session
      client_error: 3600,     // 1 h — same reasoning
    },
    // Per-failure-type cooldown base (ms). Exponential backoff is layered on top.
    cooldownByType: {
      rate_limit: 60_000,    // short/moderate
      timeout: 90_000,       // moderate
      transport: 90_000,     // moderate
      server_error: 90_000,  // moderate
      finish_error: 120_000, // moderate
      model_not_found: 30 * 60 * 1000, // 30 min base — exponential will push to 1h on second hit
      client_error: 30 * 60 * 1000,    // 30 min base
    },
  },
  privacy: { showProviderPolicy: true },
  thresholds: { tools: 0.35, vision: 0.30, coding: 0.30, largeContextTokens: 128000 },
  // time-decay penalty weights & halflives (ms)
  penalties: {
    rateLimit: { weight: 0.15, halflifeMs: 600_000 },
    timeout: { weight: 0.10, halflifeMs: 300_000 },
    serverError: { weight: 0.12, halflifeMs: 300_000 },
    toolFailure: { weight: 0.05, halflifeMs: 300_000 },
    structuredFailure: { weight: 0.05, halflifeMs: 300_000 },
    finishError: { weight: 0.10, halflifeMs: 300_000 },
  },
};

const PROVIDER_COOLDOWN_STATES = new Set(["cooldown", "unavailable"]);

// Wilson lower bound on success rate (z=1.96 ≈ 95% CI). For small n, this pulls
// the observed rate downward so a model with 1/1 success doesn't outrank a
// model with 200/205 (98%).
function wilsonLower(successes, n, z = 1.96) {
  if (n === 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (center - margin) / denom);
}

export class FreeRouter {
  constructor({ config = {}, adapters = [], clock = () => Date.now(), rng = Math.random, logger = () => {} } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adapters = adapters; // [{id, displayName, dataPolicy, configured(), discoverModels(), healthCheck(), execute()}]
    this.clock = clock;
    this.rng = rng;
    this.log = logger;
    this.models = new Map(); // key "provider/model" -> normalized model
    this.providerHealth = new Map(); // provider id -> {state, cooldownUntil, consecutiveErrors}
    this.lastCatalogRefresh = new Map(); // provider id -> ts
    this.catalogFetching = new Map(); // provider id -> Promise (dedupe)
    this.stats = { requests: 0, successes: 0, fallbacks: 0, rateLimit: 0, timeouts: 0, fivexx: 0 };
    // Exploration tracking
    this.exploration = {
      attempts: 0,
      successes: 0,
      failures: 0,
      lastExplored: null,        // "provider/model"
      lastExploredAt: 0,
      lastOutcome: null,         // "success" | "failure"
    };
    // Initialize each adapter's health based on whether it's currently
    // configured. Adapters that aren't yet ready (no key, local install
    // missing, etc.) are marked NOT_CONFIGURED so they don't pollute the
    // DEGRADED bucket that means "transient failure".
    for (const a of this.adapters) {
      if (a.configured()) {
        this.providerHealth.set(a.id, { state: "unknown", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, proxied: !!a.isProxied?.() });
      } else {
        const hint = a.installHint || null;
        this.providerHealth.set(a.id, { state: "not-configured", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, hint });
      }
    }
  }

  // ---- discovery -------------------------------------------------------------------
  providerEligible(adapter) {
    if (!adapter.configured()) return false;
    const ph = this.providerHealth.get(adapter.id);
    if (ph && PROVIDER_COOLDOWN_STATES.has(ph.state) && this.clock() < ph.cooldownUntil) return false;
    return true;
  }

  catalogStale(providerId) {
    const ts = this.lastCatalogRefresh.get(providerId) || 0;
    return (this.clock() - ts) > (this.config.discovery.ttlHours || 6) * 3600_000;
  }

  async refreshCatalogs({ force = false, providers = null } = {}) {
    const now = this.clock();
    const jobs = [];
    for (const a of this.adapters) {
      if (providers && !providers.includes(a.id)) continue;
      if (!a.configured()) continue;
      if (!force && !this.catalogStale(a.id)) continue;
      if (this.catalogFetching.has(a.id)) { jobs.push(this.catalogFetching.get(a.id)); continue; }
      const p = this._discoverOne(a).finally(() => this.catalogFetching.delete(a.id));
      this.catalogFetching.set(a.id, p);
      jobs.push(p);
    }
    await Promise.all(jobs);
    // prune models not seen in this refresh (only if we refreshed at least one provider)
    if (force || jobs.length > 0) this.pruneDisappeared(now);
    return this.models;
  }

  async _discoverOne(adapter) {
    const now = this.clock();
    try {
      const raw = await adapter.discoverModels();
      let n = 0;
      for (const r of raw) {
        const m = normalizeModel(r, adapter.id, adapter.dataPolicy);
        const key = this.modelKey(m.provider, m.id);
        const existing = this.models.get(key);
        if (existing) {
          // preserve learned runtime/health; refresh static metadata
          this.models.set(key, { ...m, runtime: existing.runtime, health: existing.health, lastSeen: now, lastSuccess: existing.lastSuccess, lastFailure: existing.lastFailure });
        } else {
          m.lastSeen = now;
          this.models.set(key, m);
        }
        n++;
      }
      this.lastCatalogRefresh.set(adapter.id, now);
      this._markProvider(adapter.id, "healthy", 0);
      this.log("discover", { provider: adapter.id, models: n });
      return n;
    } catch (e) {
      const reason = String(e.message || e).slice(0, 200);
      // Cloudflare / network-edge blocks: short cooldown (frequent retries are pointless
      // because the block is on the IP, not transient). 60s instead of 120s.
      const isBlock = /cloudflare|forbidden|access denied|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(reason);
      const base = isBlock ? 60_000 : 120_000;
      this._markProvider(adapter.id, "degraded", this.cooldownMs(1, base), isBlock ? "network-blocked" : reason);
      this.log("discover-failed", { provider: adapter.id, error: reason });
      return 0;
    }
  }

  pruneDisappeared(now) {
    for (const [key, m] of this.models) {
      if (m.lastSeen && (now - m.lastSeen) > 2 * (this.config.discovery.ttlHours || 6) * 3600_000) {
        this.models.delete(key);
      }
    }
  }

  modelKey(provider, id) { return `${provider}/${id}`; }

  // ---- provider health -------------------------------------------------------------
  _markProvider(id, state, cooldownUntil, reason = null) {
    const cur = this.providerHealth.get(id) || { state: "healthy", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0 };
    const next = { ...cur, state, cooldownUntil };
    if (state === "degraded" || state === "unavailable") {
      next.consecutiveErrors = (cur.consecutiveErrors || 0) + 1;
      if (reason) { next.lastError = reason; next.lastErrorAt = this.clock(); }
    } else if (state === "healthy") {
      next.consecutiveErrors = 0;
    }
    this.providerHealth.set(id, next);
  }

  // Mark a provider as not-configured (e.g. local install missing, or no API
  // key). Distinct from "degraded" (transient failure) and "unavailable"
  // (provider explicitly disabled by us). NOT_CONFIGURED means the operator
  // hasn't enabled this provider.
  _markProviderNotConfigured(id, hint = null) {
    this.providerHealth.set(id, { state: "not-configured", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, hint });
  }

  cooldownMs(consecutive, base = 60_000, type = null) {
    // Per-failure-type base when caller passes a known type; falls back to default base.
    const t = type && this.config.health.cooldownByType && this.config.health.cooldownByType[type];
    const b = t || base;
    // Per-type cap (when set) overrides the global `maxCooldownSec`. This lets
    // us give `model_not_found`/`client_error` a longer ceiling than the
    // short-burst types (`rate_limit`/`timeout`).
    const capSec = (type && this.config.health.maxCooldownSecByType?.[type]) || (this.config.health.maxCooldownSec || 480);
    const max = capSec * 1000;
    return Math.min(max, b * Math.pow(2, Math.max(0, consecutive - 1)));
  }

  providerMultiplier(providerId) {
    const ph = this.providerHealth.get(providerId);
    if (!ph) return 1;
    if (ph.state === "healthy") return 1;
    if (ph.state === "degraded") return 0.5;
    return 0;
  }

  // ---- candidate pipeline ----------------------------------------------------------
  // task: { purpose: "coding-agent", hasTools, hasImages, largeContext, estimatedInputTokens }
  hardEligible(model, task) {
    if (!model.free) return { ok: false, reason: "paid" };
    if (this.providerMultiplier(model.provider) === 0) return { ok: false, reason: "provider-unavailable" };
    const h = model.health;
    if (h.state === "unavailable" && this.clock() < h.cooldownUntil) return { ok: false, reason: "unavailable" };
    if (h.state === "cooldown" && this.clock() < h.cooldownUntil) return { ok: false, reason: "cooldown" };
    // Anti-correlated-burst reset: if a model's cooldown has expired without
    // any fresh failure (state still says "cooldown"/"unavailable" but clock has
    // passed cooldownUntil), the next failure should NOT inherit an inflated
    // consecutive count from the burst that sent the model here. Halve the
    // counter so the next cooldown is shorter. This prevents one edge-429
    // storm from simultaneously sending every probed model to the 480s cap.
    if (h.state === "cooldown" || h.state === "unavailable") {
      if (this.clock() >= h.cooldownUntil) {
        if (h.consecutive429) h.consecutive429 = Math.max(1, Math.floor(h.consecutive429 / 2));
        if (h.consecutiveTimeout) h.consecutiveTimeout = Math.max(1, Math.floor(h.consecutiveTimeout / 2));
        if (h.consecutive5xx) h.consecutive5xx = Math.max(1, Math.floor(h.consecutive5xx / 2));
        if (h.consecutiveFinishErr) h.consecutiveFinishErr = Math.max(1, Math.floor(h.consecutiveFinishErr / 2));
        if (h.consecutiveNotFound) h.consecutiveNotFound = Math.max(1, Math.floor(h.consecutiveNotFound / 2));
        if (h.consecutiveClientErr) h.consecutiveClientErr = Math.max(1, Math.floor(h.consecutiveClientErr / 2));
      }
    }
    const th = this.config.thresholds;
    if (task.purpose === "coding-agent" && model.capabilities.coding < th.coding) return { ok: false, reason: "no-code-gen" };
    if (task.hasTools && model.capabilities.tools < th.tools) return { ok: false, reason: "no-tool-calling" };
    if (task.hasImages && model.capabilities.vision < th.vision) return { ok: false, reason: "no-vision" };
    return { ok: true };
  }

  _decay(weight, lastAt, halflifeMs) {
    if (!lastAt) return 0;
    const age = this.clock() - lastAt;
    if (age < 0) return 0;
    return weight * Math.exp(-age / halflifeMs);
  }

  score(model, task) {
    const r = model.runtime;
    // Confidence-adjusted reliability:
    //  - 0 requests: trust the static capability profile (use 0.5 prior)
    //  - < minSamples: shrink observed rate toward 0.5 prior (Bayesian-style)
    //  - >= minSamples: Wilson lower bound on observed success rate
    let rawRel;
    const minSamples = this.config.strategy.minSamples || 5;
    if (r.requests === 0) {
      rawRel = 0.5;
    } else if (r.requests < minSamples) {
      // shrinkage toward 0.5 prior (each request has half the prior's influence)
      const prior = 0.5;
      const observed = r.successes / r.requests;
      const w = r.requests / (r.requests + minSamples);
      rawRel = w * observed + (1 - w) * prior;
    } else {
      rawRel = wilsonLower(r.successes, r.requests);
    }
    const reliability = model.finishCompat * this.providerMultiplier(model.provider) *
      rawRel * (model.health.state === "degraded" ? 0.6 : 1);
    const capFit = stealthSimilarity(model);
    const need = task.largeContext ? this.config.thresholds.largeContextTokens : 32768;
    const ctxFit = Math.min(1, (model.context.inputTokens || 0) / need);
    const latency = r.requests > 0 ? Math.min(1, 2000 / Math.max(1, r.avgLatencyMs)) : 0.5;

    const w = RANK_WEIGHTS;
    let total =
      w.capabilityFit * capFit +
      w.agenticQuality * agenticQuality(model) +
      w.reliability * reliability +
      w.codingQuality * model.capabilities.coding +
      w.contextFit * ctxFit +
      w.toolQuality * model.capabilities.tools +
      w.latency * latency;

    const p = this.config.penalties;
    total -= this._decay(p.rateLimit.weight, r.last429At, p.rateLimit.halflifeMs);
    total -= this._decay(p.timeout.weight, r.lastTimeoutAt, p.timeout.halflifeMs);
    total -= this._decay(p.serverError.weight, r.last5xxAt, p.serverError.halflifeMs);
    total -= this._decay(p.toolFailure.weight, r.lastToolFailAt, p.toolFailure.halflifeMs);
    total -= this._decay(p.structuredFailure.weight, r.lastStructFailAt, p.structuredFailure.halflifeMs);
    total -= this._decay(p.finishError.weight, r.lastFinishErrAt, p.finishError.halflifeMs);

    const score = Math.max(0, Math.min(1, total));
    return { score: +score.toFixed(4), breakdown: { capFit, reliability: +reliability.toFixed(4), rawRel: +rawRel.toFixed(4), samples: r.requests, ctxFit, latency, agentic: agenticQuality(model), coding: model.capabilities.coding, tools: model.capabilities.tools } };
  }

  // Returns candidates sorted best-first with {model, score, breakdown, reason}.
  rankCandidates(task, { exclude = null } = {}) {
    const out = [];
    for (const m of this.models.values()) {
      if (exclude && exclude.has(this.modelKey(m.provider, m.id))) continue;
      const hard = this.hardEligible(m, task);
      if (!hard.ok) continue;
      const { score, breakdown } = this.score(m, task);
      out.push({ model: m, score, breakdown });
    }
    out.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
    return out;
  }

  select(task, { exclude = null, allowExploration = true } = {}) {
    const ranked = this.rankCandidates(task, { exclude });
    if (ranked.length === 0) {
      // Surface the soonest-to-recover candidate so callers can either wait
      // (and tell the client Retry-After) or fail fast. Including `nextEligibleAt`
      // and `nextEligibleModel` in the response lets the server return a 503
      // with a meaningful Retry-After instead of a blind 502.
      const soonest = this.soonestRecoverable(task, exclude);
      return {
        ok: false,
        error: "NO_FREE_AGENT_MODEL_AVAILABLE",
        candidates: [],
        nextEligibleAt: soonest?.nextEligibleAt ?? null,
        nextEligibleModel: soonest?.model ?? null,
      };
    }

    let chosen = ranked[0];
    let explored = false;
    const exploreRate = this.config.strategy.explorationRate || 0;
    if (allowExploration && ranked.length >= 2 && this.rng() < exploreRate) {
      // SMART EXPLORATION:
      // Only consider runners that are (a) hard-eligible (paid/cooldown/unhealthy already
      // filtered by rankCandidates), (b) healthy, and either
      //   - close to the incumbent in score, OR
      //   - under-sampled (unknown) but capability-close to the incumbent
      const inc = ranked[0];
      const gap = this.config.strategy.exploreGap ?? 0.15;
      const maxPool = this.config.strategy.explorePoolMax ?? 4;
      const minSamples = this.config.strategy.minSamples || 5;
      const scoreThreshold = Math.max(0, inc.score - gap);
      const capThreshold = (inc.breakdown?.capFit ?? 0) - gap;
      const pool = [];
      for (let i = 1; i < ranked.length && pool.length < maxPool; i++) {
        const c = ranked[i];
        if (c.model.free !== true) continue;               // absolute free-only guard
        if (c.model.health.state !== "healthy") continue;   // never explore unhealthy
        const underSampled = c.model.runtime.requests < minSamples;
        const capClose = (c.breakdown?.capFit ?? 0) >= capThreshold;
        const scoreClose = c.score >= scoreThreshold;
        if (scoreClose || (underSampled && capClose)) pool.push(c);
      }
      if (pool.length) { chosen = pool[Math.floor(this.rng() * pool.length)]; explored = true; }
    }

    return {
      ok: true,
      candidate: { provider: chosen.model.provider, model: chosen.model.id, score: chosen.score, modelRecord: chosen.model },
      explored,
      why: this.explain(chosen, ranked),
      ranked: ranked.slice(0, 10).map((r) => ({ provider: r.model.provider, model: r.model.id, score: r.score })),
    };
  }

  explain(chosen, ranked) {
    const b = chosen.breakdown;
    const alts = ranked.slice(1, 4).map((r) => {
      const state = r.model.health.state;
      const altReason = state === "cooldown" ? "cooldown" : state === "unavailable" ? "unavailable" : `score ${r.score} < ${chosen.score}`;
      return `${r.model.provider}/${r.model.id} → ${altReason}`;
    });
    return {
      selected: `${chosen.model.provider}/${chosen.model.id}`,
      score: chosen.score,
      breakdown: {
        capabilityFit: b.capFit, agenticQuality: b.agentic, reliability: b.reliability,
        codingQuality: b.coding, contextFit: b.ctxFit, toolQuality: b.tools, latency: b.latency,
      },
      alternatives: alts,
    };
  }

  // ---- fallback: next best candidate not yet tried ---------------------------------
  nextCandidate(task, tried) {
    const ranked = this.rankCandidates(task, { exclude: tried });
    if (!ranked.length) return null;
    return { provider: ranked[0].model.provider, model: ranked[0].model.id, score: ranked[0].score, modelRecord: ranked[0].model };
  }

  // Returns the model with the soonest-to-expire cooldown (best static-capability
  // among those) so callers can compute a Retry-After. Excludes paid models and
  // models currently in the exclude set. Returns null if nothing is on cooldown.
  soonestRecoverable(task, exclude = null) {
    const now = this.clock();
    let best = null;
    for (const m of this.models.values()) {
      if (!m.free) continue;
      if (exclude && exclude.has(this.modelKey(m.provider, m.id))) continue;
      if (this.providerMultiplier(m.provider) === 0) continue;
      const h = m.health;
      if (!(h.cooldownUntil > now)) continue;
      const remainingMs = h.cooldownUntil - now;
      if (!best || remainingMs < best.remainingMs) {
        best = { model: `${m.provider}/${m.id}`, nextEligibleAt: h.cooldownUntil, remainingMs, capabilityFit: m.capabilities?.coding ?? 0 };
      }
    }
    return best ? { model: best.model, nextEligibleAt: best.nextEligibleAt } : null;
  }

  // ---- runtime learning + health --------------------------------------------------
  // outcome: { type: "success"|"finish_error"|"rate_limit"|"timeout"|"server_error"|"client_error"|"model_not_found"|"transport", latencyMs, finishReason, hadTools, sawToolCall, hadStructured, explored? }
  recordOutcome(providerId, modelId, outcome) {
    const key = this.modelKey(providerId, modelId);
    const m = this.models.get(key);
    const now = this.clock();
    this.stats.requests++;

    if (!m) return; // unknown model (should not happen post-discovery)
    const r = m.runtime;
    r.requests++;
    r.totalLatencyMs += outcome.latencyMs || 0;
    r.avgLatencyMs = r.totalLatencyMs / r.requests;

    if (outcome.hadTools) r.toolRequests++;
    if (outcome.hadStructured) r.structuredRequests++;

    const isSuccess = outcome.type === "success" && (outcome.finishReason == null || GOOD_FINISH_REASONS.has(outcome.finishReason));

    // Exploration accounting
    if (outcome.explored) {
      this.exploration.attempts++;
      this.exploration.lastExplored = key;
      this.exploration.lastExploredAt = now;
      if (isSuccess) { this.exploration.successes++; this.exploration.lastOutcome = "success"; }
      else { this.exploration.failures++; this.exploration.lastOutcome = "failure"; }
    }

    if (isSuccess) {
      r.successes++;
      if (outcome.hadTools && outcome.sawToolCall) r.toolSuccesses++;
      if (outcome.hadStructured) r.structuredSuccesses++;
      m.health.state = "healthy";
      m.health.cooldownUntil = 0;
      m.health.consecutive429 = 0; m.health.consecutiveTimeout = 0;
      m.health.consecutive5xx = 0; m.health.consecutiveFinishErr = 0;
      m.health.consecutiveNotFound = 0; m.health.consecutiveClientErr = 0;
      m.lastSuccess = now;
      this.stats.successes++;
      this._markProvider(providerId, "healthy", 0);
      return { success: true };
    }

    // failure path
    r.failures++;
    m.lastFailure = now;
    switch (outcome.type) {
      case "finish_error":
        r.finishErrCount++; r.lastFinishErrAt = now; m.health.consecutiveFinishErr++;
        if (m.health.consecutiveFinishErr >= 3) m.health.state = "unavailable";
        else m.health.state = "degraded";
        if (m.health.state === "unavailable") m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutiveFinishErr, 60_000, "finish_error");
        break;
      case "rate_limit":
        r.rateLimitCount++; r.last429At = now; m.health.consecutive429++;
        m.health.state = "cooldown";
        m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutive429, 60_000, "rate_limit");
        this.stats.rateLimit++;
        break;
      case "timeout":
        r.timeoutCount++; r.lastTimeoutAt = now; m.health.consecutiveTimeout++;
        m.health.state = m.health.consecutiveTimeout >= 2 ? "degraded" : m.health.state;
        if (m.health.state === "degraded") m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutiveTimeout, 60_000, "timeout");
        this.stats.timeouts++;
        break;
      case "transport":
        r.timeoutCount++; r.lastTimeoutAt = now; m.health.consecutiveTimeout++;
        m.health.state = m.health.consecutiveTimeout >= 2 ? "degraded" : m.health.state;
        if (m.health.state === "degraded") m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutiveTimeout, 60_000, "transport");
        this.stats.timeouts++;
        break;
      case "server_error":
        r.fivexxCount++; r.last5xxAt = now; m.health.consecutive5xx++;
        m.health.state = m.health.consecutive5xx >= 2 ? "cooldown" : "degraded";
        if (m.health.state === "cooldown") m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutive5xx, 60_000, "server_error");
        this.stats.fivexx++;
        break;
      case "model_not_found":
        r.notFoundCount++; m.health.consecutiveNotFound++;
        m.health.state = "unavailable";
        m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutiveNotFound, 60_000, "model_not_found");
        break;
      case "client_error": // 4xx other than 429: auth/data-policy — provider-level signal
        r.clientErrCount++; m.health.consecutiveClientErr++;
        m.health.state = "unavailable";
        m.health.cooldownUntil = now + this.cooldownMs(m.health.consecutiveClientErr, 60_000, "client_error");
        break;
      default:
        r.failures--; r.requests--; // uncounted
        break;
    }
    return { success: false, type: outcome.type };
  }

  // ---- diagnostics ----------------------------------------------------------------
  diagnostics() {
    const now = this.clock();
    const ranked = this.rankCandidates({ purpose: "coding-agent", hasTools: false, hasImages: false, largeContext: true });
    const providerHealth = {};
    for (const [id, ph] of this.providerHealth) {
      providerHealth[id] = {
        state: ph.state.toUpperCase(),
        lastError: ph.lastError || null,
        lastErrorAt: ph.lastErrorAt || null,
        consecutiveErrors: ph.consecutiveErrors || 0,
        cooldownRemainingSec: ph.cooldownUntil > now ? Math.ceil((ph.cooldownUntil - now) / 1000) : 0,
        proxied: ph.proxied || false,
        hint: ph.hint || null,
      };
    }
    for (const a of this.adapters) if (!providerHealth[a.id]) providerHealth[a.id] = { state: a.configured() ? "UNKNOWN" : "NOT_CONFIGURED" };
    const models = [];
    for (const m of this.models.values()) {
      if (!m.free) continue;
      const scored = ranked.find((r) => r.model === m);
      const inCooldown = m.health.cooldownUntil > now && m.health.state !== "healthy";
      const cooldownRemainingSec = inCooldown ? Math.ceil((m.health.cooldownUntil - now) / 1000) : 0;
      models.push({
        model: `${m.provider}/${m.id}`,
        health: m.health.state,
        requests: m.runtime.requests,
        successes: m.runtime.successes,
        successRate: m.runtime.requests ? +(m.runtime.successes / m.runtime.requests).toFixed(3) : null,
        avgLatencyMs: m.runtime.requests ? Math.round(m.runtime.avgLatencyMs) : null,
        score: scored?.score ?? null,
        breakdown: scored?.breakdown ?? null,
        inCooldown,
        cooldownRemainingSec,
        cooldownUntil: m.health.cooldownUntil || null,
        consecutive429: m.health.consecutive429 || 0,
      });
    }
    models.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const expSuccessRate = this.exploration.attempts ? +(this.exploration.successes / this.exploration.attempts).toFixed(3) : null;
    return {
      route: "free-best",
      currentWinner: ranked[0] ? `${ranked[0].model.provider}/${ranked[0].model.id}` : null,
      winnerScore: ranked[0]?.score ?? null,
      top10: ranked.slice(0, 10).map((r) => ({ model: `${r.model.provider}/${r.model.id}`, score: r.score })),
      providerHealth,
      modelHealth: models,
      stats: { ...this.stats, successRate: this.stats.requests ? +(this.stats.successes / this.stats.requests).toFixed(3) : null },
      exploration: {
        rate: this.config.strategy.explorationRate || 0,
        minSamples: this.config.strategy.minSamples || 5,
        exploreGap: this.config.strategy.exploreGap ?? 0.15,
        attempts: this.exploration.attempts,
        successes: this.exploration.successes,
        failures: this.exploration.failures,
        successRate: expSuccessRate,
        lastExplored: this.exploration.lastExplored,
        lastExploredAt: this.exploration.lastExploredAt,
        lastOutcome: this.exploration.lastOutcome,
      },
      fallbackCount: this.stats.fallbacks,
      lastCatalogRefresh: Object.fromEntries(this.lastCatalogRefresh),
      catalogFresh: Object.fromEntries([...this.lastCatalogRefresh].map(([p, ts]) => [p, now - ts < (this.config.discovery.ttlHours || 6) * 3600_000])),
    };
  }
}

export { DEFAULT_CONFIG, emptyRuntime };
