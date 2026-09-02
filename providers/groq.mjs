// providers/groq.mjs — Groq Cloud (https://console.groq.com).
// Free tier, no credit card, OpenAI-compatible API. Known free model ids are
// maintained as a constant — Groq does not publish a per-model "is_free" field.
import { OpenAICompatibleAdapter } from "./openai-compatible.mjs";

const GROQ_FREE_IDS = new Set([
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "llama-3.3-70b-specdec",
  "meta-llama/llama-3.1-8b-instant",
  "meta-llama/llama-3.3-70b-versatile",
  "meta-llama/llama-3.3-70b-specdec",
]);

export class GroqAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://api.groq.com/openai/v1", proxyUrl = null } = {}) {
    super({
      id: "groq",
      displayName: "Groq Cloud (Free Tier)",
      key, baseUrl, proxyUrl,
      freeMatcher: (m) => GROQ_FREE_IDS.has(m.id) || (m.meta && m.meta.tier === "free"),
      dataPolicy: { promptRetention: "retained", trainingUsage: "disallowed", thirdPartyProvider: true },
      defaultContextInput: 128000, defaultContextOutput: 8192,
    });
  }
}
