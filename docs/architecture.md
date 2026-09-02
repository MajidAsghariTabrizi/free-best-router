# Architecture

This document is the authoritative design specification for Free Best Router. It is intended for contributors who want to modify the engine, the scoring algorithm, or the state machines. If you are an operator who just wants to run the router, see the [README](../README.md) instead.

## High-level pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│  Incoming POST /v1/chat/completions (OpenAI-compatible body)        │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Derive task signature                                           │
│     - hasTools      (body.tools non-empty OR msg.tool_calls present) │
│     - hasImages     (msg.content has image_url/image part)          │
│     - hasStructured (body.response_format set)                      │
│     - largeContext  (estimated input tokens > 30,000)               │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Engine.select(task) → ranked + chosen candidate                 │
│     - hardEligible filters (free, healthy, capability ≥ thresholds) │
│     - score() ranks by capability × reliability × latency           │
│     - 5% exploration rate (configurable) probes a non-incumbent     │
│     - Returns { candidate, ranked, explored, why }                  │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Adapter.execute() → upstream call with per-attempt timeout      │
│     - Streams back if body.stream=true                              │
│     - Captures finish_reason, tool_calls, usage                     │
│     - 404 triggers a forced catalog refresh for that provider       │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. Engine.recordOutcome() → updates health + runtime stats         │
│     - success: reset all consecutive counters                       │
│     - failure: increment type-specific counter, recompute cooldown  │
│     - time-decay penalty applied on next ranking pass              │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ on failure
┌─────────────────────────────────────────────────────────────────────┐
│  5. Fallback: next best candidate (max maxDepth attempts)           │
│     - Excludes already-tried models                                 │
│     - 4 attempts × 45s default = bounded 180s wall time per request │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ all attempts failed
┌─────────────────────────────────────────────────────────────────────┐
│  6. Bounded failure:                                                │
│     - 502 with Retry-After + next_eligible_model                    │
│     - OR 429 if all candidates are rate-limited at this instant     │
└─────────────────────────────────────────────────────────────────────┘
```

## The `FreeRouter` class

The engine lives in `src/engine.mjs`. It is intentionally pure logic — it does no I/O itself. All HTTP calls happen through the adapter instances passed into the constructor.

```js
new FreeRouter({
  config:    { ... },   // routing, health, strategy, fallback, ...
  adapters:  [ ... ],   // ProviderAdapter instances
  clock:     () => Date.now(),  // injected for tests
  rng:       Math.random,       // injected for tests
  logger:    (ev, extra) => ... // structured event log
})
```

The class exposes four primary operations:

| Method                | Purpose                                                       |
|-----------------------|---------------------------------------------------------------|
| `refreshCatalogs()`   | Pull model lists from all adapters, normalize, update store.  |
| `select(task, opts)`  | Rank candidates and pick one (with optional exploration).     |
| `recordOutcome()`     | Update health + runtime stats after an attempt.               |
| `diagnostics()`       | Snapshot of current state for `/diagnostics`.                 |

## Model normalization (`src/classify.mjs`)

Every provider returns models in a slightly different shape. The router normalizes everything to a single `Model` record:

```js
{
  id:        "llama-3.3-70b-versatile",
  provider:  "groq",
  displayName: "...",
  pricing:   { input: 0, output: 0 },     // null = unknown
  free:      true,
  capabilities: {
    reasoning: 0..1, coding: 0..1, agentic: 0..1, tools: 0..1,
    structuredOutput: 0..1, vision: 0..1
  },
  finishCompat: 0 or 1,    // hard kill switch (e.g. "complete" finish reason)
  context:    { inputTokens: N, outputTokens: M },
  runtime:    { requests, successes, avgLatencyMs, ...failure counters... },
  health:     { state, cooldownUntil, consecutive429, ... },
  meta:       { ...provider-specific... },
  dataPolicy: { promptRetention, trainingUsage, thirdPartyProvider }
}
```

The capability values are resolved in priority order:
1. Explicit `capabilities` field on the raw model entry (caller-supplied, trusted)
2. Curated override table in `OVERRIDES` (for known model ids)
3. Pattern-based inference (`inferCapabilities`) for unknown ids

The `inferCapabilities` function uses regex patterns on the model id and display name to estimate capabilities. New providers and new model families automatically get reasonable default scores without a code change.

## Scoring

```text
total = capability_fit    * 0.25
      + agentic_quality   * 0.20
      + reliability       * 0.20
      + coding_quality    * 0.15
      + context_fit       * 0.08
      + tool_quality      * 0.07
      + latency           * 0.05

  - decay_penalty(rate_limit,    last429At, weight 0.15, halflife 10m)
  - decay_penalty(timeout,       lastTimeoutAt, weight 0.10, halflife 5m)
  - decay_penalty(server_error,  last5xxAt, weight 0.12, halflife 5m)
  - decay_penalty(tool_failure,  lastToolFailAt, weight 0.05, halflife 5m)
  - decay_penalty(structured,    lastStructFailAt, weight 0.05, halflife 5m)
  - decay_penalty(finish_error,  lastFinishErrAt, weight 0.10, halflife 5m)
```

Where:

- `capability_fit = stealthSimilarity(model)` — a weighted sum over all capability axes (see `STEALTH_WEIGHTS`).
- `agentic_quality = 0.6 * agentic + 0.4 * reasoning`.
- `reliability` is confidence-adjusted:
  - 0 requests → `0.5` (prior).
  - `< minSamples` requests → Bayesian shrinkage toward `0.5`.
  - `≥ minSamples` requests → Wilson lower bound (95% CI).
  - Multiplied by `providerMultiplier` (`1.0` healthy, `0.5` degraded, `0` cooldown/unavailable).
  - Multiplied by `finishCompat` (hard kill switch per model id).
- `context_fit = min(1, inputTokens / need)` where `need = 128k` if `task.largeContext` else `32k`.
- `latency = min(1, 2000 / avgLatencyMs)` (so 2 s latency saturates the score).
- `_decay(weight, lastAt, halflifeMs) = weight * exp(-age / halflife)`. A failure that just happened applies the full penalty; a failure from 10 halflives ago is essentially zero.

Final `total` is clamped to `[0, 1]`.

## Hard eligibility

Before a model is scored, it must pass `hardEligible`:

| Check                                                | Why                                                         |
|------------------------------------------------------|-------------------------------------------------------------|
| `model.free === true`                                | Absolute free-only guarantee.                               |
| `providerMultiplier(provider) !== 0`                 | Skip if the provider is in cooldown.                        |
| `health.state !== "cooldown" || now >= cooldownUntil`| Skip while model is cooling down.                           |
| `health.state !== "unavailable" || now >= cooldownUntil`| Same, for the longer-term "unavailable" state.          |
| For coding tasks: `capabilities.coding >= 0.30`      | A model that can't generate code is useless here.           |
| For tool tasks: `capabilities.tools >= 0.35`         | A model that can't call tools fails any agentic request.    |
| For image tasks: `capabilities.vision >= 0.30`       | A model that can't see images returns garbage on them.      |

When a model's cooldown expires, `hardEligible` is called once to halve the `consecutive*` counters. This is the anti-correlated-burst reset: a single OpenRouter edge-429 storm should not send every probed model to the 8-minute cap.

## Exploration

5% (configurable) of requests are sent to a non-incumbent healthy candidate instead of the top-ranked one. The pool of exploration candidates is filtered:

- `model.free === true` (absolute guard)
- `model.health.state === "healthy"` (never explore something that might fail)
- Within `exploreGap` (default 0.15) of the incumbent's score, **OR** under-sampled (`requests < minSamples`) but capability-close to the incumbent

The pool is capped at `explorePoolMax` (default 4) candidates. A random candidate is picked from the pool.

Exploration is tagged in the request outcome via `outcome.explored = true`. The engine tracks exploration telemetry separately (`exploration.attempts`, `successes`, `failures`) so you can monitor whether exploration is improving the catalog or just adding load.

## Cooldown state machine

```
                ┌──────────┐
                │  healthy │ ◀─────────── success ───────────┐
                └──────────┘                                  │
                     │                                       │
              any failure                                    │
                     │                                       │
                     ▼                                       │
        ┌───────── cooldown ─────────┐                       │
        │ (rate_limit, server_error) │                       │
        └────────────────────────────┘                       │
                     │                                       │
              finish_error × 3                              │
                     │                                       │
                     ▼                                       │
                ┌──────────┐                                 │
                │unavailable│ (model_not_found, client_err)  │
                └──────────┘                                 │
                     │                                       │
                  now >= cooldownUntil                       │
                     │                                       │
                     └───────── halve counters ──────────────┘
```

Cooldown durations are exponential backoff: `cooldownByType[type] * 2^(consecutive-1)`, capped at `maxCooldownSecByType[type]`. For `model_not_found` and `client_error`, the cap is 1 hour — these are signals that the provider removed the model or that the user's account is blocked, neither of which fixes itself in 8 minutes.

## Fallback

When the first attempt fails with a retryable error (`rate_limit`, `timeout`, `transport`, `server_error`, `finish_error`, `model_not_found`, `client_error`), the engine picks the next-best healthy candidate and tries again. Up to `routing.fallback.maxDepth` (default 4) attempts are made per request.

The wall time per request is bounded by `routing.fallback.attemptTimeoutMs` (default 45 s) × `maxDepth` (4) = 180 s. The router never hangs indefinitely.

If all attempts fail, the server returns:

- **HTTP 429** if the last failure was a 429 (upstream rate limit, with `Retry-After` from upstream header if present).
- **HTTP 502** otherwise (router-level `NO_FREE_AGENT_MODEL_AVAILABLE`).
- Both responses include:
  - `Retry-After` header (seconds until soonest-recoverable model)
  - `x-free-router-next-eligible` header (the model that will recover soonest)
  - JSON body with `next_eligible_at`, `next_eligible_model`, `last_error_type`, `attempts`

## HTTP server (`src/server.mjs`)

The server is a thin shell. Its only jobs are:

1. Route the right URL to the right handler.
2. For `POST /v1/chat/completions`:
   - Parse the body (capped at 20 MB)
   - Call `runCompletion` which:
     - Derives the task signature
     - Loops through attempts (`maxDepth`)
     - On each attempt, calls `router.select()` then `adapter.execute()`
     - Streams the upstream response back to the client verbatim
     - Records the outcome
   - On final failure, returns 502/429 with `Retry-After`
3. For `GET /diagnostics`: dump the full engine state as JSON or text.
4. For `POST /_refresh`: force a catalog refresh from all providers.

The server preserves the actual upstream `model` field (not `free-best`) in the response body so DSH/pi-ai captures the real picked model into its `responseModel` log. The `x-free-router-model` header is the canonical source of truth.

## Provider interface

Every provider adapter implements:

```js
{
  id:           string,           // unique id, e.g. "openrouter"
  displayName:  string,
  dataPolicy:   { promptRetention, trainingUsage, thirdPartyProvider },

  configured(): boolean,          // has the operator enabled this provider?
  isProxied():  boolean,          // does this adapter use a ProxyAgent?
  installHint?: string,           // for NOT_CONFIGURED providers

  async discoverModels(): Promise<RawModel[]>,  // fetch catalog, normalize
  async healthCheck():   Promise<{ reachable: boolean }>,

  async execute({ model, body, signal }): Promise<{ ok, status, headers, text, body }>,
                                        // single POST /chat/completions
}
```

See [`docs/providers.md`](providers.md) for the full guide to adding a new provider.

## Privacy properties

- The router does not log `Authorization` headers, request bodies, or response bodies.
- `/diagnostics` exposes the `providerHealth` map (states, not keys) and the model health map. No credentials.
- The router has no persistent state in v0.1.0 — every restart begins from zero.
- The router has no outbound network calls except to the configured provider `baseUrl`s.

## Future work (v0.2+)

- **Persistent state** via `serialize()` / `deserialize()` to a JSON file. Survive restarts.
- **Smarter capability inference** that uses observed success rate on real prompts, not just pattern matching.
- **Tool-calling benchmark** that scores models on actual function-call reliability, not just the `tools` capability flag.
- **Adaptive cooldown** that learns per-provider optimal durations from observed recovery patterns.
- **Optional metrics** in Prometheus format at `/metrics`.
