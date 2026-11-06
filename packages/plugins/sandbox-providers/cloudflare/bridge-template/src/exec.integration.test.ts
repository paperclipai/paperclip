import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));

import { LIVE_OUTPUT_LIMIT_BYTES, executeInSandbox } from "./exec.js";

const BASE = process.env.BRIDGE_IT_BASE_URL ?? "";
const PROBE_FILE =
  process.env.BRIDGE_IT_GIT_PROBE ?? fileURLToPath(new URL("./__fixtures__/git-context-probe.sh", import.meta.url));
const SESSION = "paperclip";

async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json();
}

const sandbox = {
  getSession: async (id: string) => ({
    exec: async (command: string, options?: { cwd?: string; timeout?: number; stream?: boolean; onOutput?: (s: "stdout" | "stderr", d: string) => unknown }) => {
      const result = await post("/api/execute", { command, sessionId: id, cwd: options?.cwd, timeoutMs: options?.timeout });
      if (options?.stream && options.onOutput) {
        if (result.stdout) await options.onOutput("stdout", result.stdout);
        if (result.stderr) await options.onOutput("stderr", result.stderr);
      }
      return result;
    },
  }),
  writeFile: (path: string, content: string, options?: { encoding?: string }) =>
    post("/api/write", { path, content, sessionId: SESSION, encoding: options?.encoding === "utf8" ? "utf-8" : options?.encoding }),
  readFile: (path: string, options?: { encoding?: string; sessionId?: string }) =>
    post("/api/read", { path, sessionId: options?.sessionId ?? SESSION, encoding: options?.encoding }),
  deleteFile: (path: string, sessionId?: string) => post("/api/delete", { path, sessionId: sessionId ?? SESSION }),
};

function run(input: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: string | null; onOutput?: (s: "stdout" | "stderr", d: string) => void }) {
  return executeInSandbox({
    sandbox: sandbox as never,
    sessionStrategy: "named",
    sessionId: SESSION,
    timeoutMs: 30_000,
    ...input,
  });
}

describe.skipIf(!BASE)("bridge exec against a real cloudflare/sandbox container", () => {
  beforeAll(async () => {
    await post("/api/session/create", { id: SESSION, cwd: "/workspace" });
    await post("/api/mkdir", { path: "/workspace/paperclip", sessionId: SESSION, recursive: true });
  });
  afterAll(async () => {
    const listing = await run({ command: "sh", args: ["-c", "ls -1 /tmp | grep -c paperclip-bridge || true"] });
    expect(listing.stdout.trim()).toBe("0");
  });

  for (const mode of ["non-streaming", "streaming"] as const) {
    const onOutput = mode === "streaming" ? vi.fn() : undefined;

    it(`${mode}: preserves NUL framing from a printf probe`, async () => {
      const result = await run({
        command: "sh",
        args: ["-c", "printf '\\0PAPERCLIP_GIT_CONTEXT_V1\\0'; printf 'K\\0V\\0'; printf '\\0PAPERCLIP_GIT_CONTEXT_END\\0'; echo err >&2; exit 3"],
        cwd: "/workspace/paperclip",
        onOutput,
      });
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("\0PAPERCLIP_GIT_CONTEXT_V1\0K\0V\0\0PAPERCLIP_GIT_CONTEXT_END\0");
      expect(result.stderr).toBe("err\n");
      if (onOutput) expect(onOutput).toHaveBeenCalled();
    });

    it(`${mode}: Paperclip's real execution-target Git context probe parses`, async () => {
      if (!PROBE_FILE) return;
      const probe = readFileSync(PROBE_FILE, "utf8");
      const result = await run({
        command: "sh",
        args: ["-c", probe, "paperclip-git-context", "managed"],
        cwd: "/workspace/paperclip",
        onOutput,
      });
      expect(result.exitCode).toBe(0);
      const payload = result.stdout.split("\0PAPERCLIP_GIT_CONTEXT_V1\0")[1]?.split("\0PAPERCLIP_GIT_CONTEXT_END\0")[0];
      expect(payload).toBeDefined();
      const records = payload!.split("\0");
      const networkRoots: string[] = [];
      for (let index = 0; index + 1 < records.length; index += 2) {
        if (records[index] === "PAPERCLIP_RUNNER_NETWORK_ROOT") networkRoots.push(records[index + 1]!);
      }
      expect(networkRoots).toContain("/etc/resolv.conf");
      expect(networkRoots).toContain("/etc/hosts");
    });

    it(`${mode}: Paperclip's managed-launcher PATH probe parses`, async () => {
      const result = await run({ command: "sh", args: ["-c", "printf '\\000%s\\000' \"$PATH\""], cwd: "/workspace/paperclip", onOutput });
      expect(result.exitCode).toBe(0);
      const remotePath = result.stdout.match(/\0([^\0]+)\0/)?.[1];
      expect(remotePath).toBeTruthy();
      expect(remotePath).toContain("/usr/bin");
    });

    it(`${mode}: stdin, env, cwd and UTF-8 round-trip exactly`, async () => {
      const result = await run({
        command: "sh",
        args: ["-c", 'printf "%s|%s|" "$PAPERCLIP_IT" "$(pwd -P)"; cat'],
        cwd: "/workspace/paperclip",
        env: { PAPERCLIP_IT: "héllo ✓" },
        stdin: "ließ\n\0zero\n",
        onOutput,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("héllo ✓|/workspace/paperclip|ließ\n\0zero\n");
    });

    it(`${mode}: 1 MiB stdout is returned intact`, async () => {
      const result = await run({ command: "sh", args: ["-c", "head -c 786432 /dev/urandom | base64 -w0 | tee /tmp/it-big.txt; sha256sum /tmp/it-big.txt | cut -c1-64 >&2"], onOutput });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(1_048_576);
      expect(createHash("sha256").update(result.stdout).digest("hex")).toBe(result.stderr.trim());
    });

    it(`${mode}: a missing workspace cwd is recreated (container restart wiped disk)`, async () => {
      const cwd = `/workspace/recreated-${mode}`;
      await run({ command: "rm", args: ["-rf", cwd], cwd: "/" });
      const result = await run({ command: "sh", args: ["-c", "pwd -P"], cwd, onOutput });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(cwd);
    });

    it(`${mode}: a 3 MiB base64 chunk read is byte-exact and the live stream stays capped`, async () => {
      await run({ command: "sh", args: ["-c", "head -c 3145728 /dev/urandom > /tmp/it-blob && sha256sum /tmp/it-blob | cut -d' ' -f1 > /tmp/it-blob.sha"], cwd: "/" });
      const expectedSha = (await run({ command: "cat", args: ["/tmp/it-blob.sha"], cwd: "/" })).stdout.trim();
      const live: string[] = [];
      const result = await run({
        command: "sh",
        args: ["-c", "dd if=/tmp/it-blob bs=3145728 skip=0 count=1 2>/dev/null | base64"],
        cwd: "/",
        onOutput: mode === "streaming" ? (_stream, data) => { live.push(data); } : undefined,
      });
      expect(result.exitCode).toBe(0);
      const decoded = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
      expect(decoded.byteLength).toBe(3145728);
      expect(createHash("sha256").update(decoded).digest("hex")).toBe(expectedSha);
      if (mode === "streaming") {
        expect(live.join("").length).toBeLessThan(LIVE_OUTPUT_LIMIT_BYTES + 4096);
        expect(live.join("")).toContain("[paperclip-bridge] live stdout truncated");
        expect(result.stdout).not.toContain("[paperclip-bridge]");
        expect(result.stderr).not.toContain("[paperclip-bridge]");
      }
    });

    it(`${mode}: wrapper failure before redirect still reports an error`, async () => {
      const result = await run({ command: "pwd", cwd: "/etc/hostname/definitely/missing", onOutput });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/missing|No such file|Not a directory|File exists/i);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/Illegal number|paperclip-bridge-(rc|err)-/);
    });
  }
});
