// providers/index.mjs — barrel export for all built-in provider adapters.
// New providers can be added here or imported directly from their module.
export { OpenAICompatibleAdapter } from "./openai-compatible.mjs";
export { OpenRouterAdapter } from "./openrouter.mjs";
export { OpenCodeAdapter } from "./opencode.mjs";
export { DeepSeekAdapter } from "./deepseek.mjs";
export { GroqAdapter } from "./groq.mjs";
export { CerebrasAdapter } from "./cerebras.mjs";
export { MistralAdapter } from "./mistral.mjs";
export { LocalAdapter } from "./local.mjs";
