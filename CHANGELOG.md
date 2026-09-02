# Changelog

All notable changes to Free Best Router will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-XX-XX — Initial public release

The first stable, public, open-source release of Free Best Router.

### Added

- **OpenAI-compatible server** on `http://127.0.0.1:4098/v1` with:
  - `POST /v1/chat/completions` (streaming and non-streaming)
  - `GET /v1/models`
  - `GET /health`
  - `GET /diagnostics` (JSON or text dashboard)
  - `POST /_refresh` (force catalog refresh)
- **Multi-provider routing** across:
  - OpenRouter (`:free` models)
  - OpenCode / Zen (`-free` models; requires local install)
  - Groq Cloud (Llama 3.1/3.3 free tier)
  - Cerebras Inference (Llama / Qwen free tier)
  - Mistral La Plateforme (small / nemo / codestral-mamba)
  - DeepSeek (wired but excluded by free-only policy)
  - Local inference servers (Ollama, LM Studio, llama.cpp — auto-discovered on well-known ports)
- **Capability-aware ranking** with:
  - 7 weighted score components (capability, agentic quality, reliability, coding, context, tool, latency)
  - Wilson lower bound on success rate (95% confidence)
  - Bayesian shrinkage toward 0.5 prior for under-sampled candidates
  - Time-decay penalty on recent failure types
- **Health + cooldown** state machine:
  - 6 cooldown types (rate_limit, timeout, transport, server_error, finish_error, model_not_found, client_error)
  - Per-type exponential backoff base
  - Per-type cap (8 min for short bursts, 1 h for not-found / client-error)
  - Anti-correlated-burst reset (halve consecutive counter after cooldown expiry without fresh failure)
- **Smart exploration** at 5% rate (configurable) — probes under-sampled healthy candidates
- **Automatic fallback** up to 4 model attempts per request, bounded by per-attempt timeout
- **Bounded failure** — returns 502/429 + `Retry-After` + `next_eligible_model` when the pool is empty
- **DeepSeek Harness integration** — first-class OpenAI-compatible provider config documented
- **Per-provider HTTP proxy** support via `*_PROXY_URL` env vars
- **Self-hosted & privacy-first** — no telemetry, no central service, no remote logging
- **Modular provider tree** under `providers/` — adding a new OpenAI-compatible provider is one file
- **52 deterministic unit tests** covering: free-only filtering, multi-provider failover, capability inference, ranking, cooldown, exploration, recovery, server fail-fast, end-to-end success
- **GitHub Actions CI** (tests on push and PR)
- **Comprehensive documentation**: README, architecture, provider dev guide, security, contributing

### Known limitations

- **In-memory state only.** Cooldowns, success rates, and per-model stats are lost on restart. A `serialize()` / `deserialize()` is planned for v0.2.
- **No HTTP proxy for OpenRouter.** OpenRouter is reached directly; a proxy is only used by providers that need it.
- **No persistent on-disk catalog.** Each restart rediscovers from providers.
- **First-hit latency is real.** Free-tier inference queues; expect 5–30 s for the first call to a cold model.
- **Local install detection only for OpenCode.** Other local providers (Ollama, LM Studio) are auto-discovered on well-known ports but not on custom ports.

### Security

- First public release. No prior CVEs.
- See [`SECURITY.md`](SECURITY.md) for the threat model and hardening checklist.

[0.1.0]: https://github.com/MajidAsghariTabrizi/free-best-router/releases/tag/v0.1.0
