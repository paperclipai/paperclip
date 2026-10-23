import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIsolatedHostAssetDirectory,
  ensureIsolatedHostDirectory,
  readHostFileForAgent,
} from "./isolated-host-file.js";

describe.skipIf(process.platform !== "linux")("isolated host file access", () => {
  const cleanup: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME: "true",
    PAPERCLIP_SECRETS_HOST_AGENT_UID: String((process.getuid?.() ?? 0) + 10_000),
  };

  afterEach(async () => {
    while (cleanup.length) await fs.rm(cleanup.pop()!, { recursive: true, force: true });
  });

  async function fixture() {
    const root = await fs.mkdtemp(path.join(process.cwd(), ".isolated-host-file-test-"));
    cleanup.push(root);
    const source = path.join(root, "source");
    const privateDir = path.join(root, "private");
    await fs.mkdir(source, { mode: 0o700 });
    await fs.mkdir(privateDir, { mode: 0o700 });
    const key = path.join(privateDir, "master.key");
    await fs.writeFile(key, "synthetic-master-key", { mode: 0o600 });
    return { root, source, key };
  }

  it("reads an immutable regular instruction file and preserves non-isolated compatibility", async () => {
    const { source, key } = await fixture();
    const instruction = path.join(source, "AGENTS.md");
    await fs.writeFile(instruction, "ordinary instructions", { mode: 0o600 });
    await expect(readHostFileForAgent(instruction, "utf8", env)).resolves.toBe("ordinary instructions");
    await fs.symlink(key, path.join(source, "alias.md"));
    await expect(readHostFileForAgent(path.join(source, "alias.md"), "utf8", {
      PAPERCLIP_SECRETS_REQUIRE_ISOLATED_AGENT_RUNTIME: "false",
    })).resolves.toBe("synthetic-master-key");
  });

  it("rejects symlinks in both the file and an ancestor before reading key bytes", async () => {
    const { root, source, key } = await fixture();
    const alias = path.join(source, "AGENTS.md");
    await fs.symlink(key, alias);
    await expect(readHostFileForAgent(alias, "utf8", env)).rejects.toThrow();
    await fs.symlink(source, path.join(root, "source-alias"));
    await expect(readHostFileForAgent(path.join(root, "source-alias", "AGENTS.md"), "utf8", env)).rejects.toThrow();
  });

  it("rejects an agent-writable source and a planted cached asset symlink", async () => {
    const { root, source, key } = await fixture();
    const instruction = path.join(source, "AGENTS.md");
    await fs.writeFile(instruction, "ordinary instructions", { mode: 0o600 });
    await fs.chmod(source, 0o770);
    await expect(readHostFileForAgent(instruction, "utf8", env)).rejects.toThrow(/agent-immutable/);
    await fs.chmod(source, 0o700);
    const cache = path.join(root, "cache");
    await ensureIsolatedHostDirectory(cache, env);
    await fs.symlink(key, path.join(cache, "CLAUDE.md"));
    await expect(assertIsolatedHostAssetDirectory(cache, env)).rejects.toThrow();
  });
});
