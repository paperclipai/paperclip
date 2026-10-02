import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectPiFileEvidence, gradePiCopyback, gradePiFileEvidence, piFileContract, seedPiFile } from "./pi-file-evidence.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent } from "../../packages/paperclip-runner/src/provider-events.js";
import { safeAcpxLocations } from "../../packages/paperclip-runner/src/drivers/acpx/safe-locations.js";
import { classifyFailure } from "./failure-classifier.js";
import { runnerMatrix } from "./catalog.js";

function fixture() {
  const c = piFileContract("fixture"), attachmentId = "12345678-1234-1234-1234-123456789abc";
  const tool = (seq: number, executionId: string, name: string, operation: string, completed: boolean, target: string | null, output = "") => {
    // Pi emits absolute edit locations and uses the bash command as title.
    // Exercise sidecar path normalization followed by the common projection;
    // direct raw ACP projection would incorrectly lose the workspace target.
    const canonical = canonicalProviderEventsFromAcpxRuntimeEvent({ type: "tool_call", toolCallId: executionId,
      tag: completed ? "tool_call_update" : "tool_call", title: name, kind: operation,
      status: completed ? "completed" : "pending", locations: safeAcpxLocations(target ? [{ path: `/workspace/${target}` }] : [], "/workspace", operation, name), rawOutput: output }, executionId, "turn")[0]!;
    return { companyId: "company", runId: "run", seq, protocolSchemaVersion: 1, eventType: canonical.eventType,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: "runner",
        sourceSeq: seq, sourceEventId: `runner:run:${seq}`, runId: "run", turnId: "turn", normalizedSessionId: "session", ...canonical } } };
  };
  return {
    environment: "local" as const, environmentId: "environment", nonce: "fixture", companyId: "company", issueId: "issue", agentId: "agent", attachmentId,
    seed: { schema: "paperclip.e2e.pi-file-seed.v1", filename: c.filename,
      beforeSha256: createHash("sha256").update("ready-fixture\n").digest("hex"), byteSize: Buffer.byteLength(c.before) },
    workspaceBytes: Buffer.from(c.after), downloadedBytes: Buffer.from(c.after),
    run: { id: "run", companyId: "company", agentId: "agent", runtimeMode: "native", nativeSessionId: "session", runnerInstanceId: "runner", status: "succeeded", resultJson: { semanticToolReceipts: {
      publish: { operationId: "register_deliverable", input: { filename: c.filename, contentRef: c.filename, contentType: "text/plain", byteSize: c.byteSize, sha256: c.sha256 },
        result: { disposition: "applied", commandId: `deliverable-prepared:${attachmentId}`, entityRefs: [attachmentId, "product", "comment"] } },
    } } },
    events: [tool(1, "edit", "edit", "edit", false, c.filename), tool(2, "edit", "edit", "edit", true, c.filename),
      tool(3, "validate", c.validationCommand, "execute", false, null), tool(4, "validate", c.validationCommand, "execute", true, null, c.validationMarker)],
    attachments: [{ id: attachmentId, companyId: "company", issueId: "issue", originatingRunId: "run", createdByAgentId: "agent",
      originalFilename: c.filename, contentType: "text/plain", byteSize: c.byteSize, sha256: c.sha256 }],
    activity: [{ action: "issue.attachment_added", companyId: "company", runId: "run", actorId: "agent", entityId: "issue",
      details: { attachmentId, source: "paperclip_runner_protocol" } }],
  };
}
describe("Pi edit, validation and public artifact oracle", () => {
  it("accepts actual correlated lifecycles, independent bytes and a run-bound registered download", () => {
    const result = gradePiFileEvidence(fixture());
    expect(result.passed).toBe(true);
    expect(result.diff.text).toContain("-ready-fixture\n+verified-fixture\n");
    expect(result.limits.join(" ")).toContain("not attested");
    expect(result.verification.providerExecutionStatus).toBe("completed");
    expect(result.verification.commandTitle).toBe(piFileContract("fixture").validationCommand);
    expect(result.verification.nativeFileAttribution).toBe("workspace_relative_display_target");
  });
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["absent seed", f => { f.seed = {} as any; }],
    ["wrong final bytes", f => { f.workspaceBytes = Buffer.from("wrong\n"); }],
    ["final-only write", f => { f.events[0]!.payload.prpEvent.payload.name = "write"; f.events[1]!.payload.prpEvent.payload.name = "write"; }],
    ["missing edit", f => { f.events = f.events.slice(2); }],
    ["missing validation", f => { f.events = f.events.slice(0, 2); }],
    ["echo-only validation", f => { f.events[2]!.payload.prpEvent.payload.name = `echo ${piFileContract("fixture").validationMarker}`; f.events[3]!.payload.prpEvent.payload.name = f.events[2]!.payload.prpEvent.payload.name; }],
    ["failed validation", f => { f.events[3]!.payload.prpEvent.payload.status = "failed"; }],
    ["unfinished validation", f => { f.events.pop(); }],
    ["unrelated validation turn", f => { f.events[2]!.payload.prpEvent.turnId = "other"; f.events[3]!.payload.prpEvent.turnId = "other"; }],
    ["foreign native session", f => { f.run.nativeSessionId = "other"; }],
    ["foreign native producer", f => { f.run.runnerInstanceId = "other"; }],
    ["foreign event run", f => { f.events[1]!.payload.prpEvent.runId = "other"; }],
    ["duplicate event", f => { f.events.push(structuredClone(f.events[3]!)); }],
    ["missing tool start", f => { f.events.splice(2, 1); }],
    ["truncated validation output", f => { f.events[3]!.payload.prpEvent.payload.outputTruncated = true; }],
    ["missing native target", f => { f.events[0]!.payload.prpEvent.payload.target = null; f.events[1]!.payload.prpEvent.payload.target = null; }],
    ["wrong target", f => { f.events[1]!.payload.prpEvent.payload.target = "other.txt"; }],
    ["missing registration", f => { f.run.resultJson.semanticToolReceipts = {} as any; }],
    ["rejected registration", f => { f.run.resultJson.semanticToolReceipts.publish.result.disposition = "denied"; }],
    ["wrong registered hash", f => { f.run.resultJson.semanticToolReceipts.publish.input.sha256 = "wrong"; }],
    ["wrong registered entity", f => { f.run.resultJson.semanticToolReceipts.publish.result.entityRefs[0] = "other"; }],
    ["missing attachment", f => { f.attachments = []; }],
    ["foreign attachment company", f => { f.attachments[0]!.companyId = "other"; }],
    ["stale attachment run", f => { f.attachments[0]!.originatingRunId = "older"; }],
    ["wrong download bytes", f => { f.downloadedBytes = Buffer.from("wrong\n"); }],
    ["missing publication activity", f => { f.activity = []; }],
    ["foreign publication run", f => { f.activity[0]!.runId = "other"; }],
  ];
  it.each(mutations)("rejects %s even when the model claims completion", (_name, change) => {
    const f = fixture(); change(f); expect(() => gradePiFileEvidence(f)).toThrow("Pi file evidence:");
    try { gradePiFileEvidence(f); } catch (error) { expect(classifyFailure(error)).toBe("candidate_failure"); }
  });
  it("keeps real nonce commands within the Rust 240-character name contract", () => {
    const c = piFileContract("0123456789ab-1");
    expect([...c.validationCommand].length).toBeLessThanOrEqual(240);
    expect(safeAcpxLocations([{ path: `/workspace/${c.filename}` }], "/workspace", "edit", "edit")[0]).toMatchObject({
      path: c.filename, pathBoundary: "paperclip.workspace_relative_display.v2",
    });
    expect(() => piFileContract("a".repeat(100))).toThrow("native Rust tool-name bound");
  });
  it("runs the exact fixture validation command and rejects plausible wrong bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-validation-command-"));
    const c = piFileContract("0123456789ab-1");
    const validate = () => promisify(execFile)("/bin/sh", ["-c", c.validationCommand], {
      cwd: root, timeout: 3_000, maxBuffer: 4096, env: { PATH: dirname(process.execPath) },
    });
    try {
      await writeFile(join(root, c.filename), c.after);
      expect((await validate()).stdout).toBe(`${c.validationMarker}\n`);
      await writeFile(join(root, c.filename), c.after.trimEnd());
      await expect(validate()).rejects.toMatchObject({ code: 1 });
      await rm(join(root, c.filename));
      await expect(validate()).rejects.toMatchObject({ code: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("changes only Pi file prompts and keeps all four question methods", () => {
    const cells = runnerMatrix.filter(c => c.suite.id === "extended-harnesses" && c.task.id === "file-edit-validate");
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      const prompt = cell.task.buildPrompt("fixture");
      expect(prompt.includes("register_deliverable")).toBe(cell.profile.qualificationCandidate === "pi");
    }
    expect(runnerMatrix.filter(c => c.profile.qualificationCandidate === "pi")).toHaveLength(26);
  });
  it.each(["local", "daytona"] as const)("seeds once and collects public %s evidence", async environment => {
    const root = await mkdtemp(join(tmpdir(), "pi-file-evidence-"));
    try {
      const seed = await seedPiFile(root, "fixture"), f = environment === "daytona" ? copyback() : fixture(), c = piFileContract("fixture");
      expect(await readFile(join(root, c.filename), "utf8")).toBe(c.before);
      await expect(seedPiFile(root, "fixture")).rejects.toThrow();
      await writeFile(join(root, c.filename), c.after);
      const get = vi.fn(async (path: string) => {
        if (path === "/api/heartbeat-runs/run") return f.run;
        if (path === "/api/environment-leases/lease" && "lease" in f) return f.lease;
        if (path.endsWith("/attachments")) return f.attachments;
        if (path.endsWith("/activity")) return f.activity;
        throw new Error("Unexpected route");
      });
      const download = vi.fn(async () => ({ ok: () => true, body: async () => f.downloadedBytes }));
      const visible = vi.fn(async () => {}), evidence = vi.fn(async () => {});
      const proof = await collectPiFileEvidence({ ...f, seed, workspace: root, evidence,
        api: { get, request: { get: download } } as any,
        page: { locator: () => ({ first: () => ({ waitFor: visible }) }) } as any });
      expect(proof.passed).toBe(true);
      if (environment === "daytona") {
        expect(get).toHaveBeenCalledWith("/api/heartbeat-runs/run");
        expect(get).toHaveBeenCalledWith("/api/environment-leases/lease");
        expect(proof.workspaceProvenance.kind).toBe("product_copyback");
      }
      expect(visible).toHaveBeenCalledOnce();
      expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ workspaceBytes: f.workspaceBytes.toString("base64"), downloadedBytes: f.downloadedBytes.toString("base64") }));
      expect(download).toHaveBeenCalledWith(`/api/attachments/${f.attachmentId}/content`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

function copyback() {
  const f = fixture();
  const reference = { schema: "paperclip.native-workspace-sync/v2", state: "finalized", baselineSha256: "a".repeat(64),
    descriptorSha256: "b".repeat(64), finalHostSha256: "c".repeat(64), workspaceId: "workspace", leaseId: "lease",
    providerLeaseId: "sandbox", remoteCwd: "/workspace" };
  const run = { ...f.run, contextSnapshot: { executionWorkspaceId: "workspace", paperclipEnvironment: { id: "environment", driver: "sandbox", leaseId: "lease" } },
    runnerProfileJson: { nativeWorkspaceSync: reference, nativeExecutionInput: { binding: { executionWorkspaceId: "workspace" } } } };
  const lease = { id: "lease", companyId: "company", environmentId: "environment", heartbeatRunId: "run", provider: "daytona", providerLeaseId: "sandbox", metadata: { remoteCwd: "/workspace" } };
  return { ...f, run, lease, environment: "daytona" as const };
}
it("accepts public finalized same-run copy-back attribution without claiming guest observation", () => {
  const f = copyback();
  expect(gradePiFileEvidence(f).workspaceProvenance).toMatchObject({ kind: "product_copyback", guestObservation: false, hostSnapshotRecomputed: false });
});
it.each([
  ["missing reference", f => { f.run.runnerProfileJson.nativeWorkspaceSync = {} as any; }],
  ["prepared only", f => { f.run.runnerProfileJson.nativeWorkspaceSync.state = "prepared"; }],
  ["missing baseline", f => { f.run.runnerProfileJson.nativeWorkspaceSync.baselineSha256 = ""; }],
  ["invalid final hash", f => { f.run.runnerProfileJson.nativeWorkspaceSync.finalHostSha256 = "wrong"; }],
  ["foreign workspace", f => { f.run.contextSnapshot.executionWorkspaceId = "other"; }],
  ["contradictory native binding", f => { f.run.runnerProfileJson.nativeExecutionInput.binding.executionWorkspaceId = "other"; }],
  ["foreign lease", f => { f.lease.id = "other"; }],
  ["foreign run", f => { f.lease.heartbeatRunId = "other"; }],
  ["foreign company", f => { f.lease.companyId = "other"; }],
  ["foreign environment", f => { f.lease.environmentId = "other"; }],
  ["foreign provider lease", f => { f.lease.providerLeaseId = "other"; }],
  ["wrong remote root", f => { f.lease.metadata.remoteCwd = "/other"; }],
  ["wrong provider", f => { f.lease.provider = "other"; }],
] satisfies Array<[string, (f: ReturnType<typeof copyback>) => void]>)("rejects %s copy-back provenance", (_label, change) => {
  const f = copyback(); change(f);
  expect(() => gradePiCopyback(f.run, f.lease, f.companyId, f.environmentId)).toThrow("Pi file evidence:");
});
