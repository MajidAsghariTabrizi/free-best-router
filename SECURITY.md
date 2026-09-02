# Security Policy

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | ✅ Yes (current)    |
| < 0.1   | ❌ No (pre-release) |

## Reporting a vulnerability

**Please do not file a public issue for security problems.**

Email **security@your-domain.example** (replace with the maintainer's real address before publishing — see `package.json` `bugs.url`) with:

- A description of the vulnerability
- Steps to reproduce
- The impact (what an attacker could achieve)
- Any known mitigations

You should receive a response within 72 hours. Critical issues are patched within 7 days; non-critical within 30 days. You will be credited in the release notes unless you prefer to remain anonymous.

## Threat model

Free Best Router is designed to be safe to run on a trusted local network (e.g. `127.0.0.1` or a private LAN). It is **not** safe to expose to the public internet without putting an authentication proxy in front of it.

### What the router does for you

- ✅ **Never logs secrets.** Provider API keys, bearer tokens, and request bodies are never written to disk, log files, or `/diagnostics` output.
- ✅ **Never persists raw prompts.** The router relays requests and responses in memory only. After the response is sent, the prompt and response are gone.
- ✅ **No telemetry.** The router does not phone home. There is no central service. There is no usage analytics.
- ✅ **Sandboxed provider calls.** Each provider is called with that provider's own API key, isolated from the others. A compromised provider cannot read another provider's key.
- ✅ **Bounded request size.** 20 MB max body. Larger uploads are rejected.
- ✅ **No SSRF amplification.** The only outbound traffic is to the configured provider `baseUrl`s.

### What the router does NOT do

- ❌ **Does not validate the inbound `Authorization` header.** The router uses its own provider keys from the environment. If you bind to a non-loopback interface, an attacker on the network could send requests and consume your free-tier quota. Put a reverse proxy with auth in front of it.
- ❌ **Does not sanitize provider responses for injection.** Provider outputs are streamed back to the client verbatim. Treat them as untrusted.
- ❌ **Does not enforce HTTPS in transit between you and providers.** Providers that use HTTPS will be reached over HTTPS; providers that use HTTP (e.g. OpenCode local proxy) are reached over HTTP. Use a local-only base URL for those.
- ❌ **Does not provide rate limiting at the router level.** The router's `routing.fallback.maxDepth` and `attemptTimeoutMs` bound the *server-side* cost of a single request, not the request rate. Run a reverse proxy with rate limiting if you need that.

## Hardening checklist for production-ish deployments

If you want to run Free Best Router on a non-loopback interface (e.g. in a Docker container, on a server):

1. **Bind to a private interface** (`server.host` in `config.json` — not `0.0.0.0`).
2. **Put an authentication proxy in front** (Caddy, nginx with `auth_basic`, oauth2-proxy, etc.).
3. **Add TLS** at the proxy layer. The router itself speaks plain HTTP.
4. **Set per-IP rate limits** at the proxy. The router will not enforce them.
5. **Restrict the `CORS` origin** if you serve a browser client.
6. **Run the router as a non-root user** with a read-only filesystem for everything except the log directory.
7. **Do not commit `.env`** to version control. `.env` is in `.gitignore`.

## Secret handling

Provider API keys are read from environment variables only. The router does not read `.env` files by default; the optional `.env` loader in `src/index.mjs` is for local development convenience. To load env vars from a file in production, use the orchestrator (systemd `EnvironmentFile=`, Kubernetes `Secret` + `envFrom`, Docker `--env-file`, etc.).

The router does not log:

- The value of any environment variable
- The contents of any `Authorization` header
- The contents of any request or response body
- The URL of any provider, beyond what's in the `providerHealth` map of `/diagnostics`

If you need to redact the provider base URLs from `/diagnostics` for some reason, patch the engine — there is no built-in toggle.

## Dependency security

The project has a single runtime dependency: [`undici`](https://github.com/nodejs/undici). It is maintained by the Node.js core team.

`npm audit` is run in CI. If you find a vulnerability in a dependency, please report it upstream first, then open an issue here.

## Past vulnerabilities

None reported. This is the first release of Free Best Router as a public open-source project.
