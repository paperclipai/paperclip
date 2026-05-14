import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureQuotaBurnIntoCcrotateTierCache } from "../services/ccrotate-quota-writeback.js";

interface CapturedLog {
  payload: Record<string, unknown>;
  msg: string;
  level: "info" | "warn";
}

function makeLogger() {
  const calls: CapturedLog[] = [];
  return {
    calls,
    info: (payload: Record<string, unknown>, msg: string) =>
      void calls.push({ payload, msg, level: "info" }),
    warn: (payload: Record<string, unknown>, msg: string) =>
      void calls.push({ payload, msg, level: "warn" }),
  };
}

let homeDir: string;

function readTierCache(home: string) {
  return JSON.parse(
    fs.readFileSync(path.join(home, ".ccrotate", "tier-cache.json"), "utf8"),
  );
}

beforeEach(async () => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccrotate-writeback-test-"));
});

afterEach(async () => {
  await fsp.rm(homeDir, { recursive: true, force: true });
});

describe("captureQuotaBurnIntoCcrotateTierCache", () => {
  async function writeClaudeJson(email: string | null) {
    const value = email
      ? { oauthAccount: { emailAddress: email } }
      : { oauthAccount: {} };
    await fsp.writeFile(path.join(homeDir, ".claude.json"), JSON.stringify(value));
  }

  it("writes serviceTier='exhausted' for claude_local with retryNotBefore", async () => {
    await writeClaudeJson("active@example.com");

    const reset = new Date(Date.now() + 90 * 60_000);
    const log = makeLogger();
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_local",
      retryNotBefore: reset,
      homeDir,
      log,
    });

    expect(result.status).toBe("wrote");
    expect(result.target).toBe("claude");
    expect(result.email).toBe("active@example.com");

    const cache = readTierCache(homeDir);
    expect(cache.accounts).toHaveLength(1);
    expect(cache.accounts[0].email).toBe("active@example.com");
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
    expect(cache.accounts[0].rateLimits.reset5h).toBe(Math.floor(reset.getTime() / 1000));
  });

  it("writes for claude_k8s the same way as claude_local", async () => {
    await writeClaudeJson("k8s@example.com");

    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_k8s",
      retryNotBefore: new Date(Date.now() + 60 * 60_000),
      homeDir,
    });

    expect(result.status).toBe("wrote");
    expect(result.email).toBe("k8s@example.com");
    const cache = readTierCache(homeDir);
    expect(cache.accounts[0].email).toBe("k8s@example.com");
  });

  it("preserves other accounts when upserting the burned entry", async () => {
    await writeClaudeJson("burn@x.com");
    await fsp.mkdir(path.join(homeDir, ".ccrotate"), { recursive: true });
    await fsp.writeFile(
      path.join(homeDir, ".ccrotate", "tier-cache.json"),
      JSON.stringify({
        updatedAt: "2026-05-01T00:00:00Z",
        accounts: [
          { email: "keep@x.com", serviceTier: "base", rateLimits: { utilization5h: 5 } },
          { email: "burn@x.com", serviceTier: "base", rateLimits: { utilization5h: 99 } },
        ],
      }),
    );

    await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_local",
      retryNotBefore: new Date(Date.now() + 30 * 60_000),
      homeDir,
    });

    const cache = readTierCache(homeDir);
    expect(cache.accounts).toHaveLength(2);
    const keep = cache.accounts.find((a: { email: string }) => a.email === "keep@x.com");
    const burn = cache.accounts.find((a: { email: string }) => a.email === "burn@x.com");
    expect(keep.serviceTier).toBe("base");
    expect(burn.serviceTier).toBe("exhausted");
  });

  it("skips writeback when adapter type does not go through ccrotate", async () => {
    await writeClaudeJson("a@x.com");
    const log = makeLogger();
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "hermes_local",
      retryNotBefore: new Date(),
      homeDir,
      log,
    });
    expect(result.status).toBe("skipped_no_target");
    expect(fs.existsSync(path.join(homeDir, ".ccrotate", "tier-cache.json"))).toBe(false);
  });

  it("skips codex target until JWT-decode email lookup is implemented", async () => {
    const log = makeLogger();
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "codex_local",
      retryNotBefore: new Date(),
      homeDir,
      log,
    });
    expect(result.status).toBe("skipped_codex_unsupported");
    expect(fs.existsSync(path.join(homeDir, ".ccrotate", "tier-cache.codex.json"))).toBe(false);
  });

  it("skips when ~/.claude.json is missing", async () => {
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_local",
      retryNotBefore: new Date(),
      homeDir,
    });
    expect(result.status).toBe("skipped_no_email");
  });

  it("skips when ~/.claude.json has no oauthAccount.emailAddress", async () => {
    await fsp.writeFile(path.join(homeDir, ".claude.json"), "{}");
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_local",
      retryNotBefore: new Date(),
      homeDir,
    });
    expect(result.status).toBe("skipped_no_email");
  });

  it("still writes (without reset epoch) when retryNotBefore is null", async () => {
    await writeClaudeJson("a@x.com");
    const result = await captureQuotaBurnIntoCcrotateTierCache({
      adapterType: "claude_local",
      retryNotBefore: null,
      homeDir,
    });
    expect(result.status).toBe("wrote");
    expect(result.resetEpochSec).toBeNull();
    const cache = readTierCache(homeDir);
    expect(cache.accounts[0].serviceTier).toBe("exhausted");
    expect(cache.accounts[0].rateLimits.reset5h).toBeUndefined();
  });
});
