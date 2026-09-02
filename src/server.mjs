// server.mjs — OpenAI-compatible HTTP server for the free-best router.
// Receives one logical route (model: free-best), selects the best current free model
// across providers, relays the stream verbatim (JSON-safe, model field preserved),
// records outcomes, and falls back across models/providers/catalog.
// Never logs secrets.
import { createServer } from "node:http";
import { FreeRouter } from "./engine.mjs";
import { GOOD_FINISH_REASONS } from "./classify.mjs";

const MAX_BODY = 20 * 1024 * 1024;

function deriveTask(body) {
  const messages = body.messages || [];
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  let hasImages = false, estTokens = 0;
  for (const msg of messages) {
    const c = msg.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part.type === "image_url" || part.type === "image") hasImages = true;
        else if (typeof part.text === "string") estTokens += Math.ceil(part.text.length / 4);
      }
    } else if (typeof c === "string") estTokens += Math.ceil(c.length / 4);
    if (msg.tool_calls) hasTools = true;
  }
  const hasStructured = !!(body.response_format);
  return { purpose: "coding-agent", hasTools, hasImages, hasStructured, largeContext: estTokens > 30000, estimatedInputTokens: estTokens };
}

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function sseHead(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new Error("body too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function classifyHttpStatus(status) {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status === 404) return "model_not_found";
  if (status >= 400) return "client_error";
  return "transport";
}

export function createRouterServer(router, adapters) {
  const byId = new Map(adapters.map((a) => [a.id, a]));

  // Relays an upstream 2xx stream to the client, inspecting for finish/tools/usage.
  async function relayStream(upstream, res, routeModel) {
    sseHead(res);
    const reader = upstream.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    let finishReason = null, sawToolCall = false, usage = null;
    const emit = (line) => res.write(line + "\n");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") { emit(line); continue; }
            try {
              const j = JSON.parse(payload);
              if (j && typeof j === "object" && !Array.isArray(j)) {
                const ch = j.choices?.[0];
                if (ch?.delta?.tool_calls?.length) sawToolCall = true;
                if (ch?.finish_reason) finishReason = ch.finish_reason;
                if (j.usage) usage = j.usage;
                emit("data: " + JSON.stringify(j));
                continue;
              }
            } catch { /* non-JSON data line — pass through */ }
          }
          emit(line);
        }
      }
      if (buf) emit(buf);
    } finally {
      res.end();
    }
    return { finishReason, sawToolCall, usage };
  }

  // One attempt against a candidate. Returns outcome consumed by the fallback loop.
  async function attempt(adapter, cand, body, task, res, signal, routeModel, isStream) {
    const start = Date.now();
    // Expose the actual selected model as response metadata. The body model
    // field is preserved (NOT rewritten) so DSH/pi-ai captures the real picked
    // model into responseModel. The header is the canonical source of truth.
    const actualModel = `${cand.provider}/${cand.model}`;
    res.setHeader("x-free-router-model", actualModel);
    res.setHeader("x-free-router-route", routeModel);
    // Per-attempt deadline: even if the upstream is a free-tier model that
    // sits in OpenRouter's inference queue for 30-120s, this attempt is
    // bounded so the router doesn't burn 4×maxAttempts of dead time before
    // failing. Configurable via config.routing.attemptTimeoutMs (default 45s).
    const ATTEMPT_TIMEOUT_MS = router.config.fallback?.attemptTimeoutMs
      ?? router.config.attemptTimeoutMs
      ?? 45_000;
    const attemptCtl = new AbortController();
    const timeoutId = setTimeout(() => attemptCtl.abort(new Error("attempt-timeout")), ATTEMPT_TIMEOUT_MS);
    const chain = () => {
      if (!signal) return attemptCtl.signal;
      const fwd = () => attemptCtl.abort(signal.reason);
      signal.addEventListener("abort", fwd, { once: true });
      return attemptCtl.signal;
    };
    let upstream;
    try {
      upstream = await adapter.execute({ model: cand.model, body, signal: chain() });
    } catch (e) {
      clearTimeout(timeoutId);
      const isTimeout = attemptCtl.signal.aborted && !signal?.aborted;
      return { kind: "retry", type: isTimeout ? "timeout" : "transport", latencyMs: Date.now() - start };
    }
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;

    if (!upstream.ok) {
      let errText = "";
      try { errText = (await upstream.text()).slice(0, 300); } catch {}
      const type = classifyHttpStatus(upstream.status);
      const is429 = upstream.status === 429;
      // model-not-found or auth/data-policy: force catalog refresh (level 3 signal)
      if (upstream.status === 404) router.refreshCatalogs({ force: true, providers: [cand.provider] });
      return { kind: "retry", type, status: upstream.status, latencyMs, errText, retryAfterSec: is429 ? parseRetryAfter(upstream, errText) : null };
    }

    if (isStream) {
      const r = await relayStream(upstream, res, routeModel);
      const finishOk = r.finishReason == null || GOOD_FINISH_REASONS.has(r.finishReason);
      return { kind: "done", type: finishOk ? "success" : "finish_error", finishReason: r.finishReason, sawToolCall: r.sawToolCall, latencyMs };
    }

    // non-stream
    const text = await upstream.text();
    let finishReason = null, sawToolCall = false, usage = null;
    try {
      const j = JSON.parse(text);
      finishReason = j.choices?.[0]?.finish_reason ?? null;
      sawToolCall = !!(j.choices?.[0]?.message?.tool_calls?.length);
      usage = j.usage;
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(JSON.stringify(j));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    }
    const finishOk = finishReason == null || GOOD_FINISH_REASONS.has(finishReason);
    return { kind: "done", type: finishOk ? "success" : "finish_error", finishReason, sawToolCall, latencyMs, usage };
  }

  function parseRetryAfter(upstream, errText) {
    const h = upstream.headers.get("retry-after");
    if (h && !isNaN(Number(h))) return Number(h);
    try { const j = JSON.parse(errText); return j?.metadata?.retry_after_seconds ?? j?.retry_after_seconds ?? null; } catch { return null; }
  }

  async function runCompletion(res, req, body) {
    const task = deriveTask(body);
    const isStream = body.stream === true;
    const routeModel = body.model || "free-best";
    const tried = new Set();
    let lastOutcome = null;
    const maxAttempts = router.config.fallback.enabled ? Math.max(1, router.config.fallback.maxDepth || 4) : 1;
    let attempts = 0;

    for (attempts = 0; attempts < maxAttempts; attempts++) {
      const sel = router.select(task, { exclude: tried, allowExploration: attempts === 0 });
      // Exploration only happens on the first attempt; the header records it once.
      if (attempts === 0) res.setHeader("x-free-router-explored", sel.explored ? "true" : "false");
      if (!sel.ok) {
        // Empty eligible set. First try a forced catalog refresh + re-rank
        // once — if a stale 4xx/health state was blocking a model we don't
        // know about yet, this surfaces it. If still empty, bail fast with
        // the soonest-to-recover hint so the client knows when to retry.
        await router.refreshCatalogs({ force: true });
        const sel2 = router.select(task, { exclude: tried, allowExploration: false });
        if (!sel2.ok) {
          lastOutcome = { kind: "retry", type: "empty-pool", nextEligibleAt: sel.nextEligibleAt, nextEligibleModel: sel.nextEligibleModel };
          break;
        }
        const outcome2 = await attempt(byId.get(sel2.candidate.provider), sel2.candidate, body, task, res, req.signal, routeModel, isStream);
        tried.add(router.modelKey(sel2.candidate.provider, sel2.candidate.model));
        router.recordOutcome(sel2.candidate.provider, sel2.candidate.model, toRecordOutcome(outcome2, task, false));
        if (outcome2.kind === "done") { lastOutcome = outcome2; break; }
        lastOutcome = outcome2; continue;
      }

      const cand = sel.candidate;
      tried.add(router.modelKey(cand.provider, cand.model));
      const adapter = byId.get(cand.provider);
      if (!adapter) { lastOutcome = { kind: "retry", type: "transport" }; continue; }

      const out = await attempt(adapter, cand, body, task, res, req.signal, routeModel, isStream);
      router.recordOutcome(cand.provider, cand.model, toRecordOutcome(out, task, sel.explored));
      if (out.kind === "done") { lastOutcome = out; break; }
      lastOutcome = out;
      if (attempts > 0) router.stats.fallbacks++;
    }

    // Nothing succeeded. If we already started a stream we can't happen here (streams return "done" on 2xx).
    if (!lastOutcome || lastOutcome.kind === "retry") {
      const err = lastOutcome || {};
      // Compute a useful Retry-After from the soonest-recoverable cooldown,
      // clamped to a reasonable minimum (1s) and maximum (10 min). Without
      // this hint clients either hammer the router (loop of 502s) or wait
      // blindly.
      const soonestMs = err.nextEligibleAt ? Math.max(0, err.nextEligibleAt - Date.now()) : null;
      const retryAfterSec = err.retryAfterSec
        ?? (soonestMs != null ? Math.min(600, Math.max(1, Math.ceil(soonestMs / 1000))) : null);
      if (retryAfterSec != null) res.setHeader("Retry-After", String(retryAfterSec));
      if (err.nextEligibleModel) res.setHeader("x-free-router-next-eligible", err.nextEligibleModel);
      if (err.status === 429) {
        json(res, 429, {
          error: {
            message: "NO_FREE_AGENT_MODEL_AVAILABLE (all candidates rate-limited)",
            code: 429,
            retry_after_seconds: retryAfterSec ?? 60,
            next_eligible_model: err.nextEligibleModel ?? null,
          },
        });
      } else {
        json(res, 502, {
          error: {
            message: "NO_FREE_AGENT_MODEL_AVAILABLE",
            code: "NO_FREE_AGENT_MODEL_AVAILABLE",
            last_error_type: err.type || "unknown",
            next_eligible_at: err.nextEligibleAt ?? null,
            next_eligible_model: err.nextEligibleModel ?? null,
            attempts: attempts + 1,
          },
        });
      }
      return;
    }
    // "done" already wrote the response.
  }

  function toRecordOutcome(out, task, explored = false) {
    return {
      type: out.type, latencyMs: out.latencyMs || 0, finishReason: out.finishReason,
      hadTools: task.hasTools, sawToolCall: out.sawToolCall, hadStructured: task.hasStructured,
      explored,
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) return json(res, 200, { status: "ok", route: "free-best" });
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return json(res, 200, { object: "list", data: [{ id: "free-best", object: "model", owned_by: "free-router" }] });
      }
      if (req.method === "GET" && (url.pathname === "/diagnostics" || url.pathname === "/")) {
        const d = router.diagnostics();
        if (url.pathname === "/" || (req.headers.accept || "").includes("text/html") || (req.headers.accept || "").includes("text/plain")) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(diagnosticsText(d));
          return;
        }
        return json(res, 200, d);
      }
      if (req.method === "POST" && (url.pathname === "/_refresh" || url.pathname === "/refresh")) {
        await router.refreshCatalogs({ force: true });
        return json(res, 200, { ok: true, diagnostics: router.diagnostics() });
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = await readBody(req);
        return await runCompletion(res, req, body);
      }
      json(res, 404, { error: { message: "not found", path: url.pathname } });
    } catch (e) {
      try { json(res, 400, { error: { message: String(e.message || e).slice(0, 200) } }); } catch {}
    }
  });

  return server;
}

function diagnosticsText(d) {
  const L = [];
  L.push("FREE-BEST ROUTER");
  L.push("=================");
  L.push(`Current winner: ${d.currentWinner ?? "none"}`);
  L.push(`Success rate: ${d.stats.successRate ?? "n/a"}   requests=${d.stats.requests} fallbacks=${d.stats.fallbacks} 429=${d.stats.rateLimit}`);
  L.push("");
  L.push("Top candidates:");
  d.top10.forEach((t, i) => L.push(`  ${i + 1}. ${t.model.padEnd(48)} ${t.score}`));
  L.push("");
  L.push("Provider health:");
  for (const [p, s] of Object.entries(d.providerHealth)) L.push(`  ${p.padEnd(20)} ${s.state}`);
  L.push("");
  L.push("Catalog freshness:");
  for (const [p, fresh] of Object.entries(d.catalogFresh)) L.push(`  ${p.padEnd(20)} ${fresh ? "FRESH" : "STALE"}`);
  return L.join("\n") + "\n";
}
