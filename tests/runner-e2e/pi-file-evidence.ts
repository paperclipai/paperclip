import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { RunnerApi } from "./api.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";

type Row = Record<string, any>;
const rec = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const requireEvidence = (value: unknown, reason: string) => { if (!value) throw new Error(`Pi file evidence: ${reason}`); };
export function piFileContract(nonce: string) {
  if (!/^[A-Za-z0-9-]{1,100}$/u.test(nonce)) throw new Error("Invalid file fixture nonce");
  const filename = `extended-${nonce}.txt`, before = `ready-${nonce}\n`, after = `verified-${nonce}\n`;
  const validationMarker = `PI-VALIDATED-${nonce}`;
  const validationCommand = `node -e 'if(require("node:fs").readFileSync(${JSON.stringify(filename)},"utf8")!==${JSON.stringify(after)})throw Error("mismatch");console.log(${JSON.stringify(validationMarker)})'`;
  if ([...validationCommand].length > 240) throw new Error("Validation command exceeds native Rust tool-name bound");
  return { filename, before, after, sha256: sha(after), byteSize: Buffer.byteLength(after), validationMarker, validationCommand };
}
export function piFilePrompt(nonce: string) {
  const c = piFileContract(nonce);
  return [
    `The fixture has already created ${c.filename} in your execution workspace with exactly ${JSON.stringify(c.before)}. Read it, then use your native edit tool once to replace those bytes with exactly ${JSON.stringify(c.after)}. Do not substitute write, bash, or an API for the edit.`,
    `Run this exact native bash command exactly once, without an added shell prefix or suffix:\n\`\`\`bash\n${c.validationCommand}\n\`\`\`\nIt independently reads the file, fails on incorrect bytes, and prints the validation marker only after success. This is the only bash call allowed for this task; do not run any other shell commands.`,
    `Deliver the edited text file as a downloadable attachment using the assigned register_deliverable semantic tool, with filename and workspace-relative contentRef ${c.filename}, contentType text/plain, byteSize ${c.byteSize}, sha256 ${c.sha256}, title ${c.filename}, and a fresh idempotencyKey. Use the supplied byteSize and sha256 for the exact validated post-edit bytes; do not run extra commands to obtain metadata. Wait for the real registration receipt. Do not upload a different file or claim publication from a disk path.`,
    `After successful validation and registration, call paperclip_finish with reportedWorkDisposition done, summary EXTENDED-FILE-${nonce}, the current completion contract revision and satisfied objective criterion, no remaining work, the actual validation command/result, and the registered artifact reference.`,
    `Wait for paperclip_finish to succeed, then emit exactly EXTENDED-FILE-${nonce} as your final response. Do not create unrelated files or work.`,
  ].join("\n");
}
export async function seedPiFile(workspace: string, nonce: string) {
  const c = piFileContract(nonce);
  await writeFile(join(workspace, c.filename), c.before, { flag: "wx" });
  const bytes = await readFile(join(workspace, c.filename));
  requireEvidence(bytes.equals(Buffer.from(c.before)), "seed bytes changed before provider startup");
  return { schema: "paperclip.e2e.pi-file-seed.v1", filename: c.filename, beforeSha256: sha(bytes), byteSize: bytes.length };
}

export function gradePiCopyback(run: Row, lease: Row, companyId: string, environmentId: string) {
  const context = rec(run.contextSnapshot), environment = rec(context.paperclipEnvironment);
  const reference = rec(rec(run.runnerProfileJson).nativeWorkspaceSync);
  const binding = rec(rec(rec(run.runnerProfileJson).nativeExecutionInput).binding);
  requireEvidence(run.companyId === companyId && reference.schema === "paperclip.native-workspace-sync/v2"
    && reference.state === "finalized" && [reference.baselineSha256, reference.descriptorSha256, reference.finalHostSha256]
      .every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)), "finalized production copy-back hashes required");
  requireEvidence(typeof reference.workspaceId === "string" && reference.workspaceId.length > 0
    && reference.workspaceId === context.executionWorkspaceId
    && (binding.executionWorkspaceId === undefined || binding.executionWorkspaceId === reference.workspaceId)
    && environment.id === environmentId && environment.driver === "sandbox" && environment.leaseId === reference.leaseId,
  "copy-back workspace and environment must belong to the actual run");
  requireEvidence(lease.id === reference.leaseId && lease.companyId === companyId && lease.environmentId === environmentId
    && lease.heartbeatRunId === run.id && lease.provider === "daytona" && typeof reference.providerLeaseId === "string"
    && reference.providerLeaseId.length > 0 && lease.providerLeaseId === reference.providerLeaseId
    && typeof reference.remoteCwd === "string" && reference.remoteCwd.startsWith("/")
    && reference.remoteCwd === rec(lease.metadata).remoteCwd, "copy-back must bind the exact run and provider lease");
  return { kind: "product_copyback", reference, lease: { id: lease.id, companyId, environmentId, heartbeatRunId: run.id,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId, remoteCwd: reference.remoteCwd },
    guestObservation: false, hostSnapshotRecomputed: false };
}

/** Only the common public projection is authority here. Native raw arguments,
 * full diff blocks and typed command exit codes are deliberately not invented.
 * The native structured output receipt is distinct from that nullable typed field. */
export function gradePiFileEvidence(input: {
  nonce: string; companyId: string; issueId: string; agentId: string; run: Row;
  environment: "local" | "daytona"; environmentId: string; lease?: Row;
  events: unknown[]; seed: unknown; workspaceBytes: Buffer; attachments: unknown[];
  attachmentId: string; downloadedBytes: Buffer; activity: unknown[];
}) {
  const c = piFileContract(input.nonce), run = input.run, seed = rec(input.seed);
  const workspaceProvenance = input.environment === "daytona"
    ? gradePiCopyback(run, rec(input.lease), input.companyId, input.environmentId)
    : { kind: "independent_local_workspace" };
  requireEvidence(run.id && run.companyId === input.companyId && run.agentId === input.agentId
    && run.runtimeMode === "native" && run.status === "succeeded", "actual native run identity");
  requireEvidence(seed.schema === "paperclip.e2e.pi-file-seed.v1" && seed.filename === c.filename
    && seed.beforeSha256 === sha(c.before) && seed.byteSize === Buffer.byteLength(c.before), "independent pre-edit seed");
  requireEvidence(input.workspaceBytes.equals(Buffer.from(c.after)), "independent final workspace bytes");
  requireEvidence(input.events.length > 0 && input.events.length <= 20_000, "bounded run events");
  const rows = input.events.map(rec).filter(row => rec(row.payload).prpEvent !== undefined);
  const seen = new Set<string>(), seqs = new Set<number>(), sourceSeqs = new Map<string, number>();
  const canonical = rows.map(row => {
    const e = rec(rec(row.payload).prpEvent);
    requireEvidence(row.companyId === input.companyId && row.runId === run.id && e.runId === run.id
      && isValidNativePrpEnvelope(e, row.protocolSchemaVersion) && row.eventType === e.eventType
      && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq)
      && typeof e.sourceInstanceId === "string" && e.sourceInstanceId.length > 0
      && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > (sourceSeqs.get(e.sourceInstanceId) ?? 0)
      && row.sourceInstanceId === e.sourceInstanceId && row.sourceSeq === e.sourceSeq && row.sourceEventId === e.sourceEventId
      && e.sourceEventId === `${e.sourceInstanceId}:${e.runId}:${e.sourceSeq}` && !seen.has(e.sourceEventId), "foreign, duplicated, or reordered durable evidence");
    seqs.add(row.seq); seen.add(e.sourceEventId); sourceSeqs.set(e.sourceInstanceId, e.sourceSeq);
    return { row, e, p: rec(e.payload) };
  });
  const tools = canonical.filter(x => x.e.eventType.startsWith("tool.execution.") && x.p.transport === "builtin");
  const edits = tools.filter(x => x.e.eventType === "tool.execution.completed" && x.p.operation === "edit");
  requireEvidence(edits.length === 1, "one native edit required; final-only writes cannot qualify");
  const edit = edits[0]!;
  requireEvidence(edit.p.name === "edit" && edit.p.target === c.filename, "exact native edit and relative target required");
  function lifecycle(end: typeof edit) {
    const matches = tools.filter(x => x.p.executionId === end.p.executionId);
    const starts = matches.filter(x => x.e.eventType === "tool.execution.started");
    requireEvidence(typeof end.p.executionId === "string" && end.p.executionId.length > 0
      && end.p.schema === "paperclip.tool.execution.v1" && end.p.status === "completed"
      && end.e.sourceKind === "runner" && end.e.sourceInstanceId === run.runnerInstanceId
      && end.e.normalizedSessionId === run.nativeSessionId && typeof end.e.turnId === "string" && end.e.turnId.length > 0
      && typeof end.e.normalizedSessionId === "string" && end.e.normalizedSessionId.length > 0
      && starts.length === 1 && starts[0]!.row.seq < end.row.seq
      && matches.filter(x => x.e.eventType === "tool.execution.completed").length === 1
      && matches.every(x => x.p.schema === end.p.schema && x.p.name === end.p.name && x.p.operation === end.p.operation
        && x.row.seq >= starts[0]!.row.seq && x.row.seq <= end.row.seq
        && x.e.sourceKind === "runner" && x.e.turnId === end.e.turnId
        && x.e.normalizedSessionId === end.e.normalizedSessionId && x.e.sourceInstanceId === end.e.sourceInstanceId
        && (x === end || (x.p.status === "running"
          && ["tool.execution.started", "tool.execution.progressed"].includes(x.e.eventType)))), "incomplete or unsuccessful native tool lifecycle");
    // Native arguments arrive incrementally. An unresolved target is allowed
    // only before the first exact target; conflicting or regressed targets fail.
    let resolved = false;
    for (const x of matches) {
      requireEvidence(x.p.target === end.p.target || (!resolved && x.p.target === null), "conflicting native tool target");
      if (x.p.target !== null) resolved = true;
    }
    return { start: starts[0]!, matches };
  }
  lifecycle(edit);
  const validations = tools.filter(x => x.e.eventType === "tool.execution.completed" && x.p.operation === "execute"
    && x.p.name === "bash");
  requireEvidence(validations.length === 1, "one observed provider validation execution");
  const validation = validations[0]!, { start, matches } = lifecycle(validation);
  requireEvidence(start.row.seq > edit.row.seq && validation.e.turnId === edit.e.turnId
    && validation.e.normalizedSessionId === edit.e.normalizedSessionId
    && validation.e.sourceInstanceId === edit.e.sourceInstanceId && validation.p.outputTruncated === false,
  "validation must follow the edit in the same native turn");
  // The common lifecycle preserves the opening name (bash). ACPX's resolved
  // command is retained as progress, rather than replacing that stable name.
  const commandProgress = `${c.validationCommand} (in_progress): ${c.validationCommand}`;
  const allowedProgress = new Set([`bash (pending): [terminal] ${validation.p.executionId}`,
    `${c.validationCommand} (pending): ${c.validationCommand}`, commandProgress]);
  requireEvidence(matches.some(x => x !== validation && x.p.progress === commandProgress)
    && matches.every(x => x.p.progress === null || allowedProgress.has(x.p.progress)),
  "exact correlated command progress before completion required");
  requireEvidence(typeof validation.p.output === "string" && Buffer.byteLength(validation.p.output) <= 16_384,
    "bounded native validation receipt required");
  let output: Row = {};
  try { output = rec(JSON.parse(validation.p.output)); } catch { /* Rejected below; plain marker text is insufficient. */ }
  const structured = rec(output.structuredContent), expectedOutput = `${c.validationMarker}\n`;
  requireEvidence(structured.exit_code === 0 && structured.truncated === false && structured.output === expectedOutput
    && Array.isArray(output.content) && output.content.length === 1
    && rec(output.content[0]).type === "text" && rec(output.content[0]).text === expectedOutput
    && (validation.p.exitCode === null || validation.p.exitCode === 0), "successful native structured validation receipt required");
  const attachments = input.attachments.map(rec).filter(a => a.id === input.attachmentId);
  requireEvidence(attachments.length === 1, "one public attachment");
  const a = attachments[0]!;
  requireEvidence(a.companyId === input.companyId && a.issueId === input.issueId && a.originatingRunId === run.id
    && a.createdByAgentId === input.agentId && a.originalFilename === c.filename && a.contentType === "text/plain"
    && a.byteSize === c.byteSize && a.sha256 === c.sha256, "attachment bytes and immutable run attribution");
  requireEvidence(input.downloadedBytes.equals(Buffer.from(c.after)), "actual public download bytes");
  const receipts = Object.values(rec(rec(run.resultJson).semanticToolReceipts)).map(rec)
    .filter(r => r.operationId === "register_deliverable" && rec(r.input).filename === c.filename);
  requireEvidence(receipts.length === 1, "one authenticated semantic registration");
  const receipt = receipts[0]!, args = rec(receipt.input), result = rec(receipt.result);
  requireEvidence(args.contentRef === c.filename && args.contentType === "text/plain" && args.byteSize === c.byteSize
    && args.sha256 === c.sha256 && result.disposition === "applied" && result.commandId === `deliverable-prepared:${a.id}`
    && Array.isArray(result.entityRefs) && result.entityRefs[0] === a.id, "registered artifact receipt must match downloaded attachment");
  const publications = input.activity.map(rec).filter(row => row.action === "issue.attachment_added"
    && rec(row.details).attachmentId === a.id);
  requireEvidence(publications.length === 1 && publications[0]!.companyId === input.companyId
    && publications[0]!.runId === run.id && publications[0]!.actorId === input.agentId
    && publications[0]!.entityId === input.issueId && rec(publications[0]!.details).source === "paperclip_runner_protocol",
  "publication activity must belong to this run and task");
  return {
    schema: "paperclip.e2e.pi-file-evidence.v1", passed: true, workspaceProvenance,
    runId: run.id, turnId: edit.e.turnId, nativeEditExecutionId: edit.p.executionId,
    validationExecutionId: validation.p.executionId, attachmentId: a.id,
    verification: { kind: "independent_exact_bytes", beforeSha256: sha(c.before), afterSha256: c.sha256,
      downloadedSha256: sha(input.downloadedBytes), byteSize: c.byteSize, providerExecutionStatus: validation.p.status,
      command: c.validationCommand, providerToolName: validation.p.name, commandEvidence: "correlated_native_progress",
      exitEvidence: "native_structured_output_receipt", nativeStructuredExitCode: structured.exit_code,
      typedExitCode: validation.p.exitCode, nativeFileTarget: edit.p.target,
      nativeFileAttribution: "workspace_relative_display_target" },
    diff: { source: "independent_seed_and_workspace_bytes", path: c.filename,
      text: `--- ${c.filename}\n+++ ${c.filename}\n@@ -1 +1 @@\n-${c.before.trimEnd()}\n+${c.after.trimEnd()}\n` },
    limits: ["Exact command progress and the native structured output receipt are checked; raw arguments and nullable typed exitCode are not attested by those distinct fields.",
      "Diff is computed from independently checked workspace bytes; it does not qualify native diff presentation or private invocation metadata."],
  };
}

export async function collectPiFileEvidence(input: {
  page: Page; api: RunnerApi; nonce: string; companyId: string; issueId: string; agentId: string;
  run: Row; events: unknown[]; seed: unknown; workspace: string;
  environment: "local" | "daytona"; environmentId: string;
  evidence(data: unknown): Promise<void>;
}) {
  const c = piFileContract(input.nonce);
  let run = input.run, lease: Row | undefined;
  if (input.environment === "daytona") {
    run = await input.api.get<Row>(`/api/heartbeat-runs/${input.run.id}`);
    requireEvidence(run.id === input.run.id, "public copy-back run readback changed identity");
    const leaseId = rec(rec(run.runnerProfileJson).nativeWorkspaceSync).leaseId;
    requireEvidence(typeof leaseId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(leaseId), "copy-back lease reference missing");
    lease = await input.api.get<Row>(`/api/environment-leases/${leaseId}`);
  }
  const attachments = await input.api.get<Row[]>(`/api/issues/${input.issueId}/attachments`);
  const selected = attachments.filter(a => a.originalFilename === c.filename);
  requireEvidence(selected.length === 1 && /^[a-f0-9-]{36}$/u.test(selected[0]!.id), "exact published file selection");
  requireEvidence(selected[0]!.byteSize === c.byteSize && selected[0]!.sha256 === c.sha256
    && selected[0]!.contentType === "text/plain", "bounded attachment metadata before download");
  const attachmentId = selected[0]!.id;
  const contentPath = `/api/attachments/${attachmentId}/content`;
  // Exercise the real task surface and the authenticated public download route.
  await input.page.locator(`a[href*="${contentPath}"]`).first().waitFor({ state: "visible", timeout: 15_000 });
  const response = await input.api.request.get(contentPath);
  requireEvidence(response.ok(), "public attachment download failed");
  const downloadedBytes = await response.body();
  requireEvidence(downloadedBytes.length <= 4096, "bounded text attachment");
  const workspaceBytes = await readFile(join(input.workspace, c.filename));
  const activity = await input.api.get<Row[]>(`/api/issues/${input.issueId}/activity`);
  await input.evidence({ schema: "paperclip.e2e.pi-file-observation.v1", attachments, attachmentId, activity,
    workspaceBytes: workspaceBytes.toString("base64"), downloadedBytes: downloadedBytes.toString("base64"),
    encoding: "base64", expectedSha256: c.sha256, copybackReference: rec(run.runnerProfileJson).nativeWorkspaceSync,
    copybackLease: lease && { id: lease.id, companyId: lease.companyId, environmentId: lease.environmentId,
      heartbeatRunId: lease.heartbeatRunId, provider: lease.provider, providerLeaseId: lease.providerLeaseId, remoteCwd: rec(lease.metadata).remoteCwd } });
  return gradePiFileEvidence({ ...input, run, lease, attachments, attachmentId, downloadedBytes, workspaceBytes, activity });
}
