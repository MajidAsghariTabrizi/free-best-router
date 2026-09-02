// providers/cerebras.mjs — Cerebras Inference (https://cloud.cerebras.ai).
// Free monthly token grant, no credit card required. Known free model ids
// maintained as a constant. Cerebras inference is extremely low latency.
import { OpenAICompatibleAdapter } from "./openai-compatible.mjs";

const CEREBRAS_FREE_IDS = new Set([
  "llama-3.3-70b",
  "llama-3.1-8b",
  "qwen-2.5-32b",
  "qwen-2.5-coder-32b",
  "llama3.1-8b",
  "llama3.3-70b",
]);

export class CerebrasAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://api.cerebras.ai/v1", proxyUrl = null } = {}) {
    super({
      id: "cerebras",
      displayName: "Cerebras Inference (Free Tier)",
      key, baseUrl, proxyUrl,
      freeMatcher: (m) => CEREBRAS_FREE_IDS.has(m.id) || (m.meta && m.meta.tier === "free"),
      dataPolicy: { promptRetention: "retained", trainingUsage: "disallowed", thirdPartyProvider: true },
      defaultContextInput: 128000, defaultContextOutput: 8192,
    });
  }
}
