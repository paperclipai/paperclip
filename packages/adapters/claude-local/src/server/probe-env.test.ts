import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLocalAdapterTestProbeEnv } from "./probe-env.js";

const tempDirs: string[] = [];

async function makeTrustedPathWithClaude(): Promise<{ dir: string; claudePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-env-"));
  tempDirs.push(dir);
  const claudePath = path.join(dir, "claude");
  await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
  await chmod(claudePath, 0o755);
  return { dir, claudePath };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("buildLocalAdapterTestProbeEnv", () => {
  it("resolves claude from the trusted PATH and ignores the caller PATH", async () => {
    const { dir, claudePath } = await makeTrustedPathWithClaude();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: { PATH: "/hostile/bin", Path: "/hostile/bin", command: "/tmp/evil/claude" },
      trustedEnv: { PATH: dir },
    });
    expect(built.command).toBe(claudePath);
    expect(built.env.PATH).toBeUndefined();
    expect(built.env.Path).toBeUndefined();
  });

  it("returns a null command when the trusted PATH holds no claude", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-env-empty-"));
    tempDirs.push(dir);
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {},
      trustedEnv: { PATH: dir },
    });
    expect(built.command).toBeNull();
  });

  it("keeps the allowlisted Claude, auth, and Bedrock values", async () => {
    const { dir } = await makeTrustedPathWithClaude();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {
        ANTHROPIC_API_KEY: "api-key-value",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
        AWS_ACCESS_KEY_ID: "aws-key",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        AWS_REGION: "us-east-1",
        CLAUDE_CONFIG_DIR: "/managed/config",
      },
      trustedEnv: { PATH: dir },
    });
    expect(built.env.ANTHROPIC_API_KEY).toBe("api-key-value");
    expect(built.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value");
    expect(built.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(built.env.ANTHROPIC_BEDROCK_BASE_URL).toBe("https://bedrock.example");
    expect(built.env.AWS_ACCESS_KEY_ID).toBe("aws-key");
    expect(built.env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(built.env.AWS_REGION).toBe("us-east-1");
    expect(built.env.CLAUDE_CONFIG_DIR).toBe("/managed/config");
  });

  it("drops hostile loader, PATH, shell-startup, and Windows interpreter keys", async () => {
    const { dir } = await makeTrustedPathWithClaude();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {
        PATH: "/hostile/bin",
        Path: "/hostile/bin",
        PATHEXT: ".EVIL",
        LD_PRELOAD: "/hostile/lib/evil.so",
        LD_LIBRARY_PATH: "/hostile/lib",
        DYLD_INSERT_LIBRARIES: "/hostile/lib/evil.dylib",
        DYLD_LIBRARY_PATH: "/hostile/lib",
        NODE_OPTIONS: "--require /hostile/evil.js",
        ENV: "/hostile/profile",
        BASH_ENV: "/hostile/bashrc",
        SystemRoot: "C:\\hostile",
        systemroot: "C:\\hostile",
        WINDIR: "C:\\hostile",
        windir: "C:\\hostile",
        ComSpec: "C:\\hostile\\evil.exe",
        comspec: "C:\\hostile\\evil.exe",
      },
      trustedEnv: { PATH: dir },
    });
    for (const key of Object.keys(built.env)) {
      expect(key.toUpperCase()).not.toBe("PATH");
      expect(key.toUpperCase()).not.toBe("PATHEXT");
      expect(key.toUpperCase()).not.toBe("LD_PRELOAD");
      expect(key.toUpperCase()).not.toBe("LD_LIBRARY_PATH");
      expect(key.toUpperCase()).not.toBe("DYLD_INSERT_LIBRARIES");
      expect(key.toUpperCase()).not.toBe("DYLD_LIBRARY_PATH");
      expect(key.toUpperCase()).not.toBe("NODE_OPTIONS");
      expect(key.toUpperCase()).not.toBe("ENV");
      expect(key.toUpperCase()).not.toBe("BASH_ENV");
      expect(key.toUpperCase()).not.toBe("SYSTEMROOT");
      expect(key.toUpperCase()).not.toBe("WINDIR");
      expect(key.toUpperCase()).not.toBe("COMSPEC");
    }
  });

  it("takes proxy values only from the trusted env, never from the caller", async () => {
    const { dir } = await makeTrustedPathWithClaude();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: {
        HTTP_PROXY: "http://caller-proxy:8080",
        HTTPS_PROXY: "http://caller-proxy:8443",
        http_proxy: "http://caller-proxy-lower:8080",
        NO_PROXY: "caller.example",
      },
      trustedEnv: { PATH: dir, HTTPS_PROXY: "http://trusted-proxy:8443" },
    });
    // The trusted proxy reaches the child; the caller proxy does not.
    expect(built.env.HTTPS_PROXY).toBe("http://trusted-proxy:8443");
    expect(built.env.HTTP_PROXY).toBeUndefined();
    expect(built.env.http_proxy).toBeUndefined();
    expect(built.env.NO_PROXY).toBeUndefined();
    // No env value carries the caller proxy host.
    const serialized = JSON.stringify(built.env);
    expect(serialized).not.toContain("caller-proxy");
  });

  it("forwards no proxy variable when the trusted env has none", async () => {
    const { dir } = await makeTrustedPathWithClaude();
    const built = await buildLocalAdapterTestProbeEnv({
      callerEnv: { HTTP_PROXY: "http://caller-proxy:8080", https_proxy: "http://caller:8443" },
      trustedEnv: { PATH: dir },
    });
    for (const key of Object.keys(built.env)) {
      expect(key.toUpperCase()).not.toContain("PROXY");
    }
  });
});
