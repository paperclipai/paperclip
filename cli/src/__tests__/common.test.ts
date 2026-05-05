import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStoredBoardCredential, setStoredBoardCredential } from "../client/board-auth.js";
import { writeContext } from "../client/context.js";
import { resolveCommandContext } from "../commands/client/common.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDIN_IS_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_IS_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function createTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-common-"));
  return path.join(dir, name);
}

describe("resolveCommandContext", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_AUTH_STORE;
    delete process.env.PAPERCLIP_COMPANY_ID;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    restorePropertyDescriptor(process.stdin, "isTTY", ORIGINAL_STDIN_IS_TTY);
    restorePropertyDescriptor(process.stdout, "isTTY", ORIGINAL_STDOUT_IS_TTY);
    vi.restoreAllMocks();
  });

  it("uses profile defaults when options/env are not provided", () => {
    const contextPath = createTempPath("context.json");

    writeContext(
      {
        version: 1,
        currentProfile: "ops",
        profiles: {
          ops: {
            apiBase: "http://127.0.0.1:9999",
            companyId: "company-profile",
            apiKeyEnvVarName: "AGENT_KEY",
          },
        },
      },
      contextPath,
    );
    process.env.AGENT_KEY = "key-from-env";

    const resolved = resolveCommandContext({ context: contextPath }, { requireCompany: true });
    expect(resolved.api.apiBase).toBe("http://127.0.0.1:9999");
    expect(resolved.companyId).toBe("company-profile");
    expect(resolved.api.apiKey).toBe("key-from-env");
  });

  it("prefers explicit options over profile values", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://profile:3100",
            companyId: "company-profile",
          },
        },
      },
      contextPath,
    );

    const resolved = resolveCommandContext(
      {
        context: contextPath,
        apiBase: "http://override:3200",
        apiKey: "direct-token",
        companyId: "company-override",
      },
      { requireCompany: true },
    );

    expect(resolved.api.apiBase).toBe("http://override:3200");
    expect(resolved.companyId).toBe("company-override");
    expect(resolved.api.apiKey).toBe("direct-token");
  });

  it("throws when company is required but unresolved", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 1,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );

    expect(() =>
      resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true }),
    ).toThrow(/Company ID is required/);
  });

  it("removes a stale stored board credential when a non-interactive request is rejected", async () => {
    const authPath = createTempPath("auth.json");
    process.env.PAPERCLIP_AUTH_STORE = authPath;
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "stale-token",
      storePath: authPath,
    });
    setTty(false);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Board access required" }), { status: 403 }),
      ),
    );

    const resolved = resolveCommandContext({ apiBase: "http://localhost:3100" });
    expect(resolved.api.apiKey).toBe("stale-token");

    await expect(resolved.api.get("/api/companies")).rejects.toThrow(
      /Removed stale board credential for http:\/\/localhost:3100/,
    );
    expect(getStoredBoardCredential("http://localhost:3100", authPath)).toBeNull();
  });
});

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restorePropertyDescriptor<T extends object, K extends keyof T>(
  target: T,
  property: K,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
  } else {
    delete target[property];
  }
}
