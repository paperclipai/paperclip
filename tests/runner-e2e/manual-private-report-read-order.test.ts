import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const state = vi.hoisted(() => ({ target: "", reads: [] as string[], oversized: false }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === state.target) { state.reads.push(state.target); throw new Error("Forbidden body read before admission"); }
      return actual.readFile(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const result = await actual.lstat(...args);
      return state.oversized && String(args[0]) === state.target ? new Proxy(result, { get(object, key) { return key === "size" ? 256 * 1024 * 1024 + 1 : Reflect.get(object, key); } }) : result;
    },
  };
});
import { validateSealedInventory } from "./manual-private-transfer.js";
import { sealManualResultEvidence, type ManualPrivateHandoff } from "./manual-private-handoff.js";
import { MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
const roots: string[] = [];
afterEach(async () => { state.target = ""; state.reads = []; state.oversized = false; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each(["unknown", "oversized-canonical", "oversized-standard"])("rejects %s before materializing its body", async kind => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "synthetic-report-read-order-"))); roots.push(root);
  const source = path.join(root, "source"), name = kind === "unknown" ? "unknown.bin" : kind === "oversized-canonical" ? "normalized/assets/InterVariable.woff2" : "report.log";
  state.target = path.join(source, name); state.oversized = kind !== "unknown";
  await mkdir(path.dirname(state.target), { recursive: true }); await writeFile(state.target, "synthetic small bytes; size only mocked");
  const context = { root, protocol: MANUAL_PRIVATE_PROTOCOL, private: true, workflowSha: "a".repeat(40), targetSha: "b".repeat(40), runId: "123", attempt: "1", executionIds: [MANUAL_PRIVATE_EXECUTIONS[0]!] } as ManualPrivateHandoff;
  await expect(sealManualResultEvidence(context, [], source, "generated-report")).rejects.toThrow(kind === "unknown" ? "Unsupported packaged evidence carrier" : "Complete packaged evidence exceeds allowance");
  expect(state.reads).toEqual([]);
});

it.each(["unknown", "oversized-canonical", "oversized-standard"])("validator rejects %s before materializing its body", async kind => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "synthetic-validator-read-order-"))); roots.push(root);
  const name = kind === "unknown" ? "unknown.bin" : kind === "oversized-canonical" ? "normalized/assets/InterVariable.woff2" : "report.log";
  state.target = path.join(root, name); state.oversized = kind !== "unknown";
  const data = Buffer.from("synthetic small bytes; size only mocked"), size = state.oversized ? 256 * 1024 * 1024 + 1 : data.length;
  await mkdir(path.dirname(state.target), { recursive: true }); await writeFile(state.target, data);
  const files = [{ path: name, bytes: size, sha256: createHash("sha256").update(data).digest("hex") }];
  await writeFile(path.join(root, "inventory.json"), JSON.stringify({ protocol: MANUAL_PRIVATE_PROTOCOL, treeKind: "generated-report", complete: true, sourceBytes: size, files, inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") }));
  await expect(validateSealedInventory(root, "inventory.json", undefined, "generated-report")).rejects.toThrow(kind === "unknown" ? "Invalid original evidence inventory row" : "Original evidence byte accounting changed");
  expect(state.reads).toEqual([]);
});
