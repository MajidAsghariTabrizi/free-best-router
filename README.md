# Free Best Router

> One OpenAI-compatible endpoint that automatically finds and routes requests to the best available free AI model.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](test/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

```text
Your App
   ↓
Free Best Router
   ↓
┌───────────────┬───────────────┬───────────────┐
│ OpenRouter    │ OpenCode/Zen  │ Other Free    │
│ Free Models   │ Free Models   │ Providers     │
└───────────────┴───────────────┴───────────────┘
```

## What is it?

**Free Best Router** is an open-source, self-hosted, OpenAI-compatible intelligent router for free AI models. You point it at the free tiers of providers you have API keys for (or leave it running with no keys at all and it will use providers that don't require authentication), and it automatically:

1. **Discovers** every free model offered by each provider
2. **Normalizes** the catalogs (different providers describe models differently)
3. **Health-checks** each model with a warm-up probe at startup
4. **Scores** every model on capability, reliability, latency, and context fit
5. **Ranks** the catalog best-first
6. **Routes** every incoming request to the best currently-healthy model
7. **Falls over** when the best model rate-limits, timeouts, or returns a finish error
8. **Cooldown-cools** unhealthy routes so the same failure doesn't repeat
9. **Explores** under-sampled candidates periodically so the winner doesn't ossify

Your application sees a single OpenAI-compatible endpoint that always returns the best answer it can from free models — no per-provider configuration, no manual failover logic, no surprise rate limits.

## Why?

Free AI models are amazing and they are a mess. They are:

- **Unreliable** — free-tier inference queues stall for 30–120 seconds
- **Rate limited** — aggressive per-minute limits that change without notice
- **Frequently unavailable** — models cycle in and out of 429/404/transport-error states hour by hour
- **Spread across many providers** — OpenRouter, OpenCode/Zen, Groq, Cerebras, Mistral, DeepSeek, local Ollama, and more
- **Constantly changing** — new free models appear weekly; old ones disappear
- **Difficult to compare** — every provider exposes different capability metadata
- **Difficult to integrate** — each provider has a slightly different API contract
- **Difficult to configure manually** — keeping a working free model list is a full-time job

**Free Best Router** turns this mess into one stable endpoint.

## Features

- ✅ **OpenAI-compatible** — drop-in for any `openai-python` / `openai-node` client
- ✅ **Multi-provider** — OpenRouter, OpenCode/Zen, Groq, Cerebras, Mistral, DeepSeek, local Ollama/LM Studio
- ✅ **Auto-discovery** — every provider's model catalog is fetched at startup
- ✅ **Free-only by default** — paid models are excluded unless you opt in
- ✅ **Capability-aware ranking** — coding, reasoning, tool-calling, vision, long-context
- ✅ **Runtime learning** — Wilson lower bound on success rate, time-decay penalties
- ✅ **Smart exploration** — periodically probes under-sampled healthy candidates
- ✅ **Automatic fallback** — up to 4 model attempts per request, bounded wall time
- ✅ **Per-failure-type cooldowns** — exponential backoff with per-type caps (1h for 404, 8m for 429)
- ✅ **Bounded failure** — returns 502/429 + `Retry-After` + `next_eligible_model` when pool is empty
- ✅ **Streaming** — full SSE passthrough, finish_reason + tool_calls captured
- ✅ **DeepSeek Harness integration** — drop-in OpenAI-compatible provider config
- ✅ **Self-hosted & privacy-first** — your provider keys never leave your machine
- ✅ **Zero telemetry** — the router does not phone home

## Quick start (60 seconds)

```bash
# 1. Install
git clone https://github.com/MajidAsghariTabrizi/free-best-router.git
cd free-best-router
npm install

# 2. (Optional) Add provider keys — the router works without any keys, but having
#    at least one OpenRouter key dramatically improves the free model pool.
cp .env.example .env
# edit .env and set at least OPENROUTER_API_KEY=<your-key-here>

# 3. Start
npm start
```

That's it. You now have a running OpenAI-compatible router on `http://127.0.0.1:4098/v1`.

```bash
# Health check
curl http://127.0.0.1:4098/health
# → {"status":"ok","route":"free-best"}

# List models (always returns the single route)
curl http://127.0.0.1:4098/v1/models
# → {"object":"list","data":[{"id":"free-best","object":"model","owned_by":"free-router"}]}

# Live chat completion
curl -X POST http://127.0.0.1:4098/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-best",
    "messages": [{"role":"user","content":"Reply with OK"}],
    "max_tokens": 8
  }'
```

> The router picks a different model every time you ask — that's the point. See `x-free-router-model` in the response headers to see which one it picked.

## DeepSeek Harness

Free Best Router integrates with [DeepSeek Harness](https://github.com) as a first-class OpenAI-compatible provider. Add this to your DSH `settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    free-router:
      displayName: Free Best Router
      api: openai-completions
      baseURL: http://127.0.0.1:4098/v1
      apiKeyEnv: FREE_ROUTER_API_KEY
      models:
        - id: free-best
```

DSH will treat the router exactly like any other OpenAI-compatible provider. Set `FREE_ROUTER_API_KEY=any-value` in DSH's environment (the router doesn't validate the inbound bearer — it uses its own provider keys from `.env`). The actual model picked by the router is recorded in `x-free-router-model` response headers and is preserved in the upstream response's `model` field, so DSH's `responseModel` is the real model id.

See [`examples/deepseek-harness/settings.yaml`](examples/deepseek-harness/settings.yaml) for a complete example.

## OpenAI-compatible API

### Endpoints

| Method | Path                     | Purpose                                                                 |
|--------|--------------------------|-------------------------------------------------------------------------|
| `GET`  | `/health`                | Liveness probe. Returns `{"status":"ok","route":"free-best"}`.          |
| `GET`  | `/v1/models`             | OpenAI-compatible model list. Returns the single `free-best` route.     |
| `POST` | `/v1/chat/completions`   | OpenAI-compatible chat completion. Streams when `stream: true`.         |
| `GET`  | `/diagnostics`           | Current winner, top 10, provider/model health, stats. JSON or text.     |
| `POST` | `/_refresh`              | Force a catalog refresh from all providers.                             |

### Response headers (every completion)

| Header                       | Meaning                                                                                  |
|------------------------------|------------------------------------------------------------------------------------------|
| `x-free-router-model`        | The actual `provider/model` id that was selected (e.g. `openrouter/llama-3.3-70b:free`). |
| `x-free-router-route`        | The route you asked for (always `free-best` for this router).                             |
| `x-free-router-explored`     | `true` if this request was sent to a non-incumbent candidate as exploration.             |
| `x-free-router-next-eligible`| On 502/429: the model id that will recover soonest.                                       |
| `Retry-After`                | On 502/429: seconds until at least one candidate is healthy again.                        |

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4098/v1",
    api_key="any-value-not-validated",
)

response = client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "What is the capital of France?"}],
)

print(response.choices[0].message.content)
print("picked model:", response._raw_response.headers.get("x-free-router-model"))
```

### JavaScript / TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:4098/v1",
  apiKey: "any-value-not-validated",
});

const response = await client.chat.completions.create({
  model: "free-best",
  messages: [{ role: "user", content: "What is the capital of France?" }],
});

console.log(response.choices[0].message.content);
```

### Streaming

```python
stream = client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "Write a haiku"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Supported providers

| Provider            | Free tier            | Auth required | Notes                                            |
|---------------------|----------------------|---------------|--------------------------------------------------|
| **OpenRouter**      | Many `:free` models  | Yes (free key) | Primary source of free frontier-class models.    |
| **OpenCode / Zen**  | Several `-free` ids  | Yes (free key) | Local install required (proxy on `127.0.0.1:4097`). |
| **Groq**            | Llama 3.1/3.3 free   | Yes (free key) | Very low latency.                                |
| **Cerebras**        | Llama / Qwen free    | Yes (free key) | Wafer-scale silicon, very low latency.           |
| **Mistral**         | Small/Nemo/Codestral | Yes (free key) | European provider.                               |
| **DeepSeek**        | (Paid)               | Yes (paid key) | Wired but excluded by free-only policy.          |
| **Local (Ollama / LM Studio / llama.cpp)** | Whatever you serve | No            | Auto-discovered on well-known local ports. |

Adding a new OpenAI-compatible provider is a 30-line file in `providers/`. See [`docs/providers.md`](docs/providers.md).

## Routing algorithm

```
DISCOVER → NORMALIZE → FREE FILTER → CAPABILITY FILTER → HEALTH FILTER
        → QUALITY RANK → TASK RANK → SELECT → ATTEMPT → RECORD OUTCOME
                                                  ↓ on failure
                                              FALLBACK (next candidate)
                                                  ↓ all candidates bad
                                          502 + Retry-After
```

### Total score (mission #11)

```
total = capability_fit*0.25 + agentic_quality*0.20 + reliability*0.20
      + coding_quality*0.15 + context_fit*0.08 + tool_quality*0.07 + latency*0.05
```

Hard requirements (must all pass): `free`, provider reachable, `code_generation`, `tool_calling`; `vision` when images are present; `long_context` for repo-wide tasks. Exploration is 5% (configurable) — 5% of requests go to a non-incumbent top-half candidate that still satisfies all hard requirements.

See [`docs/architecture.md`](docs/architecture.md) for the full design.

## Configuration

All runtime configuration lives in [`config.json`](config.json). The defaults are sane for most users. Common tweaks:

| Knob                              | Default | What it does                                                            |
|-----------------------------------|---------|-------------------------------------------------------------------------|
| `routing.strategy.explorationRate`| `0.05`  | Fraction of requests that probe a non-incumbent candidate.              |
| `routing.fallback.maxDepth`       | `4`     | Maximum model attempts per request.                                     |
| `routing.fallback.attemptTimeoutMs`| `45000` | Per-attempt wall time. Lower = faster failover, higher = tolerate slow upstreams. |
| `routing.health.warmUpTopN`       | `40`    | Number of top candidates probed at startup.                             |
| `routing.health.maxCooldownSec`   | `480`   | Default cooldown cap. `model_not_found`/`client_error` get 3600.        |
| `server.port`                     | `4098`  | Bind port. Override with `FREE_ROUTER_PORT` env.                        |

## Diagnostics

```bash
curl http://127.0.0.1:4098/diagnostics | jq
```

Returns the current winner, top 10 ranked candidates, every provider's health state, every model's runtime stats, and global counters. Use `Accept: text/plain` for a human-readable dashboard.

## Troubleshooting

**No free models are selected.**
- Check `/diagnostics` for the `providerHealth` map. Providers with no API key set will be `NOT_CONFIGURED`.
- Set at least one key in `.env`: `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, or `OPENCODE_ZEN_API_KEY`.
- Free models without authentication don't exist (every free tier still requires a free account). At least one provider key is required.

**Every request returns 429 / `NO_FREE_AGENT_MODEL_AVAILABLE`.**
- All free candidates are rate-limited or on cooldown. The router returns a `Retry-After` header — wait that long.
- Add more provider keys to widen the pool.
- Lower `routing.strategy.explorationRate` if you want the incumbent to dominate more.

**First request is very slow (5–30s).**
- This is normal for the first call to a free model. The free tier queues inference and cold-loads weights. The router itself is fast.
- Increase your client timeout to 120s+. The router is designed for free-tier latency.

**`Cannot find module '../providers/index.mjs'`**
- You ran the tests from outside the repo root. Run `npm test` from the project root.

**`EADDRINUSE: address already in use :::4098`**
- Another process is on port 4098. Set `FREE_ROUTER_PORT=4099` (or another free port) and start the router.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — full system design, scoring math, state machines
- [`docs/providers.md`](docs/providers.md) — how to add a new provider adapter
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting, security model
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution workflow, dev setup, code style
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Examples

- [`examples/curl/`](examples/curl/) — raw `curl` requests
- [`examples/openai-python/`](examples/openai-python/) — Python `openai` SDK
- [`examples/javascript/`](examples/javascript/) — Node.js `openai` SDK
- [`examples/deepseek-harness/`](examples/deepseek-harness/) — DSH `settings.yaml` + `.env`

## Roadmap

**Implemented (v0.1.0)**
- All features in the Features section above.

**Planned**
- Persistent on-disk state (survive restarts without losing cooldowns)
- Per-provider HTTP proxy support (currently env-only)
- `gpt-oss`, `o3`, `o4` family detector
- Adaptive capability inference (bootstrap → observed)
- Optional Prometheus `/metrics` endpoint

**Ideas (not committed)**
- Hosted version (would be a separate product)
- Community provider registry
- Cost-aware routing across paid tiers
- A/B testing of ranking weights

## Contributing

We welcome provider adapters, ranking experiments, tests, and documentation. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The easiest "good first contribution" is adding a known free model id to the `MISTRAL_FREE_IDS` / `GROQ_FREE_IDS` / `CEREBRAS_FREE_IDS` allowlist in `providers/`.

## Security

Free Best Router is designed to be safe to expose on a trusted local network. It does not validate the inbound `Authorization` header (it uses its own provider keys). If you bind it to a public address, add an authentication proxy in front. See [`SECURITY.md`](SECURITY.md).

## Related Projects

| Project | What it solves |
|---|---|
| [`universal-engineering-agent`](https://github.com/MajidAsghariTabrizi/universal-engineering-agent) | **Engineering-agent operating kernel.** The 9-stage loop any coding agent should perform: inspect → plan → implement → verify → classify → recover → test → generalize. UEA is the *stack* this router sits below. |
| DeepSeek Harness | The agent framework. This router is a drop-in OpenAI-compatible provider block for DSH. |

**UEA = engineering coordination.** **Free Best Router = model routing.** They are siblings.

## License

MIT — see [`LICENSE`](LICENSE).

## Acknowledgements

Inspired by every developer who has ever lost an afternoon to a free-model rate limit.

— Built by [Majid Asghari Tabrizi](https://github.com/MajidAsghariTabrizi)
