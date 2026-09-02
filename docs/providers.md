# Adding a provider

Free Best Router's provider system is modular. Every provider is a single file in `providers/` that implements a small interface. Adding a new provider is a 30-line PR if the provider is OpenAI-compatible, or 100–200 lines if it has a non-standard API.

## The adapter contract

Every provider adapter exports a class with the following shape:

```js
export class MyProviderAdapter {
  // Optional: receive config from the constructor.
  constructor({ key, baseUrl, proxyUrl, ...customOptions } = {}) { ... }

  // Return the unique provider id used in `providerHealth` and model keys.
  // This MUST match the `id` field in the catalog entries returned by discoverModels.
  get id() { return "myprovider"; }

  // Display name for diagnostics.
  get displayName() { return "My Provider"; }

  // Data policy for transparency. Affects nothing in the routing decision; just
  // surfaced in /diagnostics and the model record.
  get dataPolicy() {
    return { promptRetention: "retained", trainingUsage: "unknown", thirdPartyProvider: true };
  }

  // Does this provider have the credentials + local install it needs to work?
  // If false, the provider is marked NOT_CONFIGURED and excluded from routing.
  configured() { return !!this.key; }

  // Does this adapter route through an HTTP proxy? (For diagnostics only.)
  isProxied() { return !!this.proxyUrl; }

  // Fetch the full model catalog. Each entry is a "raw model":
  //   { id, name?, pricing?, context?, free?, meta?, capabilities? }
  // The router normalizes these into internal records.
  async discoverModels() { ... }

  // Liveness check. Returns { reachable: boolean }.
  async healthCheck() { ... }

  // Execute one chat completion. The router passes the `model` id (no provider
  // prefix — the adapter already knows its own provider), the request body
  // (which may include `stream: true`), and an AbortSignal for cancellation.
  // Returns a fetch-like Response: { ok, status, headers, body?, text? }.
  async execute({ model, body, signal }) { ... }
}
```

## Case 1: provider is OpenAI-compatible (most common)

If the provider exposes:

- `GET {baseUrl}/models` → `{ data: [{id, ...}] }`
- `POST {baseUrl}/chat/completions` with `Authorization: Bearer <key>`

…then you can extend `OpenAICompatibleAdapter` in one short file.

```js
// providers/myprovider.mjs
import { OpenAICompatibleAdapter } from "./openai-compatible.mjs";

export class MyProviderAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "https://api.myprovider.com/v1" } = {}) {
    super({
      id: "myprovider",
      displayName: "My Provider",
      key, baseUrl,
      // Decide which models are "free". Common options:
      //   (a) Per-token pricing == 0 (OpenRouter-style)
      //   (b) Known allowlist (Groq / Cerebras / Mistral)
      //   (c) Meta tag (some providers expose `meta.tier === "free"`)
      freeMatcher: (m) => Number(m.pricing?.prompt ?? 1) === 0
                        && Number(m.pricing?.completion ?? 1) === 0,
      dataPolicy: { promptRetention: "retained", trainingUsage: "unknown", thirdPartyProvider: true },
      defaultContextInput: 128000,
      defaultContextOutput: 8192,
    });
  }
}
```

Then:

1. Add the export to `providers/index.mjs`.
2. Wire it in `src/index.mjs`:
   ```js
   new MyProviderAdapter({ key: creds.MYPROVIDER_API_KEY, baseUrl: config.providers?.myprovider?.baseUrl || "https://api.myprovider.com/v1" }),
   ```
3. Add an entry to `config.json`:
   ```json
   "myprovider": { "enabled": true, "baseUrl": "https://api.myprovider.com/v1", "apiKeyEnv": "MYPROVIDER_API_KEY" }
   ```
4. Add the env var to `.env.example` and document it in the README.
5. Add a test in `test/myprovider.test.mjs`.

## Case 2: provider has a non-standard API

If the provider doesn't follow the OpenAI contract (e.g. Anthropic's Messages API, Google's generateContent, Cohere's v2 chat), implement the full interface yourself. Look at `providers/deepseek.mjs` for an example that overrides `discoverModels` to supply known paid models.

```js
// providers/anthropic.mjs
import { Agent, fetch as undiciFetch } from "undici";

export class AnthropicAdapter {
  constructor({ key, baseUrl = "https://api.anthropic.com/v1" } = {}) {
    this.id = "anthropic";
    this.displayName = "Anthropic";
    this.key = key;
    this.baseUrl = baseUrl;
    this.dispatcher = new Agent();
    this.dataPolicy = { promptRetention: "retained", trainingUsage: "disallowed", thirdPartyProvider: false };
  }
  isProxied() { return false; }
  configured() { return !!this.key; }

  async discoverModels() {
    // /v1/models is a non-standard shape on Anthropic. Hardcode or scrape.
    return [
      { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", pricing: { input: 3, output: 15 }, context: { input: 200000, output: 8192 }, free: false },
      ...
    ];
  }

  async healthCheck() {
    try {
      const r = await undiciFetch(this.baseUrl + "/models", { headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01" }, dispatcher: this.dispatcher });
      return { reachable: r.ok };
    } catch { return { reachable: false }; }
  }

  async execute({ model, body, signal }) {
    // Translate OpenAI-shape `body` to Anthropic's Messages shape.
    const anthropicBody = {
      model,
      max_tokens: body.max_tokens || 4096,
      messages: body.messages.filter(m => m.role !== "system"),
      system: body.messages.find(m => m.role === "system")?.content,
    };
    return undiciFetch(this.baseUrl + "/messages", {
      method: "POST",
      headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(anthropicBody),
      signal,
      dispatcher: this.dispatcher,
    });
  }
}
```

## Known free model allowlists

Some providers don't publish per-token pricing for free-tier models (Groq, Cerebras, Mistral). The router uses a hardcoded `Set` of known free model ids in those adapters:

```js
// providers/groq.mjs
const GROQ_FREE_IDS = new Set([
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "llama-3.3-70b-specdec",
  "meta-llama/llama-3.1-8b-instant",
  "meta-llama/llama-3.3-70b-versatile",
  "meta-llama/llama-3.3-70b-specdec",
]);
```

**Good first contribution**: add a newly-discovered free model id to one of these sets. Verify it works by checking that the model appears in `/diagnostics` and can be selected.

## Local providers (Ollama, LM Studio, llama.cpp)

`providers/local.mjs` auto-discovers local inference servers on well-known ports (11434, 1234, 8080, 8081). To add a custom port or a custom kind, edit the `checks` array in `discoverLocalEndpoints()` in `src/index.mjs`.

## Per-provider HTTP proxy

If a provider's public IP is Cloudflare-blocked from your host, you can route just that provider through an HTTP proxy:

```env
GROQ_PROXY_URL=http://user:pass@proxy.example.com:8080
```

Or set `HTTPS_PROXY` to apply it to all providers. Only HTTP proxies are supported (no SOCKS — undici's `ProxyAgent` doesn't support SOCKS). For SOCKS, see [`socks5-proxy-agent`](https://www.npmjs.com/package/socks5-proxy-agent) and fork the adapter.

## Testing your adapter

Write at least these tests:

1. **discoverModels**: feed canned `/models` response data, assert the normalized records.
2. **freeMatcher**: a known free model returns `true`, a known paid model returns `false`.
3. **configured()**: missing key returns `false`, present key returns `true`.
4. **execute()** (with mock `fetch`): the correct URL, headers, and body are sent.

For a working example, see `test/multi-provider.test.mjs` which uses mock adapters to exercise the engine without making real HTTP calls.

## Submission checklist

Before opening a PR for a new provider:

- [ ] Adapter class lives in `providers/<name>.mjs`.
- [ ] Exported from `providers/index.mjs`.
- [ ] Wired in `src/index.mjs`.
- [ ] Entry in `config.json`.
- [ ] Env var in `.env.example`.
- [ ] Section in the README's "Supported providers" table.
- [ ] Test in `test/<name>.test.mjs` covering discover / matcher / configured.
- [ ] `npm test` passes.
- [ ] If the provider has a non-standard API, add a curl example in `examples/curl/`.
