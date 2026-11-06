import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readKimiAccessToken } from "./quota.js";

let home: string;

async function writeCredential(file: string, contents: unknown): Promise<void> {
  await fs.mkdir(path.join(home, "credentials"), { recursive: true });
  await fs.writeFile(path.join(home, "credentials", file), JSON.stringify(contents), "utf8");
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-quota-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("readKimiAccessToken", () => {
  it("returns the access token from the login credential file", async () => {
    await writeCredential("kimi-code-env.json", {
      access_token: "fixture-token",
      expires_at: Date.now() + 60_000,
    });
    await expect(readKimiAccessToken(home)).resolves.toBe("fixture-token");
  });

  it("prefers the credential with the furthest expiry", async () => {
    await writeCredential("older.json", {
      access_token: "older",
      expires_at: Date.now() + 60_000,
    });
    await writeCredential("newer.json", {
      access_token: "newer",
      expires_at: Date.now() + 600_000,
    });
    await expect(readKimiAccessToken(home)).resolves.toBe("newer");
  });

  it("skips an expired token instead of sending it", async () => {
    await writeCredential("stale.json", {
      access_token: "stale",
      expires_at: Date.now() - 1_000,
    });
    await expect(readKimiAccessToken(home)).resolves.toBeNull();
  });

  it("ignores files without a token and unreadable JSON", async () => {
    await fs.mkdir(path.join(home, "credentials"), { recursive: true });
    await fs.writeFile(path.join(home, "credentials", "broken.json"), "{not json", "utf8");
    await writeCredential("empty.json", { access_token: "   " });
    await expect(readKimiAccessToken(home)).resolves.toBeNull();
  });

  it("returns null when no credentials directory exists", async () => {
    await expect(readKimiAccessToken(path.join(home, "missing"))).resolves.toBeNull();
  });
});
