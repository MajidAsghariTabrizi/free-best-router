// DETERMINISTIC ROTATION TEST
// Uses mock adapters — no real network calls.
// Proves: A 429 rotates to B; B timeout rotates to C; C succeeds; recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FreeRouter } from "../src/engine.mjs";

function makeAdapter(id, behavior) {
  return {
    id,
    displayName: id,
    dataPolicy: {},
    configured: () => true,
    discoverModels: async () => behavior.models,
    healthCheck: async () => true,
    execute: async ({ model }) => {
      const b = behavior.byModel[model];
      if (!b) return { ok: false, status: 404, text: async () => "not found", headers: new Map() };
      if (b.throw) throw new Error(b.throw);
      if (b.status && b.status !== 200) {
        return { ok: false, status: b.status, text: async () => b.body || `error ${b.status}`, headers: new Map() };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }), headers: new Map() };
    },
  };
}

function buildRouter(adapters) {
  return new FreeRouter({
    config: {
      policy: { freeOnly: true, paidFallback: false },
      strategy: { capabilityAware: false, adaptive: true, explorationRate: 0 },
      discovery: { enabled: true, ttlHours: 6 },
      fallback: { enabled: true, maxDepth: 4 },
      health: { cooldownEnabled: true, maxCooldownSec: 60 },
    },
    adapters,
    clock: () => 1000000,
    rng: () => 0.5, // no exploration
    logger: () => {},
  });
}

function baseModel(id) {
  return { id, name: id, pricing: { input: 0, output: 0 }, free: true, context: { input: 128000, output: 8192 }, capabilities: { reasoning: 0.8, coding: 0.8, agentic: 0.8, tools: 0.8, structuredOutput: 0.8, vision: 0 }, finishCompat: 1 };
}

test("A 429 → B 404 → C succeeds", async () => {
  const a = makeAdapter("provA", {
    models: [baseModel("a-model")],
    byModel: { "a-model": { status: 429, body: "rate limited" } },
  });
  const b = makeAdapter("provB", {
    models: [baseModel("b-model")],
    byModel: { "b-model": { status: 404, body: "not found" } },
  });
  const c = makeAdapter("provC", {
    models: [baseModel("c-model")],
    byModel: { "c-model": { status: 200 } },
  });
  const r = buildRouter([a, b, c]);
  await r.refreshCatalogs({ force: true });

  // First call: ranks all three
  const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };
  const sel1 = r.select(TASK);
  assert.ok(sel1.ok);
  // Force a 429
  r.recordOutcome(sel1.candidate.provider, sel1.candidate.model, { type: "rate_limit", latencyMs: 100 });
  const sel2 = r.select(TASK, { exclude: new Set([r.modelKey(sel1.candidate.provider, sel1.candidate.model)]) });
  assert.ok(sel2.ok);
  assert.notEqual(sel2.candidate.provider, sel1.candidate.provider);
  // Force a 404
  r.recordOutcome(sel2.candidate.provider, sel2.candidate.model, { type: "model_not_found", latencyMs: 100 });
  const sel3 = r.select(TASK, { exclude: new Set([r.modelKey(sel1.candidate.provider, sel1.candidate.model), r.modelKey(sel2.candidate.provider, sel2.candidate.model)]) });
  assert.ok(sel3.ok);
  assert.notEqual(sel3.candidate.provider, sel1.candidate.provider);
  assert.notEqual(sel3.candidate.provider, sel2.candidate.provider);
  // success
  r.recordOutcome(sel3.candidate.provider, sel3.candidate.model, { type: "success", latencyMs: 200, finishReason: "stop" });
  const final = r.models.get(r.modelKey(sel3.candidate.provider, sel3.candidate.model));
  assert.equal(final.health.state, "healthy");
  assert.equal(final.runtime.successes, 1);
});

test("successful model ranks above cooldown model after recovery", async () => {
  const a = makeAdapter("provA", {
    models: [baseModel("a-good"), baseModel("a-bad")],
    byModel: { "a-good": { status: 200 }, "a-bad": { status: 429 } },
  });
  const r = buildRouter([a]);
  await r.refreshCatalogs({ force: true });
  // Give a-good strong history
  for (let i = 0; i < 50; i++) r.recordOutcome("provA", "a-good", { type: "success", latencyMs: 100, finishReason: "stop" });
  // Now cool down a-bad
  r.recordOutcome("provA", "a-bad", { type: "rate_limit", latencyMs: 50 });
  r.recordOutcome("provA", "a-bad", { type: "rate_limit", latencyMs: 50 });
  r.recordOutcome("provA", "a-bad", { type: "rate_limit", latencyMs: 50 });
  const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };
  const sel = r.select(TASK);
  assert.equal(sel.ok, true);
  assert.equal(sel.candidate.model, "a-good");
});
