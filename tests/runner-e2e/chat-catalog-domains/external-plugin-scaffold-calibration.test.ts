import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { createPreviewFixture } from "./external-plugin-fixture.js";

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_PLUGIN_SCAFFOLD_CALIBRATION !== "1")("qualifies the actual source CLI scaffold with explicit owned SDK custody and no build or pack", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-cli-offline-control-"));
  const previousPath = process.env.PATH;
  let fixture: Awaited<ReturnType<typeof createPreviewFixture>> | undefined;
  try {
    const bin = path.join(root, "bin"); await mkdir(bin);
    const called = path.join(root, "unexpected-pnpm-call");
    await writeFile(path.join(bin, "pnpm"), `#!/bin/sh\nprintf invoked > '${called}'\nexit 91\n`, { mode: 0o700 });
    const cli = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
    const sourceSdk = fileURLToPath(new URL("../../../packages/plugins/sdk/", import.meta.url));
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const cliBefore = hash(await readFile(cli));
    const original = { failed: false, missingCheckoutDependency: false };
    try {
      await promisify(execFile)(process.execPath, [cli, "plugin", "init", "@paperclip-eval/default-sdk-control", "--output", root], {
        cwd: root, timeout: 30_000, maxBuffer: 256_000, env: { HOME: root, PATH: bin, NODE_ENV: "test", DO_NOT_TRACK: "1", PAPERCLIP_TELEMETRY_DISABLED: "1" },
      });
    } catch (error) {
      original.failed = true;

      original.missingCheckoutDependency = /ERR_MODULE_NOT_FOUND/.test(String((error as { stderr?: string }).stderr)) && /Cannot find package 'zod'/.test(String((error as { stderr?: string }).stderr));
    }
    expect(original).toEqual({ failed: true, missingCheckoutDependency: true });
    let evidence: { sdkMirror: { files: Array<{ path: string; sha256: string }> } } | undefined;
    process.env.PATH = bin;
    const ctx = { input: { nonce: "offline-cli-calibration", evidence: async (_name: string, value: unknown) => { evidence = value as typeof evidence; } } } as unknown as ChatCatalogContext;
    fixture = await createPreviewFixture(ctx);
    expect(JSON.parse(await readFile(path.join(fixture.packageRoot, "package.json"), "utf8"))).toMatchObject({ name: "@paperclip-eval/website-preview" });
    expect(evidence?.sdkMirror.files.length).toBeGreaterThan(1);
    for (const file of evidence!.sdkMirror.files) expect(hash(await readFile(path.join(sourceSdk, file.path)))).toBe(file.sha256);
    expect(hash(await readFile(cli))).toBe(cliBefore);
    await expect(access(called)).rejects.toThrow();
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await fixture?.close(); await rm(root, { recursive: true, force: true });
  }
});
