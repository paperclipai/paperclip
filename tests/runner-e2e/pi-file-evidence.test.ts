import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectPiFileEvidence, gradePiCopyback, gradePiFileEvidence, piFileContract, seedPiFile } from "./pi-file-evidence.js";
import { canonicalProviderEventsFromAcpxRuntimeEvent, createAcpxToolEventNormalizer } from "../../packages/paperclip-runner/src/provider-events.js";
import { safeAcpxLocations } from "../../packages/paperclip-runner/src/drivers/acpx/safe-locations.js";
import { classifyFailure } from "./failure-classifier.js";
import { runnerMatrix } from "./catalog.js";

function fixture() {
  const c = piFileContract("fixture"), attachmentId = "12345678-1234-1234-1234-123456789abc";
  const normalize = createAcpxToolEventNormalizer();
  const tool = (seq: number, executionId: string, name: string, operation: string,
    phase: "start" | "progress" | "end", target: string | null, text = "", rawOutput: unknown = undefined) => {
    // Sanitized shape of the retained Pi stream: missing opening location,
    // later resolved edit arguments, and stable bash name with command progress.
    // This exercises TS normalization/projection, not the Rust implementation.
    const event = normalize({ type: "tool_call", toolCallId: executionId,
      tag: phase === "start" ? "tool_call" : "tool_call_update", title: name, kind: operation,
      status: phase === "end" ? "completed" : phase === "start" ? "pending" : "in_progress",
      locations: safeAcpxLocations(target ? [{ path: `/workspace/${target}` }] : [], "/workspace", operation, name),
      text, rawOutput });
    const canonical = canonicalProviderEventsFromAcpxRuntimeEvent(event, executionId, "turn")[0]!;
    return { companyId: "company", runId: "run", seq, protocolSchemaVersion: 1, eventType: canonical.eventType,
      sourceInstanceId: "runner", sourceSeq: seq, sourceEventId: `runner:run:${seq}`,
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
    events: [tool(1, "edit", "edit", "edit", "start", null),
      tool(2, "edit", "edit", "edit", "progress", c.filename),
      tool(3, "edit", "edit", "edit", "end", c.filename),
      tool(4, "validate", "bash", "execute", "start", null, "bash (pending): [terminal] validate"),
      tool(5, "validate", c.validationCommand, "execute", "progress", null, `${c.validationCommand} (in_progress): ${c.validationCommand}`),
      tool(6, "validate", c.validationCommand, "execute", "end", null, "", {
        content: [{ type: "text", text: `${c.validationMarker}\n` }],
        structuredContent: { output: `${c.validationMarker}\n`, truncated: false, exit_code: 0, wall_time_seconds: 0 },
      })],
    attachments: [{ id: attachmentId, companyId: "company", issueId: "issue", originatingRunId: "run", createdByAgentId: "agent",
      originalFilename: c.filename, contentType: "text/plain", byteSize: c.byteSize, sha256: c.sha256 }],
    activity: [{ action: "issue.attachment_added", companyId: "company", runId: "run", actorId: "agent", entityId: "issue",
      details: { attachmentId, source: "paperclip_runner_protocol" } }],
  };
}
function changeOutput(f: ReturnType<typeof fixture>, change: (output: any) => void) {
  const p = f.events[5]!.payload.prpEvent.payload, output = JSON.parse(p.output as string);
  change(output); p.output = JSON.stringify(output);
}
describe("Pi edit, validation and public artifact oracle", () => {
  it("calibrates against the sanitized 44-row actual native stream without regrading the paid attempt", async () => {
    const retained = JSON.parse(await readFile(new URL("./fixtures/pi-file-evidence-actual-stream.json", import.meta.url), "utf8"));
    const f = fixture();
    expect(retained.events).toHaveLength(44);
    f.events = retained.events.map((x: any) => ({ companyId: "company", runId: "run", seq: x.seq,
      protocolSchemaVersion: 1, eventType: x.eventType, sourceInstanceId: "runner", sourceSeq: x.sourceSeq,
      sourceEventId: `runner:run:${x.sourceSeq}`, payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId: "runner",
        sourceSeq: x.sourceSeq, sourceEventId: `runner:run:${x.sourceSeq}`, runId: "run", turnId: "turn",
        normalizedSessionId: "session", eventType: x.eventType, payload: x.payload,
      } } }));
    expect(gradePiFileEvidence(f).verification).toMatchObject({ nativeStructuredExitCode: 0, typedExitCode: null });
  });
  it("accepts actual correlated lifecycles, independent bytes and a run-bound registered download", () => {
    const result = gradePiFileEvidence(fixture());
    expect(result.passed).toBe(true);
    expect(result.diff.text).toContain("-ready-fixture\n+verified-fixture\n");
    expect(result.limits.join(" ")).toContain("not attested");
    expect(result.verification.providerExecutionStatus).toBe("completed");
    expect(result.verification.command).toBe(piFileContract("fixture").validationCommand);
    expect(result.verification).toMatchObject({ commandEvidence: "correlated_native_progress",
      exitEvidence: "native_structured_output_receipt", nativeStructuredExitCode: 0, typedExitCode: null });
    expect(fixture().events.map(e => e.payload.prpEvent.payload.target)).toEqual([null, "extended-fixture.txt", "extended-fixture.txt", null, null, null]);
    expect(fixture().events.slice(3).every(e => e.payload.prpEvent.payload.name === "bash")).toBe(true);
    expect(result.verification.nativeFileAttribution).toBe("workspace_relative_display_target");
  });
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["absent seed", f => { f.seed = {} as any; }],
    ["wrong final bytes", f => { f.workspaceBytes = Buffer.from("wrong\n"); }],
    ["final-only write", f => { f.events[0]!.payload.prpEvent.payload.name = "write"; f.events[2]!.payload.prpEvent.payload.name = "write"; }],
    ["missing edit", f => { f.events = f.events.slice(3); }],
    ["missing validation", f => { f.events = f.events.slice(0, 3); }],
    ["echo-only validation", f => { f.events[3]!.payload.prpEvent.payload.name = `echo ${piFileContract("fixture").validationMarker}`; f.events[5]!.payload.prpEvent.payload.name = f.events[3]!.payload.prpEvent.payload.name; }],
    ["failed validation", f => { f.events[5]!.payload.prpEvent.payload.status = "failed"; }],
    ["unfinished validation", f => { f.events.pop(); }],
    ["unrelated validation turn", f => { f.events[3]!.payload.prpEvent.turnId = "other"; f.events[5]!.payload.prpEvent.turnId = "other"; }],
    ["foreign native session", f => { f.run.nativeSessionId = "other"; }],
    ["foreign native producer", f => { f.run.runnerInstanceId = "other"; }],
    ["foreign event run", f => { f.events[2]!.payload.prpEvent.runId = "other"; }],
    ["duplicate event", f => { f.events.push(structuredClone(f.events[5]!)); }],
    ["missing tool start", f => { f.events.splice(3, 1); }],
    ["truncated validation output", f => { f.events[5]!.payload.prpEvent.payload.outputTruncated = true; }],
    ["missing native target", f => { f.events[0]!.payload.prpEvent.payload.target = null; f.events[2]!.payload.prpEvent.payload.target = null; }],
    ["wrong target", f => { f.events[2]!.payload.prpEvent.payload.target = "other.txt"; }],
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
    ["conflicting resolved target", f => { f.events[1]!.payload.prpEvent.payload.target = "other.txt"; }],
    ["target regresses after resolution", f => { f.events[0]!.payload.prpEvent.payload.target = piFileContract("fixture").filename; f.events[1]!.payload.prpEvent.payload.target = null; }],
    ["missing terminal target", f => { f.events[2]!.payload.prpEvent.payload.target = null; }],
    ["absent command proof", f => { f.events[4]!.payload.prpEvent.payload.progress = null; }],
    ["echo-only command proof", f => { f.events[4]!.payload.prpEvent.payload.progress = "echo PI-VALIDATED-fixture (in_progress): echo PI-VALIDATED-fixture"; }],
    ["conflicting command before exact proof", f => { f.events[3]!.payload.prpEvent.payload.progress = "node other.js (pending): node other.js"; }],
    ["late command proof", f => { f.events[5]!.payload.prpEvent.payload.progress = f.events[4]!.payload.prpEvent.payload.progress; f.events[4]!.payload.prpEvent.payload.progress = null; }],
    ["plain echoed marker output", f => { f.events[5]!.payload.prpEvent.payload.output = piFileContract("fixture").validationMarker; }],
    ["nonzero native exit", f => { changeOutput(f, o => { o.structuredContent.exit_code = 1; }); }],
    ["missing native exit", f => { changeOutput(f, o => { delete o.structuredContent.exit_code; }); }],
    ["truncated native output", f => { changeOutput(f, o => { o.structuredContent.truncated = true; }); }],
    ["false marker substring", f => { changeOutput(f, o => { o.structuredContent.output = "failed before PI-VALIDATED-fixture\n"; }); }],
    ["contradictory content", f => { changeOutput(f, o => { o.content[0].text = "failed"; }); }],
    ["contradictory typed exit", f => { f.events[5]!.payload.prpEvent.payload.exitCode = 1; }],
    ["foreign command proof execution", f => { f.events[4]!.payload.prpEvent.payload.executionId = "foreign"; }],
    ["foreign command proof turn", f => { f.events[4]!.payload.prpEvent.turnId = "foreign"; }],
    ["foreign command proof session", f => { f.events[4]!.payload.prpEvent.normalizedSessionId = "foreign"; }],
    ["foreign command proof producer", f => {
      const row = f.events[4]!, e = row.payload.prpEvent;
      e.sourceInstanceId = row.sourceInstanceId = "foreign"; e.sourceEventId = row.sourceEventId = `foreign:run:${e.sourceSeq}`;
    }],
    ["durable source differs from envelope", f => { f.events[4]!.sourceInstanceId = "foreign"; }],
    ["durable event identity differs from envelope", f => { f.events[4]!.sourceEventId = "runner:run:999"; }],
    ["durable source sequence differs from envelope", f => { f.events[4]!.sourceSeq = 999; }],
    ["command proof after terminal", f => {
      const e = f.events[4]!; f.events.splice(4, 1); e.seq = 7; e.payload.prpEvent.sourceSeq = 7;
      e.sourceSeq = 7; e.sourceEventId = e.payload.prpEvent.sourceEventId = "runner:run:7"; f.events.push(e);
    }],
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
