import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { assertServingArtifact, installedTreeSha256, readUpgradeArtifacts, verifyUpgradeArtifact, type UpgradeArtifact } from "./upgrade-artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const cell = runnerMatrix.find(e => e.id === "everyday-workflows.runner-codex.daytona.recover-controller")!;
async function fixture(revision = "a".repeat(40)): Promise<UpgradeArtifact> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "upgrade-artifact-"))); roots.push(root);
  const cli = join(root, "node_modules/paperclipai");
  const server = join(root, "node_modules/@paperclipai/server");
  for (const directory of [cli, server]) await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(cli, "package.json"), JSON.stringify({ name: "paperclipai", version: "1.2.3", type: "module", bin: { paperclipai: "./dist/index.js" } }));
  await writeFile(join(server, "package.json"), JSON.stringify({ name: "@paperclipai/server", version: "1.2.3", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  await writeFile(join(cli, "dist/index.js"), "// public cli");
  await writeFile(join(server, "dist/index.js"), `// public server ${revision}`);
  await writeFile(join(server, "dist/build-info.json"), JSON.stringify({ commit: revision }));
  const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
  return { root, revision, treeSha256: await installedTreeSha256(root), evidence: "development-build", pins: {
    PAPERCLIP_RUNNER_E2E_INSTALLED_CLI: join(cli, "dist/index.js"),
    PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256: await hash(join(cli, "dist/index.js")),
    PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT: server,
    PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256: await hash(join(server, "dist/index.js")),
  } };
}
it("verifies distinct A/B artifacts and a real serving revision at the same package version", async () => {
  const A = await fixture(); const B = await fixture("b".repeat(40));
  const manifest = join(tmpdir(), `upgrade-${process.pid}-${Date.now()}.json`);
  try {
    await writeFile(manifest, JSON.stringify({ schema: "paperclip.e2e.upgrade-artifacts/v1", artifacts: { A, B }, sequence: ["A", "B", "A"] }));
    expect((await readUpgradeArtifacts(manifest))!.sequence).toEqual(["A", "B", "A"]);
    for (const artifact of [A, B, A]) {
      const verified = await verifyUpgradeArtifact(artifact, {}, [cell]);
      expect(verified.receipt.evidence).toBe("development-build");
      expect(() => assertServingArtifact({ status: "ok", commit: artifact.revision }, verified.receipt)).not.toThrow();
      expect(() => assertServingArtifact({ status: "ok" }, verified.receipt)).toThrow("serving server revision");
      expect(() => assertServingArtifact({ status: "ok", commit: "c".repeat(40) }, verified.receipt)).toThrow("serving server revision");
    }
    await writeFile(manifest, JSON.stringify({ schema: "paperclip.e2e.upgrade-artifacts/v1", artifacts: { A, B: A }, sequence: ["A", "B", "A"] }));
    await expect(readUpgradeArtifacts(manifest)).rejects.toThrow("genuinely different");
  } finally { await rm(manifest, { force: true }); }
});
it("detects changed transitive files even when CLI and server entrypoint hashes are unchanged", async () => {
  const artifact = await fixture();
  await writeFile(join(artifact.root, "node_modules/transitive.js"), "changed migration or runtime");
  await expect(verifyUpgradeArtifact(artifact, {}, [cell])).rejects.toThrow("frozen tree");
});
it("rejects source checkouts, escaping links and a false build stamp", async () => {
  const artifact = await fixture(); const other = await fixture("b".repeat(40));
  await symlink(other.root, join(artifact.root, "foreign"));
  await expect(installedTreeSha256(artifact.root)).rejects.toThrow("escapes");
  await rm(join(artifact.root, "foreign"));
  await mkdir(join(artifact.root, ".git"));
  await expect(installedTreeSha256(artifact.root)).rejects.toThrow("outside a source checkout");
  await rm(join(artifact.root, ".git"), { recursive: true });
  await expect(verifyUpgradeArtifact({ ...artifact, revision: other.revision }, {}, [cell])).rejects.toThrow("build stamp");
});
