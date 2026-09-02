// exhaustion-recovery.test.mjs — regression tests for the 502/429 exhaustion pattern
// when all candidates are in cooldown simultaneously.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel } from "../src/classify.mjs";
import { FreeRouter } from "../src/engine.mjs";

let NOW = 1_000_000_000;
const clock = () => NOW;
const mkRouter = (overrides = {}) => new FreeRouter({ clock, rng: () => 1, ...overrides });

function addModel(router, raw, provider = "openrouter") {
  const m = normalizeModel(raw, provider);
  router.models.set(router.modelKey(provider, m.id), m);
  return m;
}

function freeModel(id, caps = { reasoning: 0.5, coding: 0.6, agentic: 0.5, tools: 0.6, structuredOutput: 0.5, vision: 0 }, ctx = 128000) {
  return { id, name: id, pricing: { input: 0, output: 0 }, free: true, context: { input: ctx, output: 8192 }, capabilities: caps, finishCompat: 1 };
}

const TASK = { purpose: "coding-agent", hasTools: false, hasImages: false, hasStructured: false, largeContext: false };

test("model_not_found cooldown allows up to 1h (not capped to 8 min)", () => {
  const r = mkRouter();
  const m = addModel(r, freeModel("vendor/x:free"));
  r.recordOutcome("openrouter", "vendor/x:free", { type: "model_not_found", latencyMs: 100 });
  const remaining = m.health.cooldownUntil - NOW;
  assert.equal(remaining, 30 * 60 * 1000, `expected 30 min, got ${remaining} ms`);
});

test("client_error cooldown allows up to 1h (not capped to 8 min)", () => {
  const r = mkRouter();
  const m = addModel(r, freeModel("vendor/y:free"));
  r.recordOutcome("openrouter", "vendor/y:free", { type: "client_error", latencyMs: 100 });
  const remaining = m.health.cooldownUntil - NOW;
  assert.equal(remaining, 30 * 60 * 1000, `expected 30 min, got ${remaining} ms`);
});

test("success resets consecutiveNotFound and consecutiveClientErr", () => {
  const r = mkRouter();
  const m = addModel(r, freeModel("vendor/z:free"));
  r.recordOutcome("openrouter", "vendor/z:free", { type: "model_not_found", latencyMs: 100 });
  assert.equal(m.health.consecutiveNotFound, 1);
  NOW += 2_000_000;
  r.recordOutcome("openrouter", "vendor/z:free", { type: "success", latencyMs: 200, finishReason: "stop" });
  assert.equal(m.health.consecutiveNotFound, 0, "consecutiveNotFound should reset to 0 on success");
  assert.equal(m.health.state, "healthy");
});

test("consecutive429 is halved after cooldown expiry without fresh failure", () => {
  const r = mkRouter();
  const m = addModel(r, freeModel("vendor/q:free"));
  for (let i = 0; i < 4; i++) {
    NOW += 100;
    r.recordOutcome("openrouter", "vendor/q:free", { type: "rate_limit", latencyMs: 100 });
  }
  const burstCooldown = m.health.consecutive429;
  assert.equal(burstCooldown, 4, "consecutive429 should be 4 after burst");

  NOW += 1_000_000;
  const ok = r.hardEligible(m, TASK);
  assert.equal(ok.ok, true);
  assert.ok(m.health.consecutive429 <= 2, `expected halved consecutive429, got ${m.health.consecutive429}`);

  r.recordOutcome("openrouter", "vendor/q:free", { type: "rate_limit", latencyMs: 100 });
  const newCooldownMs = m.health.cooldownUntil - NOW;
  assert.ok(newCooldownMs <= 240_000, `expected cooldown ≤240s after recovery, got ${newCooldownMs} ms`);
  assert.ok(newCooldownMs < 480_000, `must not reach 480s cap, got ${newCooldownMs} ms`);
});

test("select() returns nextEligibleAt + nextEligibleModel when pool is empty", () => {
  const r = mkRouter();
  addModel(r, freeModel("vendor/a:free", { reasoning: 0.7, coding: 0.7, agentic: 0.7, tools: 0.7, structuredOutput: 0.7, vision: 0 }));
  addModel(r, freeModel("vendor/b:free"));
  NOW += 100;
  r.recordOutcome("openrouter", "vendor/a:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/b:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/a:free", { type: "rate_limit", latencyMs: 100 });

  const sel = r.select(TASK);
  assert.equal(sel.ok, false);
  assert.equal(sel.error, "NO_FREE_AGENT_MODEL_AVAILABLE");
  assert.ok(sel.nextEligibleAt, "nextEligibleAt must be set");
  assert.ok(sel.nextEligibleModel, "nextEligibleModel must be set");
  assert.equal(sel.nextEligibleModel, "openrouter/vendor/b:free", `got ${sel.nextEligibleModel}`);
});

test("soonestRecoverable returns null when nothing is in cooldown", () => {
  const r = mkRouter();
  addModel(r, freeModel("vendor/c:free"));
  const result = r.soonestRecoverable(TASK);
  assert.equal(result, null);
});

test("soonestRecoverable returns the model with the earliest cooldown expiry", () => {
  const r = mkRouter();
  addModel(r, freeModel("vendor/a:free"));
  addModel(r, freeModel("vendor/b:free"));
  NOW += 100;
  r.recordOutcome("openrouter", "vendor/a:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/b:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/b:free", { type: "rate_limit", latencyMs: 100 });
  const result = r.soonestRecoverable(TASK);
  assert.ok(result);
  assert.equal(result.model, "openrouter/vendor/a:free");
});

test("soonestRecoverable excludes tried set", () => {
  const r = mkRouter();
  addModel(r, freeModel("vendor/a:free"));
  addModel(r, freeModel("vendor/b:free"));
  NOW += 100;
  r.recordOutcome("openrouter", "vendor/a:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/b:free", { type: "rate_limit", latencyMs: 100 });
  r.recordOutcome("openrouter", "vendor/b:free", { type: "rate_limit", latencyMs: 100 });
  const tried = new Set([r.modelKey("openrouter", "vendor/a:free")]);
  const result = r.soonestRecoverable(TASK, tried);
  assert.equal(result.model, "openrouter/vendor/b:free");
});
