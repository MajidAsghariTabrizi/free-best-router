// providers/openrouter.mjs — OpenRouter (https://openrouter.ai).
// OpenRouter exposes `pricing.prompt` and `pricing.completion` as numeric strings
// in USD per token. A model is free iff both are "0". Includes 3rd-party models.
import { OpenAICompatibleAdapter } from "./openai-compatible.mjs";

export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://openrouter.ai/api/v1" } = {}) {
    super({
      id: "openrouter",
      displayName: "OpenRouter",
      key, baseUrl,
      // OpenRouter is intentionally NOT proxied by default — it works direct
      // and a proxy would add latency without benefit. The base class uses
      // the default Agent (no proxy) when `proxyUrl` is not passed.
      freeMatcher: (m) => Number(m.pricing?.prompt ?? 1) === 0 && Number(m.pricing?.completion ?? 1) === 0,
      dataPolicy: { promptRetention: "provider-dependent", trainingUsage: "provider-dependent", thirdPartyProvider: true },
    });
  }
}
