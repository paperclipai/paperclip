import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PARAM,
  PAPERCLIP_PORT,
  PAPERCLIP_UID,
  START_COMMAND,
  STORAGE_MOUNT_PATH,
  accessDeniedPage,
  bootstrapGateMode,
  getCookie,
  setupRequiredPage,
  bootingPage,
  bootingResponse,
  buildPaperclipEnv,
  isMountAlreadyInUse,
  isPaperclipRunning,
  isTransientBootError,
  isTransientBootMessage,
  isWebSocketUpgrade,
  storageMountOptions,
} from "../src/lib";

describe("isWebSocketUpgrade", () => {
  it("detects a standard upgrade request", () => {
    const headers = new Headers({ Upgrade: "websocket", Connection: "Upgrade" });
    expect(isWebSocketUpgrade(headers)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isWebSocketUpgrade(new Headers({ Upgrade: "WebSocket" }))).toBe(true);
  });

  it("rejects plain requests and non-websocket upgrades", () => {
    expect(isWebSocketUpgrade(new Headers())).toBe(false);
    expect(isWebSocketUpgrade(new Headers({ Upgrade: "h2c" }))).toBe(false);
  });
});

describe("isPaperclipRunning", () => {
  it("finds a live boot process", () => {
    expect(
      isPaperclipRunning([{ command: START_COMMAND, status: "running" }])
    ).toBe(true);
    expect(
      isPaperclipRunning([{ command: `bash ${START_COMMAND}`, status: "starting" }])
    ).toBe(true);
  });

  it("ignores dead processes so a restart can happen", () => {
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      expect(isPaperclipRunning([{ command: START_COMMAND, status }])).toBe(false);
    }
  });

  it("ignores unrelated processes and empty lists", () => {
    expect(isPaperclipRunning([])).toBe(false);
    expect(isPaperclipRunning([{ command: "sleep 1", status: "running" }])).toBe(false);
    expect(isPaperclipRunning([{}])).toBe(false);
  });
});

describe("buildPaperclipEnv", () => {
  it("produces the baseline environment", () => {
    const env = buildPaperclipEnv({ publicUrl: "https://example.workers.dev" });
    expect(env).toEqual({
      HOST: "0.0.0.0",
      PORT: String(PAPERCLIP_PORT),
      PAPERCLIP_HOME: "/paperclip",
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
      PAPERCLIP_PUBLIC_URL: "https://example.workers.dev",
    });
  });

  it("only forwards secrets that are actually set", () => {
    const bare = buildPaperclipEnv({ publicUrl: "https://x.dev" });
    expect(bare).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(bare).not.toHaveProperty("DATABASE_URL");

    const withSecrets = buildPaperclipEnv({
      publicUrl: "https://x.dev",
      anthropicApiKey: "test-key",
      databaseUrl: "postgres://example",
    });
    expect(withSecrets.ANTHROPIC_API_KEY).toBe("test-key");
    expect(withSecrets.DATABASE_URL).toBe("postgres://example");
  });

  it("honors mode/exposure overrides", () => {
    const env = buildPaperclipEnv({
      publicUrl: "https://x.dev",
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    });
    expect(env.PAPERCLIP_DEPLOYMENT_EXPOSURE).toBe("public");
  });
});

describe("transient boot detection", () => {
  it("matches the Sandbox SDK's startup errors", () => {
    for (const message of [
      "Container is currently provisioning. This can take several minutes on first deployment.",
      "no container instance available",
      "connection refused",
      "Port 3100 not ready",
      "Network connection lost",
    ]) {
      expect(isTransientBootMessage(message), message).toBe(true);
      expect(isTransientBootError(new Error(message)), message).toBe(true);
    }
  });

  it("does not swallow genuine application errors", () => {
    for (const message of [
      "Internal Server Error",
      "database migration failed",
      "TypeError: cannot read properties of undefined",
    ]) {
      expect(isTransientBootMessage(message), message).toBe(false);
    }
    expect(isTransientBootError("connection refused")).toBe(false); // non-Error
  });
});

describe("bootstrapGateMode", () => {
  it("fails closed when no token is configured", () => {
    expect(bootstrapGateMode({})).toBe("setup");
    expect(bootstrapGateMode({ token: undefined })).toBe("setup");
  });

  it("treats an empty-string token as unconfigured, never open", () => {
    expect(bootstrapGateMode({ token: "" })).toBe("setup");
  });

  it("requires the token when one is configured", () => {
    expect(bootstrapGateMode({ token: "s3cret" })).toBe("token");
  });

  it("only opens on the explicit literal opt-out", () => {
    expect(bootstrapGateMode({ disableGate: "true" })).toBe("open");
    expect(bootstrapGateMode({ token: "s3cret", disableGate: "true" })).toBe("open");
    expect(bootstrapGateMode({ disableGate: "TRUE" })).toBe("setup");
    expect(bootstrapGateMode({ disableGate: "1" })).toBe("setup");
  });

  it("setup page tells the operator how to configure the gate", () => {
    const html = setupRequiredPage();
    expect(html).toContain("BOOTSTRAP_TOKEN");
    expect(html).toContain("DISABLE_BOOTSTRAP_GATE");
  });
});

describe("bootstrap gate helpers", () => {
  it("extracts a single cookie value", () => {
    expect(getCookie("a=1; paperclip_bootstrap=tok; b=2", "paperclip_bootstrap")).toBe("tok");
    expect(getCookie("paperclip_bootstrap=tok", "paperclip_bootstrap")).toBe("tok");
  });

  it("returns undefined for missing header, missing cookie, or name prefixes", () => {
    expect(getCookie(null, "paperclip_bootstrap")).toBeUndefined();
    expect(getCookie("other=1", "paperclip_bootstrap")).toBeUndefined();
    expect(getCookie("xpaperclip_bootstrap=evil", "paperclip_bootstrap")).toBeUndefined();
  });

  it("access-denied page names the param and secret", () => {
    const html = accessDeniedPage();
    expect(html).toContain(BOOTSTRAP_PARAM);
    expect(html).toContain("BOOTSTRAP_TOKEN");
  });
});

describe("storage mount", () => {
  it("targets Paperclip's local_disk storage path, never the DB dir", () => {
    expect(STORAGE_MOUNT_PATH).toBe("/paperclip/instances/default/data/storage");
    expect(STORAGE_MOUNT_PATH).not.toContain("postgres");
  });

  it("exposes the mount as the paperclip user", () => {
    const { s3fsOptions } = storageMountOptions();
    expect(s3fsOptions).toContain(`uid=${PAPERCLIP_UID}`);
    expect(s3fsOptions).toContain(`gid=${PAPERCLIP_UID}`);
    expect(s3fsOptions).toContain("allow_other");
  });

  it("recognizes the benign already-mounted race", () => {
    expect(isMountAlreadyInUse(new Error("Mount path already in use: /x"))).toBe(true);
    expect(isMountAlreadyInUse(new Error("S3FS mount command failed"))).toBe(false);
    expect(isMountAlreadyInUse("already in use")).toBe(false); // non-Error
  });
});

describe("booting page", () => {
  it("self-refreshes and explains what is happening", () => {
    const html = bootingPage();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("Paperclip is starting");
  });

  it("responds 503 with Retry-After and no caching", () => {
    const response = bootingResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("15");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
