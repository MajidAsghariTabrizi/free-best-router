# Contributing to Free Best Router

First off, thank you for taking the time to contribute. Free Best Router is a community project and every provider adapter, ranking experiment, and bug report makes it better.

## Quick links

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Good first issues](https://github.com/MajidAsghariTabrizi/free-best-router/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)

## Development setup

Requirements: **Node.js >= 22** (the project uses native ESM, `node --test`, and undici's `ProxyAgent`).

```bash
git clone https://github.com/MajidAsghariTabrizi/free-best-router.git
cd free-best-router
npm install
npm test
```

The test suite is fully deterministic and runs in ~200 ms with no network. It must pass before any PR is merged.

To run the router locally:

```bash
cp .env.example .env
# add at least one provider key
npm start
```

## How to contribute

### 1. Add a new provider

The most common contribution. See [`docs/providers.md`](docs/providers.md) for the full guide. Short version:

1. Create `providers/<name>.mjs` extending `OpenAICompatibleAdapter` (or implementing the full contract from scratch).
2. Add an export to `providers/index.mjs`.
3. Wire the adapter in `src/index.mjs`.
4. Add a `test/<name>.test.mjs` covering discover / execute / free-matcher.
5. Add the provider to the README's "Supported providers" table.

### 2. Add a known free model id

Many providers publish a free tier that requires an allowlist (Groq, Cerebras, Mistral). Adding an id is a one-line PR. Look at the `GROQ_FREE_IDS` / `CEREBRAS_FREE_IDS` / `MISTRAL_FREE_IDS` constants in `providers/`.

### 3. Improve the ranking algorithm

The scoring weights and capability overrides live in `src/classify.mjs`. If you have a better idea for how to weight `capability_fit` vs `reliability` vs `latency`, propose it with measurements from `/diagnostics` before and after.

### 4. Add a test

If you find a bug, add a regression test. If you propose a new feature, add a test for the new behavior. Tests are in `test/*.test.mjs`.

### 5. Documentation

- The README is the product landing page. Improvements to clarity, structure, or examples are always welcome.
- The architecture doc (`docs/architecture.md`) is the design specification. It should match the code.
- The provider dev guide (`docs/providers.md`) is what a new contributor reads first.

## Pull request process

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/my-contribution
   ```
2. Make your changes. Keep the diff focused. A PR that fixes one thing is easier to review than one that fixes seven things.
3. Run `npm test` and confirm all tests pass. Add new tests for new behavior.
4. If your change is user-visible, update the README and `CHANGELOG.md`.
5. Push your branch and open a Pull Request against `main`.
6. The PR title should follow [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add xai grok provider
   fix: halve consecutive429 after cooldown expiry
   docs: clarify retry-after header semantics
   test: add regression for 502 with empty pool
   refactor: split providers/ into one file per adapter
   chore: bump undici to 8.10.2
   ```
7. Wait for CI to go green and a maintainer to review. Be patient — most reviews come within 2 business days.

## Coding style

- The project is plain Node.js ESM (no TypeScript, no bundler, no transpilation). Keep it that way.
- Files use 2-space indentation, semicolons, single quotes.
- Comments explain *why*, not *what*. The code itself should be self-documenting.
- One file per provider adapter.
- Never log secrets, bearer tokens, or request bodies. The router never logs them today; new code should preserve that.
- No telemetry. The router does not phone home, period. New code must not introduce a remote call on the user's behalf.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:

- Node.js version (`node --version`)
- Free Best Router version (`npm start` shows it in the log)
- A minimal repro: the exact `curl` or Python snippet that triggers it
- The full output of `GET /diagnostics` (sanitized of any `Authorization` headers, which the router never logs anyway)

## Suggesting features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md). Free Best Router is opinionated about being a local, self-hosted, free-model router — please check the [roadmap in the README](README.md#roadmap) before proposing something out of scope.

## Security issues

**Do not open a public issue.** Follow the process in [`SECURITY.md`](SECURITY.md). All security issues are taken seriously and fixed as quickly as possible.
