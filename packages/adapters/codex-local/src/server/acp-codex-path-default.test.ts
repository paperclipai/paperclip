import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCodexAppServerCodexPathDefault } from "./acp.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalCodexPath = process.env.CODEX_PATH;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-path-default-"));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath: string, content: string | Buffer): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalCodexPath === undefined) delete process.env.CODEX_PATH;
  else process.env.CODEX_PATH = originalCodexPath;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("withCodexAppServerCodexPathDefault", () => {
  it("keeps an explicit adapter-config CODEX_PATH", async () => {
    const config = { env: { CODEX_PATH: "/custom/codex" } };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });

  it("keeps config untouched when the host env already sets CODEX_PATH", async () => {
    process.env.CODEX_PATH = "/host/codex";
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });

  it("does not set CODEX_PATH for remote execution targets", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    await writeExecutable(path.join(dir, "codex"), "#!/usr/bin/env node\n");
    process.env.PATH = dir;
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {
      executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/remote/work" } as never,
    });
    expect(result).toBe(config);
  });

  it("resolves a node-script Codex CLI from PATH for local targets", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    const codex = path.join(dir, "codex");
    await writeExecutable(codex, "#!/usr/bin/env node\nconsole.log('codex');\n");
    process.env.PATH = dir;
    const result = await withCodexAppServerCodexPathDefault({ agent: "codex" }, {});
    expect((result.env as Record<string, string>).CODEX_PATH).toBe(codex);
  });

  it("skips shell wrapper shims and picks a later real Codex on PATH", async () => {
    delete process.env.CODEX_PATH;
    const shimDir = await makeTempDir();
    const realDir = await makeTempDir();
    // Terminal-multiplexer style shim: a bash wrapper that execs `codex`.
    await writeExecutable(path.join(shimDir, "codex"), "#!/usr/bin/env bash\nexec codex \"$@\"\n");
    const realCodex = path.join(realDir, "codex");
    await writeExecutable(realCodex, "#!/usr/bin/env node\n");
    process.env.PATH = `${shimDir}${path.delimiter}${realDir}`;
    const result = await withCodexAppServerCodexPathDefault({ agent: "codex" }, {});
    expect((result.env as Record<string, string>).CODEX_PATH).toBe(realCodex);
  });

  it("accepts symlinks and compiled binaries as Codex candidates", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    const target = path.join(dir, "codex.js");
    await writeExecutable(target, "#!/usr/bin/env node\n");
    const link = path.join(dir, "codex");
    await fs.symlink(target, link);
    process.env.PATH = dir;
    const result = await withCodexAppServerCodexPathDefault({ agent: "codex" }, {});
    expect((result.env as Record<string, string>).CODEX_PATH).toBe(link);
  });

  it("leaves config untouched when no Codex CLI is on PATH", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    process.env.PATH = dir;
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });

  it("skips non-executable files named codex", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "codex"), "#!/usr/bin/env node\n", { mode: 0o644 });
    process.env.PATH = dir;
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });

  it("skips symlinks that target a shell wrapper", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    const wrapper = path.join(dir, "codex-wrapper.sh");
    await writeExecutable(wrapper, "#!/usr/bin/env bash\nexec codex \"$@\"\n");
    await fs.symlink(wrapper, path.join(dir, "codex"));
    process.env.PATH = dir;
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });

  it("skips broken symlinks named codex", async () => {
    delete process.env.CODEX_PATH;
    const dir = await makeTempDir();
    await fs.symlink(path.join(dir, "does-not-exist.js"), path.join(dir, "codex"));
    process.env.PATH = dir;
    const config = { agent: "codex" };
    const result = await withCodexAppServerCodexPathDefault(config, {});
    expect(result).toBe(config);
  });
});
