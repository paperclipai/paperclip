import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalGeneratedReportAsset, isTrustedGeneratedReportAsset } from "./manual-private-report-assets.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import { validateSealedInventory } from "./manual-private-transfer.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(name = "normalized/assets/InterVariable.woff2") {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-report-asset-")); roots.push(root);
  const source = path.join(root, "source"), bytes = await readFile(canonicalGeneratedReportAsset(name)!);
  await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), bytes);
  const context = { root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] } as ManualPrivateHandoff;
  return { root, source, name, bytes, context };
}
it.each(["normalized/assets/InterVariable.woff2", "html/trace/playwright-logo.svg"])("default cell/result admission still rejects %s", async name => {
  const f = await fixture(name); await expect(sealManualResultEvidence(f.context, [], f.source)).rejects.toThrow("Unsupported packaged evidence carrier");
});
it.each(["wrong-path", "tampered", "unknown", "unowned-svg"])("refuses report asset %s without omitting the original", async kind => {
  const f = await fixture();
  if (kind === "tampered") await writeFile(path.join(f.source, f.name), Buffer.concat([f.bytes, Buffer.from("changed")]));
  else { const name = kind === "wrong-path" ? "normalized/assets/other.woff2" : kind === "unknown" ? "html/trace/unknown.bin" : "normalized/assets/other.svg"; await mkdir(path.dirname(path.join(f.source, name)), { recursive: true }); await writeFile(path.join(f.source, name), f.bytes); }
  await expect(sealManualResultEvidence(f.context, [], f.source, "generated-report")).rejects.toThrow("Unsupported packaged evidence carrier");
  expect(await readFile(path.join(f.source, f.name))).toBeInstanceOf(Buffer);
});
it("checks registered roots even in an authenticated canonical binary", async () => {
  const f = await fixture(); await expect(sealManualResultEvidence(f.context, ["wOF2"], f.source, "generated-report")).rejects.toThrow("Secret leak");
});
it("revalidates canonical content identity after an attacker recomputes the inventory hash", async () => {
  const f = await fixture(); await sealManualResultEvidence(f.context, [], f.source, "generated-report");
  const directory = path.join(f.root, "sealed-results/html-report"), inventoryPath = path.join(f.root, "sealed-results/result-evidence-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8")), changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1;
  await writeFile(path.join(directory, f.name), changed); inventory.files[0].sha256 = createHash("sha256").update(changed).digest("hex");
  inventory.inventorySha256 = createHash("sha256").update(JSON.stringify(inventory.files)).digest("hex"); await writeFile(inventoryPath, JSON.stringify(inventory));
  await expect(validateSealedInventory(directory, "../result-evidence-inventory.json", undefined, "generated-report")).rejects.toThrow("Invalid original evidence inventory row");
});
it("rejects map/watch/traversal and foreign asset owners", async () => {
  for (const name of ["html/trace/../InterVariable.woff2", "html/trace/assets/xtermModule.js", "html/trace/index.js.map", "html/trace/watch.js", "normalized/assets/other.woff2", "snapshots/private.db"])
    expect(await isTrustedGeneratedReportAsset(name, Buffer.from("synthetic"))).toBe(false);
});
it.each(["tampered-index", "watch", "xterm"])("sealer rejects standard-extension trace owner bypass %s", async kind => {
  const f = await fixture("html/trace/index.html");
  if (kind === "tampered-index") await writeFile(path.join(f.source, f.name), Buffer.concat([f.bytes, Buffer.from("<!-- synthetic changed static producer -->")]));
  else { const name = kind === "watch" ? "html/trace/watch.js" : "html/trace/assets/xtermModule.synthetic.js"; await mkdir(path.dirname(path.join(f.source, name)), { recursive: true }); await writeFile(path.join(f.source, name), "synthetic unapproved script"); }
  await expect(sealManualResultEvidence(f.context, [], f.source, "generated-report")).rejects.toThrow("Unsupported packaged evidence carrier");
});
it.each(["tampered-index", "watch", "xterm"])("validator rejects a rehashed standard-extension trace owner bypass %s", async kind => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-trace-owner-")); roots.push(root);
  const name = kind === "tampered-index" ? "html/trace/index.html" : kind === "watch" ? "html/trace/watch.js" : "html/trace/assets/xtermModule.synthetic.js";
  const data = kind === "tampered-index" ? Buffer.concat([await readFile(canonicalGeneratedReportAsset(name)!), Buffer.from("<!-- synthetic changed static producer -->")]) : Buffer.from("synthetic unapproved script");
  await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), data);
  const files = [{ path: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }];
  await writeFile(path.join(root, "inventory.json"), JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL, treeKind: "generated-report", complete: true, sourceBytes: data.length, files, inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") }));
  await expect(validateSealedInventory(root, "inventory.json", undefined, "generated-report")).rejects.toThrow("Invalid original evidence inventory row");
});
