import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { remoteProgram } from "./remote-program.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { boatBackend, desktopReadinessProgram, processProgram } from "./boat.js";
import { buildGitAuthInvocation } from "../../../services/git-credentials.js";
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
  const call = (input: Record<string, unknown>, env = process.env) => {
    const result = spawnSync(
      "python3",
      ["-c", remoteProgram.replaceAll("/home/user/paperclip/", `${temp}/`)],
      { input: JSON.stringify({ ...input, root }), encoding: "utf8", env },
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
  it("publishes bounded seed chunks atomically and aborts partial homes", () => {
    const f = fixture(); const seedId = randomUUID();
    expect(f.call({ action: "seed-begin", seedId })).toEqual({ started: true });
    const chunk = Buffer.alloc(1024 * 1024, 19);
    for (const offset of [0, chunk.length]) expect(f.call({ action: "seed-chunk", seedId, path: "memory/data", offset, base64: chunk.toString("base64") })).toEqual({});
    expect(existsSync(f.root)).toBe(false);
    const staging = readdirSync(f.temp).find(name => name.startsWith(".paperclip-seed-"))!;
    expect(statSync(join(f.temp, staging)).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.temp, staging, "tree", "memory", "data")).mode & 0o777).toBe(0o600);
    expect(f.call({ action: "seed-chunk", seedId, path: "memory/data", offset: 0, base64: "" })).toEqual({ error: "conflict" });
    expect(f.call({ action: "seed-commit", seedId })).toEqual({ seeded: true });
    expect(readFileSync(join(f.root, "memory", "data"))).toEqual(Buffer.concat([chunk, chunk]));
    expect(readdirSync(f.temp)).toEqual(["home"]);
    expect(f.call({ action: "seed-begin", seedId: randomUUID() })).toEqual({ started: false });
    const g = fixture(); const partial = randomUUID();
    g.call({ action: "seed-begin", seedId: partial });
    expect(g.call({ action: "seed-chunk", seedId: partial, path: "../escape", offset: 0, base64: "" })).toEqual({ error: "invalid" });
    expect(g.call({ action: "seed-chunk", seedId: partial, path: "large", offset: 0, base64: Buffer.alloc(1024 * 1024 + 1).toString("base64") })).toEqual({ error: "invalid" });
    expect(g.call({ action: "seed-abort", seedId: partial })).toEqual({});
    expect(existsSync(g.root)).toBe(false);
    expect(readdirSync(g.temp)).toEqual([]);
  });
  it("does not replace a home created while its initial upload was in progress", () => {
    const f = fixture(); const seedId = randomUUID();
    f.call({ action: "seed-begin", seedId });
    f.call({ action: "seed-chunk", seedId, path: "initial", offset: 0, base64: Buffer.from("staged").toString("base64") });
    mkdirSync(f.root);
    expect(f.call({ action: "seed-commit", seedId })).toEqual({ seeded: false });
    expect(readdirSync(f.root)).toEqual([]);
    expect(readdirSync(f.temp)).toEqual(["home"]);
  });
  it("hashes and deletes files over the read limit while fencing changed bytes", () => {
    const f = fixture();
    f.call({ action: "seed", files: {} });
    const bytes = Buffer.alloc(17 * 1024 * 1024, 7);
    writeFileSync(join(f.root, "large.bin"), bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(f.call({ action: "read", path: "large.bin" })).toEqual({ error: "invalid" });
    expect(f.call({ action: "hash", path: "large.bin" })).toEqual({ sha256: expected, size: bytes.length });
    bytes[0] = 8;
    writeFileSync(join(f.root, "large.bin"), bytes);
    expect(f.call({ action: "remove", path: "large.bin", expectedSha256: expected })).toEqual({ error: "conflict" });
    const current = f.call({ action: "hash", path: "large.bin" });
    expect(current.sha256).not.toBe(expected);
    expect(f.call({ action: "remove", path: "large.bin", expectedSha256: current.sha256 })).toEqual({});
    expect(f.call({ action: "hash", path: "large.bin" })).toEqual({ error: "not_found" });
    symlinkSync(join(f.temp, "outside"), join(f.root, "escape"));
    expect(f.call({ action: "hash", path: "escape" })).toEqual({ error: "invalid" });
    expect(f.call({ action: "hash", path: "../outside" })).toEqual({ error: "invalid" });
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
  it("clones a private checkout with operation-scoped auth and leaves no credential material behind", () => {
    const f = fixture();
    const source = join(f.temp, "source");
    mkdirSync(source);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    for (const args of [["init"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base"]]) {
      expect(spawnSync(realGit, args, { cwd: source, encoding: "utf8" }).status).toBe(0);
    }
    const bin = join(f.temp, "bin");
    mkdirSync(bin);
    // Stand in for an authenticated GitHub transport, using real Git and the
    // production URL-scoped credential helper, without any external network.
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2), clone=args.indexOf("clone");
if(clone<0) process.exit(9);
if(args.some(arg=>arg.includes("scoped-fixture-token"))) process.exit(10);
const credential=spawnSync(process.env.FIXTURE_REAL_GIT,[...args.slice(0,clone),"credential","fill"],{input:"protocol=https\\nhost=github.com\\n\\n",encoding:"utf8"});
if(credential.status!==0||!credential.stdout.includes("password=scoped-fixture-token")) process.exit(11);
args[clone+2]=process.env.FIXTURE_SOURCE;
const result=spawnSync(process.env.FIXTURE_REAL_GIT,args,{encoding:"utf8"});
process.stdout.write(result.stdout||"");process.stderr.write(result.stderr||"");process.exit(result.status??1);
`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_REAL_GIT: realGit, FIXTURE_SOURCE: source };
    const request = { action: "workspace", mode: "shared", repositoryUrl: "https://github.com/company/private.git" };
    expect(f.call(request, env)).toEqual({ error: "command_failed" });
    const gitAuth = buildGitAuthInvocation({ token: "scoped-fixture-token", source: "managed_connection", secretName: null });
    const result = f.call({ ...request, gitAuth }, env);
    expect(result.remoteCwd).toBe(join(f.root, "checkout"));
    const config = readFileSync(join(result.remoteCwd, ".git", "config"), "utf8");
    expect(config).not.toContain("scoped-fixture-token");
    expect(config).not.toContain("credential");
    expect(spawnSync(realGit, ["rev-parse", "HEAD"], { cwd: result.remoteCwd }).status).toBe(0);
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


describe("retired owner spool cleanup after provider resume", () => {
  function cleanupFixture(state = "inactive") {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-retired-")));
    roots.push(temp);
    const owners = join(temp, "owners");
    const bin = join(temp, "bin");
    const calls = join(temp, "systemctl-calls");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in *show*) printf '%s\\n' '${state}';; esac
`, { mode: 0o700 });
    const owner = (id: string, generation = 7) => {
      const root = join(owners, id);
      mkdirSync(join(root, "command-one"), { recursive: true });
      writeFileSync(join(root, "generation"), String(generation));
      writeFileSync(join(root, "command-one", "stdin"), "private command input", { mode: 0o600 });
      writeFileSync(join(root, "preserve"), "ownership metadata");
      return root;
    };
    const cleanup = (input = [{ id: "retired-owner", generation: 7 }]) => spawnSync(
      "python3", ["-c", processProgram.replaceAll("/home/user/.paperclip-owners", owners)],
      { input: JSON.stringify({ action: "cleanup-retired", owners: input }), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    return { temp, owners, calls, owner, cleanup };
  }

  it("reaps only recorded retired command spools and is idempotent", () => {
    const f = cleanupFixture();
    const retired = f.owner("retired-owner");
    const active = f.owner("active-owner");
    const outside = join(f.temp, "user-files");
    mkdirSync(outside);
    writeFileSync(join(outside, "preserve"), "user data");
    symlinkSync(outside, join(retired, "command-symlink"));
    expect(f.cleanup().status).toBe(0);
    expect(existsSync(join(retired, "command-one"))).toBe(false);
    expect(existsSync(join(retired, "retired"))).toBe(true);
    expect(readFileSync(join(retired, "preserve"), "utf8")).toBe("ownership metadata");
    expect(readFileSync(join(active, "command-one", "stdin"), "utf8")).toBe("private command input");
    expect(readFileSync(join(outside, "preserve"), "utf8")).toBe("user data");
    const calls = readFileSync(f.calls, "utf8");
    expect(calls).toContain("--user stop paperclip-retired-owner.slice paperclip-retired-owner.service");
    expect(calls).not.toContain("active-owner");
    expect(f.cleanup().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(calls);
  });

  it("preserves spools when retirement cannot be confirmed", () => {
    const f = cleanupFixture("active");
    const retired = f.owner("retired-owner");
    const result = f.cleanup();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("process retirement unconfirmed");
    expect(existsSync(join(retired, "command-one", "stdin"))).toBe(true);
  });

  it("rejects a stale generation without stopping its current process", () => {
    const f = cleanupFixture();
    const retired = f.owner("retired-owner", 8);
    expect(JSON.parse(f.cleanup().stdout)).toEqual({ error: "conflict" });
    expect(existsSync(join(retired, "command-one", "stdin"))).toBe(true);
    expect(existsSync(f.calls)).toBe(false);
  });

  it("rejects symlink owner roots and ignores missing retired roots", () => {
    const f = cleanupFixture();
    const active = f.owner("active-owner");
    symlinkSync(active, join(f.owners, "retired-owner"));
    expect(f.cleanup().stderr).toContain("invalid retired owner directory");
    expect(existsSync(join(active, "command-one", "stdin"))).toBe(true);
    expect(f.cleanup([{ id: "missing-owner", generation: 7 }]).status).toBe(0);
    expect(existsSync(f.calls)).toBe(false);
  });
});


describe("Boat desktop input readiness", () => {
  function desktopFixture(initiallyHealthy: boolean) {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "computer-desktop-")));
    roots.push(temp);
    const runtime = join(temp, String(process.getuid!()));
    const bin = join(temp, "bin");
    const healthy = join(temp, "healthy");
    const calls = join(temp, "repairs");
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(bin);
    if (initiallyHealthy) writeFileSync(healthy, "ready");
    writeFileSync(join(bin, "ibus"), "#!/bin/sh\ntest \"$HOME\" = /home/user && test \"$XDG_CONFIG_HOME\" = /home/user/.config && test \"$XDG_CACHE_HOME\" = /home/user/.cache || exit 1\nprintf '%s\\n' 'unix:path=/test/ibus'\n", { mode: 0o700 });
    writeFileSync(join(bin, "gdbus"), `#!/bin/sh\ntest -f '${healthy}'\n`, { mode: 0o700 });
    writeFileSync(join(bin, "ibus-daemon"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ntouch '${healthy}'\n`, { mode: 0o700 });
    const call = (program = desktopReadinessProgram) => spawnSync("python3", ["-c", program.replaceAll("/run/user/", `${temp}/`)], {
      encoding: "utf8", env: { ...process.env, HOME: join(temp, "agent-home"), XDG_CONFIG_HOME: join(temp, "agent-config"), XDG_CACHE_HOME: join(temp, "agent-cache"), PATH: `${bin}:${process.env.PATH}` },
    });
    return { temp, runtime, healthy, calls, call };
  }

  it("preserves a healthy input service and emits no MCP protocol output", () => {
    const f = desktopFixture(true);
    const result = f.call();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(f.calls)).toBe(false);
  });

  it("repairs a disconnected restored socket and checks it again after another resume", () => {
    const f = desktopFixture(false);
    expect(f.call().status).toBe(0);
    const expected = `--replace --daemonize --xim --address unix:path=${f.runtime}/paperclip-ibus/bus\n`;
    expect(readFileSync(f.calls, "utf8")).toBe(expected);
    expect(f.call().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(expected);
    rmSync(f.healthy);
    expect(f.call().status).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe(expected.repeat(2));
  });

  it("rejects a symlink input directory without replacing the daemon", () => {
    const f = desktopFixture(false);
    symlinkSync(f.temp, join(f.runtime, "paperclip-ibus"));
    const result = f.call();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid desktop input directory");
    expect(existsSync(f.calls)).toBe(false);
  });

  it("executes the existing Cua MCP process only after input readiness", () => {
    const f = desktopFixture(false);
    const tool = boatBackend(async () => "unused").computerTool();
    const cua = join(f.temp, "cua");
    writeFileSync(cua, `#!/bin/sh\nprintf '%s\\n' "$*"\n`, { mode: 0o700 });
    expect(tool.command).toBe("python3");
    const result = f.call(tool.args[1]!.replaceAll("/opt/ascii/cua-driver/cua-driver", cua));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("mcp --socket /run/ascii-cua/driver.sock\n");
    expect(existsSync(f.healthy)).toBe(true);
  });
});
