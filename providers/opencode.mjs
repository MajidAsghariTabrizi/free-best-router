// providers/opencode.mjs — OpenCode / Zen (https://opencode.ai).
// OpenCode Zen exposes a free tier; the existing local proxy already enforces
// authentication. Free id set is the constant OPENCODE_FREE_IDS plus any id
// ending in "-free" (e.g. "mimo-v2.5-free", "laguna-s-2.1-free").
//
// OpenCode is a LOCAL install: it requires the OpenCode Zen CLI/binary to be
// running on the configured baseUrl (default http://127.0.0.1:4097/opencode.ai/v1).
// When that install is missing, `configured()` returns false (same bucket as a
// provider without an API key), and the router treats it as NOT_CONFIGURED
// rather than DEGRADED.
import { OpenAICompatibleAdapter, tcpReachable } from "./openai-compatible.mjs";

const OPENCODE_FREE_IDS = new Set(["big-pickle"]);

export class OpenCodeAdapter extends OpenAICompatibleAdapter {
  constructor({ key, baseUrl = "http://127.0.0.1:4097/opencode.ai/v1" } = {}) {
    super({
      id: "opencode",
      displayName: "OpenCode Zen",
      key, baseUrl,
      freeMatcher: (m) => OPENCODE_FREE_IDS.has(m.id) || String(m.id).endsWith("-free"),
      dataPolicy: { promptRetention: "retained", trainingUsage: "unknown", thirdPartyProvider: true },
      defaultContextInput: 200000, defaultContextOutput: 32768,
    });
    this.installHint = "Install OpenCode Zen CLI: https://opencode.ai/docs — start its proxy on the configured baseUrl to enable this provider.";
  }
  // Cached local-install reachability check (async, used at construction time).
  async isInstalled() {
    try {
      const u = new URL(this.baseUrl);
      return await tcpReachable(u.hostname, Number(u.port) || 80, 1500);
    } catch { return false; }
  }
  // configured() must be sync (the engine uses it during refresh). We do a
  // sync path check via the `installed` flag set by `setInstalledFlag()`.
  setInstalledFlag(v) { this.installed = v; }
}
