import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

const roots: string[] = [];
const providers = [
  { provider: "openai", directory: ".codex", file: "config.toml", conflict: 'model_provider = "other"' },
  { provider: "anthropic", directory: ".claude", file: "settings.json", conflict: '{"apiKeyHelper":"other"}' },
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed AI project authentication", () => {
  it.each(providers)("checks ancestors past a non-directory $directory entry", async (provider) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-auth-"));
    roots.push(root);
    const parent = path.join(root, "parent");
    const cwd = path.join(parent, "workspace");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(parent, provider.directory), "not a configuration directory");

    await expect(assertManagedAiProjectAuth({ cwd }, provider.provider)).resolves.toBeUndefined();

    await mkdir(path.join(root, provider.directory));
    await writeFile(path.join(root, provider.directory, provider.file), provider.conflict);
    await expect(assertManagedAiProjectAuth({ cwd }, provider.provider)).rejects.toMatchObject({
      status: 422,
      details: { code: "ai_connection_incompatible" },
    });
  });

  it.each(providers)("fails closed when $directory configuration cannot be read as a file", async (provider) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-project-auth-"));
    roots.push(root);
    await mkdir(path.join(root, provider.directory, provider.file), { recursive: true });

    await expect(assertManagedAiProjectAuth({ cwd: root }, provider.provider)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
