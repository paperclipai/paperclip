import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { remoteProgram } from "./remote-program.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { boatBackend } from "./boat.js";
import type { ComputerRecord } from "../domain/ledger.js";
const record: ComputerRecord = {
  id: "computer",
  companyId: "company",
  environmentId: "environment",
  providerId: "bx_test",
  ledger: {
    controllerId: "controller",
    status: "attached",
    secretRef: { type: "secret_ref", secretId: "secret" },
    owners: [],
    placements: {},
    action: null,
  },
};
const json = (value: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
describe("Boat transport validation", () => {
  it("recognizes idle as an already running computer", async () => {
    const fetcher = vi.fn(async () =>
      json({
        sandbox: { id: "bx_test", state: "idle", snapshots: true, stop: null },
      }),
    );
    await boatBackend(async () => "secret", fetcher).ready(record);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects another physical ID and snapshot-disabled computers", async () => {
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_wrong", state: "idle", snapshots: true } }),
        ),
      ).inspect(record),
    ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ sandbox: { id: "bx_test", state: "idle", snapshots: false } }),
        ),
      ).ready(record),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("keeps port credentials out of the WSS URL and does not forward API authorization to the hosting origin", async () => {
    const fetcher = vi.fn(async (url: any, options?: any) =>
      String(url).startsWith("https://boat.dev/")
        ? json({
            url: "https://test.on.boat.dev/?_token=private-token",
            access: "private",
          })
        : new Response(null, {
            status: 302,
            headers: {
              "set-cookie": "_port_auth=private-cookie; Secure; HttpOnly",
            },
          }),
    );
    const endpoint = await boatBackend(
      async () => "api-secret",
      fetcher,
    ).ingress(record, 43127, "/runner/ws");
    expect(endpoint).toEqual({
      url: "wss://test.on.boat.dev/runner/ws",
      secretHeaders: { Cookie: "_port_auth=private-cookie" },
    });
    expect(fetcher.mock.calls[1]![1].headers).toBeUndefined();
    expect(fetcher.mock.calls[1]![1].redirect).toBe("manual");
  });
  it("refuses public ports and arbitrary hosting origins", async () => {
    for (const url of [
      "http://test.on.boat.dev/?_token=x",
      "https://evil.example/?_token=x",
    ])
      await expect(
        boatBackend(
          async () => "secret",
          vi.fn(async () => json({ url, access: "private" })),
        ).preview(record, 5173),
      ).rejects.toMatchObject({ code: "provider_error" });
    await expect(
      boatBackend(
        async () => "secret",
        vi.fn(async () =>
          json({ url: "https://test.on.boat.dev/", access: "public" }),
        ),
      ).preview(record, 5173),
    ).rejects.toMatchObject({ code: "provider_error" });
  });
});

const roots: string[] = [];
function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-files-")));
  roots.push(temp);
  const root = join(temp, "home");
  const call = (input: Record<string, unknown>) => {
    const result = spawnSync(
      "python3",
      ["-c", remoteProgram.replaceAll("/home/user/paperclip/", `${temp}/`)],
      { input: JSON.stringify({ ...input, root }), encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, temp, call };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("confined computer files", () => {
  it("seeds absent home only and preserves existing content", () => {
    const f = fixture();
    expect(
      f.call({
        action: "seed",
        files: { "nested/one": Buffer.from("first").toString("base64") },
      }),
    ).toEqual({ seeded: true });
    expect(
      f.call({
        action: "seed",
        files: { "nested/one": Buffer.from("overwrite").toString("base64") },
      }),
    ).toEqual({ seeded: false });
    expect(
      Buffer.from(
        f.call({ action: "read", path: "nested/one" }).base64,
        "base64",
      ).toString(),
    ).toBe("first");
  });
  it("rejects traversal, symlink escapes, and oversized reads", () => {
    const f = fixture();
    f.call({
      action: "seed",
      files: { ok: Buffer.from("12345").toString("base64") },
    });
    mkdirSync(join(f.temp, "outside"));
    writeFileSync(join(f.temp, "outside", "secret"), "private");
    symlinkSync(join(f.temp, "outside"), join(f.root, "escape"));
    expect(f.call({ action: "read", path: "../outside/secret" })).toEqual({
      error: "invalid",
    });
    expect(f.call({ action: "read", path: "escape/secret" })).toEqual({
      error: "invalid",
    });
    expect(f.call({ action: "read", path: "ok", maxBytes: 4 })).toEqual({
      error: "invalid",
    });
  });
  it("rejects stale edits and uses no-clobber move semantics", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    const first = f.call({
      action: "write",
      path: "file",
      expectedSha256: null,
      base64: Buffer.from("one").toString("base64"),
    });
    const second = f.call({
      action: "write",
      path: "file",
      expectedSha256: first.sha256,
      base64: Buffer.from("two").toString("base64"),
    });
    expect(
      f.call({
        action: "write",
        path: "file",
        expectedSha256: first.sha256,
        base64: "",
      }),
    ).toEqual({ error: "conflict" });
    expect(
      f.call({
        action: "move",
        path: "file",
        to: "other",
        expectedSha256: second.sha256,
      }),
    ).toEqual({ sha256: second.sha256 });
    expect(f.call({ action: "list" }).entries.map((e: any) => e.name)).toEqual([
      "other",
    ]);
    expect(
      f.call({ action: "remove", path: "other", expectedSha256: first.sha256 }),
    ).toEqual({ error: "conflict" });
  });
  it("bounds directory enumeration and stats files beyond the listing cap", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    for (let i = 0; i < 1005; i++) writeFileSync(join(f.root, `file-${i}`), "content");
    const page = f.call({ action: "list" });
    expect(page.entries).toHaveLength(1000);
    expect(page.truncated).toBe(true);
    const omitted = Array.from({ length: 1005 }, (_, i) => `file-${i}`).find(name => !page.entries.some((entry: { name: string }) => entry.name === name))!;
    expect(f.call({ action: "stat", path: omitted })).toMatchObject({ name: omitted, kind: "file", size: 7 });
    expect(f.call({ action: "list", limit: 2 }).entries).toHaveLength(2);
    expect(f.call({ action: "list", limit: 1001 })).toEqual({ error: "invalid" });
  });
  it.each([false, true])("uses the requested worktree branch separately from its start ref (explicit base: %s)", explicitBase => {
    const f = fixture();
    const checkout = join(f.root, "checkout");
    mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git("init");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "latest");
    const expectedHead = explicitBase ? base : git("rev-parse", "HEAD");
    const input = { action: "workspace", mode: "worktree", taskId: "issue-1", branch: "paperclip/task-issue-1", ...(explicitBase ? { baseRef: base } : {}) };
    const result = f.call(input);
    expect(result.remoteCwd).toBe(join(f.root, "tasks", "issue-1"));
    expect(git("-C", result.remoteCwd, "symbolic-ref", "--short", "HEAD")).toBe(input.branch);
    expect(git("-C", result.remoteCwd, "rev-parse", "HEAD")).toBe(expectedHead);
    writeFileSync(join(result.remoteCwd, "preserved"), "user work");
    expect(f.call({ ...input, branch: "another-branch" })).toEqual({ error: "conflict" });
    expect(git("-C", result.remoteCwd, "status", "--short")).toContain("preserved");
  });
  it("roundtrips binary bytes without interpreting text", () => {
    const f = fixture();
    const bytes = Buffer.from([0, 255, 254, 13, 10, 128]);
    f.call({ action: "seed", files: { binary: bytes.toString("base64") } });
    expect(
      Buffer.from(f.call({ action: "read", path: "binary" }).base64, "base64"),
    ).toEqual(bytes);
  });
});
