# DeepSeek Harness integration

This example shows the minimum configuration to make Free Best Router available as a model in DeepSeek Harness (DSH).

## Prerequisites

- A working DSH install (see the DSH project for setup).
- A working Free Best Router on `http://127.0.0.1:4098/v1` (or any other reachable host:port).

## Configuration

1. Copy `settings.yaml` into your DSH `settings.yaml` under the `llm-pi-ai.providers` key.

2. Copy `.env.example` to your DSH `.env` (or set the variable in your orchestrator):
   ```bash
   cp .env.example .env
   ```

3. Restart DSH. You should now see `free-best` listed in your DSH model picker.

## What DSH sees

DSH treats `free-router` exactly like any other OpenAI-compatible provider. The actual model id returned in the response body (e.g. `openrouter/llama-3.3-70b:free`) is preserved by the router, so DSH's `responseModel` is the real picked model — not the route name.

The `x-free-router-model` response header is also available if you want to read it directly.

## Troubleshooting

- **`connection refused` on every call**: Free Best Router is not running. Start it with `npm start` in the `free-best-router` directory.
- **`NO_FREE_AGENT_MODEL_AVAILABLE`**: every free model is on cooldown. Wait for `Retry-After` seconds, or add more provider keys to `free-best-router/.env`.
- **Slow first call**: this is normal for the first call to a free model. Bump the DSH client timeout to 120 s+.
