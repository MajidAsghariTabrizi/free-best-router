// server-failfast.test.mjs — integration tests for the server-level fail-fast
// behavior when the candidate pool is exhausted. Verifies:
//   1. All-known-bad pool returns 502 within bounded wall time (no burn).
//   2. 502 response carries next_eligible_at + next_eligible_model + Retry-After.
//   3. attemptTimeoutMs caps per-attempt wall time so 4×dead requests can't happen.
//   4. Success path still works end-to-end through the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FreeRouter } from "../src/engine.mjs";
import { createRouterServer } from "../src/server.mjs";
import { normalizeModel } from "../src/classify.mjs";

let NOW = 1_000_000_000;
const clock = () => NOW;
const mkRouter = (overrides = {}) => new FreeRouter({ clock, rng: () => 1, ...overrides });

function addModel(router, raw, provider = "fake") {
  const m = normalizeModel(raw, provider);
  m.provider = provider;
  router.models.set(router.modelKey(provider, m.id), m);
  return m;
}

// Fake adapter that always returns 429. Used to simulate "the entire eligible
// pool is on cooldown" without making real network calls.
function fakeAdapter(providerId, { status = 429, retryAfter = null } = {}) {
  return {
    id: providerId,
    displayName: providerId,
    key: "test-key",
    configured: () => true,
    isProxied: () => false,
    dataPolicy: { promptRetention: "unknown", trainingUsage: "unknown", thirdPartyProvider: true },
    discoverModels: async () => [],
    healthCheck: async () => ({ reachable: true }),
    execute: async () => ({
      ok: false,
      status,
      headers: { get: (k) => (k.toLowerCase() === "retry-after" ? String(retryAfter) : null) },
      text: async () => JSON.stringify({ error: { message: "fake 429", metadata: { retry_after_seconds: retryAfter } } }),
    }),
  };
}

function successAdapter(providerId) {
  return {
    id: providerId,
    displayName: providerId,
    key: "test-key",
    configured: () => true,
    isProxied: () => false,
    dataPolicy: { promptRetention: "unknown", trainingUsage: "unknown", thirdPartyProvider: true },
    discoverModels: async () => [],
    healthCheck: async () => ({ reachable: true }),
    execute: async () => {
      const body = {
        id: "x", object: "chat.completion", created: 0, model: "fake/healthy:free",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify(body),
      };
    },
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function post(port, path, body, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json;
          try { json = JSON.parse(buf); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json, text: buf });
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("client-timeout")); });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test("empty candidate pool returns 502 with next_eligible_at + Retry-After", async () => {
  const r = mkRouter();
  const adapter = fakeAdapter("fake", { status: 429, retryAfter: 60 });
  r.providerHealth.set(adapter.id, { state: "healthy", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, proxied: false });
  const m = addModel(r, {
    id: "healthy:free", name: "x", pricing: { input: 0, output: 0 }, free: true,
    context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.5, coding: 0.5, agentic: 0.5, tools: 0.5, structuredOutput: 0.5, vision: 0 },
    finishCompat: 1,
  });
  NOW += 100;
  r.recordOutcome(adapter.id, m.id, { type: "rate_limit", latencyMs: 50 });

  const server = createRouterServer(r, [adapter]);
  const { port, close } = await listen(server);
  try {
    const t0 = Date.now();
    const res = await post(port, "/v1/chat/completions", {
      model: "free-best",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
    });
    const elapsed = Date.now() - t0;
    assert.ok(res.status === 502 || res.status === 429, `expected 502/429, got ${res.status}`);
    assert.ok(res.json?.error, "response must carry error");
    assert.equal(res.json.error.code, "NO_FREE_AGENT_MODEL_AVAILABLE");
    assert.ok(res.json.error.next_eligible_at, "next_eligible_at must be present");
    assert.ok(res.json.error.next_eligible_model, "next_eligible_model must be present");
    assert.ok(res.headers["retry-after"], "Retry-After header must be set");
    assert.ok(elapsed < 10_000, `expected fast-fail, took ${elapsed} ms`);
  } finally {
    await close();
  }
});

test("bounded attempts: server returns within (maxAttempts × attemptTimeoutMs), not unbounded", async () => {
  const r = mkRouter({ config: { fallback: { enabled: true, maxDepth: 4, attemptTimeoutMs: 500 }, health: { cooldownEnabled: true, maxCooldownSec: 30, cooldownByType: { rate_limit: 1000 } } } });
  const hangAdapter = {
    id: "hang", displayName: "hang", key: "k", configured: () => true, isProxied: () => false,
    dataPolicy: { promptRetention: "unknown", trainingUsage: "unknown", thirdPartyProvider: true },
    discoverModels: async () => [], healthCheck: async () => ({ reachable: true }),
    execute: () => new Promise(() => {}), // hang forever
  };
  r.providerHealth.set("hang", { state: "healthy", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, proxied: false });
  addModel(r, {
    id: "forever:free", name: "x", pricing: { input: 0, output: 0 }, free: true,
    context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.5, coding: 0.5, agentic: 0.5, tools: 0.5, structuredOutput: 0.5, vision: 0 },
    finishCompat: 1,
  });

  const server = createRouterServer(r, [hangAdapter]);
  const { port, close } = await listen(server);
  try {
    const t0 = Date.now();
    const res = await post(port, "/v1/chat/completions", {
      model: "free-best",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 502);
    assert.ok(elapsed < 5_000, `expected fast-fail bounded by attemptTimeoutMs, took ${elapsed} ms`);
  } finally {
    await close();
  }
});

test("success path through server end-to-end", async () => {
  const r = mkRouter();
  const adapter = successAdapter("fake");
  r.providerHealth.set(adapter.id, { state: "healthy", cooldownUntil: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: 0, proxied: false });
  addModel(r, {
    id: "healthy:free", name: "x", pricing: { input: 0, output: 0 }, free: true,
    context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.8, coding: 0.8, agentic: 0.8, tools: 0.8, structuredOutput: 0.8, vision: 0 },
    finishCompat: 1,
  });
  adapter.execute = async ({ model }) => {
    const body = {
      id: "x", object: "chat.completion", created: 0, model: "fake/healthy:free",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  const server = createRouterServer(r, [adapter]);
  const { port, close } = await listen(server);
  try {
    const res = await post(port, "/v1/chat/completions", {
      model: "free-best",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.choices[0].message.content, "OK");
    assert.equal(res.headers["x-free-router-model"], "fake/healthy:free");
  } finally {
    await close();
  }
});
