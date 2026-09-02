// providers/local.mjs — Local inference servers (Ollama / LM Studio / llama.cpp).
// Active only when a server is reachable on a well-known local port.
import { httpJson } from "./openai-compatible.mjs";

export class LocalAdapter {
  constructor({ endpoints = [] } = {}) {
    this.id = "local";
    this.displayName = "Local Models";
    this.endpoints = endpoints;
    this.dataPolicy = { promptRetention: "none", trainingUsage: "none", thirdPartyProvider: false };
  }
  configured() { return this.endpoints.length > 0; }
  async discoverModels() {
    const out = [];
    for (const ep of this.endpoints) {
      try {
        if (ep.kind === "ollama") {
          const r = await httpJson(ep.url + "/api/tags", {}, null, 5000);
          for (const m of r.json?.models || []) {
            out.push({ id: m.name, name: m.name, pricing: { input: 0, output: 0 }, free: true, context: { input: 32768, output: 4096 }, meta: { local: true } });
          }
        } else {
          const r = await httpJson(ep.url + "/v1/models", {}, null, 5000);
          for (const m of r.json?.data || []) {
            out.push({ id: m.id, name: m.id, pricing: { input: 0, output: 0 }, free: true, context: { input: 32768, output: 4096 }, meta: { local: true } });
          }
        }
      } catch {}
    }
    return out;
  }
  async healthCheck() { return { reachable: this.endpoints.length > 0 }; }
  async execute({ model, body, signal }) {
    // route to the first endpoint; callers may refine per model later
    const ep = this.endpoints[0];
    const url = ep.url + "/v1/chat/completions";
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal, body: JSON.stringify({ ...body, model }) });
  }
}
