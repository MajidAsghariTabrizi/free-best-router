// providers/mistral.mjs — Mistral La Plateforme (https://console.mistral.ai).
// Free experimental models, no credit card required. Known free model ids
// maintained as a constant.
import { OpenAICompatibleAdapter } from "./openai-compatible.mjs";

const MISTRAL_FREE_IDS = new Set([
  "mistral-small-latest",
  "mistral-nemo",
  "codestral-mamba-latest",
  "open-mistral-7b",
  "open-mixtral-8x7b",
  "open-mixtral-8x22b",
]);

export class MistralAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://api.mistral.ai/v1", proxyUrl = null } = {}) {
    super({
      id: "mistral",
      displayName: "Mistral La Plateforme (Free Tier)",
      key, baseUrl, proxyUrl,
      freeMatcher: (m) => MISTRAL_FREE_IDS.has(m.id) || (m.meta && m.meta.tier === "free"),
      dataPolicy: { promptRetention: "retained", trainingUsage: "unknown", thirdPartyProvider: false },
      defaultContextInput: 32000, defaultContextOutput: 8192,
    });
  }
}
