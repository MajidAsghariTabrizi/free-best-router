// providers/deepseek.mjs — DeepSeek (https://api.deepseek.com).
// DeepSeek is paid; the freeMatcher is strict, so no model will be marked free.
// Kept as a wired adapter for operators who want a non-free route, but the
// router's default free-only policy excludes all of its models.
import { OpenAICompatibleAdapter, httpJson } from "./openai-compatible.mjs";

export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://api.deepseek.com/v1" } = {}) {
    super({
      id: "deepseek",
      displayName: "DeepSeek Direct",
      key, baseUrl,
      freeMatcher: () => false,
      dataPolicy: { promptRetention: "retained", trainingUsage: "unknown", thirdPartyProvider: false },
    });
  }
  async discoverModels() {
    // DeepSeek /models returns ids without pricing; supply the known paid models.
    try {
      const r = await httpJson(this.baseUrl + "/models", { Authorization: "Bearer " + this.key }, null, 8000);
      if (r.ok && r.json?.data) {
        return r.json.data.map((m) => ({
          id: m.id, name: m.id, pricing: { input: null, output: null }, context: { input: 128000, output: 8192 }, free: false,
        }));
      }
    } catch {}
    return [
      { id: "deepseek-chat", name: "DeepSeek Chat", pricing: { input: 0.27, output: 1.10 }, context: { input: 128000, output: 8192 }, free: false },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", pricing: { input: 0.55, output: 2.19 }, context: { input: 128000, output: 65536 }, free: false },
    ];
  }
}
