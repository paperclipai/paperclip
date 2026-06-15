import { describe, expect, it } from "vitest";
import { buildPluginWorkerEnv } from "../services/plugin-loader.js";

const instanceInfo = { deploymentMode: "managed", deploymentExposure: "private" };

// Host env the paperclip server runs with: CCROTATE_* infra vars the connector
// needs, plus secrets that must NEVER reach a plugin worker.
const hostEnv = {
  CCROTATE_SERVE_TOKEN: "tok-secret",
  CCROTATE_SERVE_BASE_URL: "http://ccrotate-serve:4000",
  CCROTATE_STATE_URL: "http://ccrotate-state:4002",
  CCROTATE_AUTH_BOT_URL: "http://ccrotate-auth-bot:7000",
  CCROTATE_EMPTY: "",
  DATABASE_URL: "postgres://secret",
  ANTHROPIC_API_KEY: "sk-host",
} as unknown as NodeJS.ProcessEnv;

describe("buildPluginWorkerEnv — ccrotate connector env passthrough", () => {
  it("forwards all non-empty CCROTATE_* vars to the ccrotate plugin worker only", () => {
    const env = buildPluginWorkerEnv({
      manifest: { id: "kkroo.ccrotate", capabilities: ["api.routes.register", "plugin.state.read"] },
      instanceInfo,
      processEnv: hostEnv,
    });
    expect(env.CCROTATE_SERVE_TOKEN).toBe("tok-secret");
    expect(env.CCROTATE_SERVE_BASE_URL).toBe("http://ccrotate-serve:4000");
    expect(env.CCROTATE_STATE_URL).toBe("http://ccrotate-state:4002");
    expect(env.CCROTATE_AUTH_BOT_URL).toBe("http://ccrotate-auth-bot:7000");
    // Empty values dropped; non-CCROTATE host secrets are never forwarded.
    expect(env.CCROTATE_EMPTY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does NOT forward CCROTATE_* to other plugins (token stays scoped)", () => {
    const env = buildPluginWorkerEnv({
      manifest: { id: "kkroo.slack", capabilities: ["api.routes.register"] },
      instanceInfo,
      processEnv: hostEnv,
    });
    expect(env.CCROTATE_SERVE_TOKEN).toBeUndefined();
    expect(env.CCROTATE_STATE_URL).toBeUndefined();
  });

  it("withholds CCROTATE_* from a manifest with no id", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: [] },
      instanceInfo,
      processEnv: hostEnv,
    });
    expect(Object.keys(env).some((k) => k.startsWith("CCROTATE_"))).toBe(false);
  });
});
