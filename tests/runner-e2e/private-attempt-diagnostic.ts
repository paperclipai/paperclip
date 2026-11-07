import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { PAPERCLIP_PROTOCOL_ACTIONS } from "../../packages/paperclip-runner/src/protocol-actions/index.js";

// Reject malformed counters wholesale. Unknown input never becomes a diagnostic
// string, path, or authority; even a complete scan remains unqualified evidence.
function closedPackagingBudget(input: unknown, message: string) {
  const b = input && typeof input === "object" ? input as Record<string, any> : {};
  const kinds = ["json", "log", "image", "video", "zip", "html", "text", "asset"];
  const number = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (![b.listedFiles, b.filesExamined, b.bytesExamined].every(number) || b.listedFiles > 4097 || b.filesExamined > 4096
    || b.filesExamined > b.listedFiles || typeof b.inventoryComplete !== "boolean" || typeof b.scanFinished !== "boolean"
    || ![true, false, null].includes(b.requiredEvidenceComplete)) return null;
  const byKind: Record<string, { files: number; bytes: number }> = {};
  for (const kind of kinds) {
    const row = b.byKind?.[kind];
    if (!row || !number(row.files) || !number(row.bytes)) return null;
    byKind[kind] = { files: row.files, bytes: row.bytes };
  }
  if (Object.values(byKind).reduce((n, r) => n + r.files, 0) !== b.filesExamined
    || Object.values(byKind).reduce((n, r) => n + r.bytes, 0) !== b.bytesExamined
    || b.inventoryComplete && b.filesExamined !== b.listedFiles || b.scanFinished && !b.inventoryComplete) return null;
  if (b.requiredEvidenceComplete === true && (!b.scanFinished || b.bound !== "none")) return null;
  const observedBound = ["none", "physical-bytes", "entries", "zip-expanded-bytes", "zip-time", "html-encoded-bytes"].includes(b.bound) ? b.bound : "unknown";
  const bound = message === "Complete original evidence exceeds byte allowance" ? "original-seal-bytes"
    : message === "Complete original evidence exceeds entry allowance" ? "original-seal-entries"
    : message === "Complete packaged evidence exceeds allowance" ? "final-seal-allowance" : observedBound;
  return { scope: "package-standard-files", bound, listedFiles: b.listedFiles, filesExamined: b.filesExamined, bytesExamined: b.bytesExamined,
    inventoryComplete: b.inventoryComplete, scanFinished: b.scanFinished, requiredEvidenceComplete: b.requiredEvidenceComplete,
    byKind, qualification: "unqualified" };
}
export interface PrivateAttemptDiagnosticInput { stage: unknown; result?: unknown; error?: unknown; observation?: unknown; evidence?: unknown }
const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const member = (value: unknown, choices: string[]) => typeof value === "string" && choices.includes(value) ? value : "unknown";
const reporterReasons = ["zip inspection exceeded its expanded-byte bound", "zip inspection exceeded its time bound", "exact secret value", "secret-shaped value", "embedded report exceeded its byte bound", "reporter text exceeds inspection bound", "embedded report encoding could not be inspected", "reporter symlink cannot be inspected", "credential in reporter filename", "reporter JSON could not be safely parsed"];
function carrierReasons(input: unknown, source: "reporter" | "packaging") {
  const findings = (Array.isArray(input) ? input : []).map(issue => {
    const file = typeof record(issue).file === "string" ? record(issue).file.replace(/\\/g, "/") : "";
    const carrier = /^blob-report\/[^/]+\.zip$/.test(file) ? "blob-zip"
      : /^playwright-output\/[^/]+\/trace\.zip$/.test(file) ? "playwright-trace-zip"
      : /^html-report\/data\/[^/]+\.zip$/.test(file) ? "html-trace-zip"
      : file === "html-report/index.html" ? "embedded-html" : "other";
    return { carrier, reason: record(issue).reason };
  });
  return ["blob-zip", "playwright-trace-zip", "html-trace-zip", "embedded-html", "other"].flatMap(carrier =>
    reporterReasons.flatMap(reason => {
      const count = Math.min(findings.filter(issue => issue.carrier === carrier && issue.reason === reason).length, 1000);
      return count ? [{ source, carrier, reason, count }] : [];
    }));
}
const failures = new Map([
  ["Bounded diagnostic unavailable", "bounded-diagnostic-unavailable"],
  ["Diagnostic withheld", "diagnostic-withheld"],
  ["Diagnostic custody invalid", "diagnostic-custody-invalid"],
  ["Source SDK evidence privacy check failed; bytes withheld", "source-sdk-evidence-privacy-check-failed"],
  ["Source SDK output custody invalid", "source-sdk-output-custody-invalid"],
  ["Source SDK output exceeds evidence bound", "source-sdk-output-exceeds-evidence-bound"],
  ["Source SDK output root invalid", "source-sdk-output-root-invalid"],
  ["Source SDK retention requires exact source revision", "source-sdk-retention-requires-exact-source"],
  ["Source SDK staging custody invalid", "source-sdk-staging-custody-invalid"],
  ["Source SDK build completion evidence missing", "source-sdk-build-completion-evidence-missing"],
  ["Source SDK build output no longer matches its completed compiler receipt", "source-sdk-build-output-no-longer"],
  ["Source SDK output exceeds combined evidence bound", "source-sdk-output-exceeds-combined-evidence"],
  ["Source SDK retained filename collision", "source-sdk-retained-filename-collision"],
  ["Source SDK retained selection mismatch", "source-sdk-retained-selection-mismatch"],
  ["Source SDK retained custody invalid", "source-sdk-retained-custody-invalid"],
  ["Source SDK retained receipt missing", "source-sdk-retained-receipt-missing"],
  ["Source SDK retained identity mismatch", "source-sdk-retained-identity-mismatch"],
  ["Source SDK retained bytes changed", "source-sdk-retained-bytes-changed"],
  ["Source SDK public source custody changed", "source-sdk-public-source-custody-changed"],
  ["Source SDK public observations changed", "source-sdk-public-observations-changed"],
  ["Source SDK published bytes changed", "source-sdk-published-bytes-changed"],
  ["SDK audit capture does not match its exact private cell", "sdk-audit-capture-does-not-match"],
  ["SDK audit source custody invalid", "sdk-audit-source-custody-invalid"],
  ["SDK audit changed during capture", "sdk-audit-changed-during-capture"],
  ["SDK audit has an unsupported observation shape", "sdk-audit-has-an-unsupported-observation"],
  ["Invalid private framework evidence", "invalid-private-framework-evidence"],
  ["Docker config custody requires the isolated home scan", "docker-config-custody-requires-the-isolated"],
  ["Private Codex identity policy requires the isolated home root", "private-codex-identity-policy-requires-the"],
  ["Private Codex identity policy requires an owner-only temporary root", "private-codex-identity-policy-requires-an"],
  ["Codex rollout record exceeds private scan bound", "codex-rollout-record-exceeds-private-scan"],
  ["Invalid exact manual evidence selection", "invalid-exact-manual-evidence-selection"],
  ["Private manual evidence exceeds the per-run cell limit", "private-manual-evidence-exceeds-the-perrun"],
  ["Invalid manual private evidence identity", "invalid-manual-private-evidence-identity"],
  ["Unsupported private manual evidence selection", "unsupported-private-manual-evidence-selection"],
  ["Invalid protected manual evidence approval", "invalid-protected-manual-evidence-approval"],
  ["Exact protected manual evidence approval missing or ambiguous", "exact-protected-manual-evidence-approval-missing"],
  ["Invalid manual evidence execution identity", "invalid-manual-evidence-execution-identity"],
  ["Invalid manual private storage identity", "invalid-manual-private-storage-identity"],
  ["Private archive sessions require one exact cell or the report writer", "private-archive-sessions-require-one-exact"],
  ["Private archive session policy exceeds the STS limit", "private-archive-session-policy-exceeds-the"],
  ["Invalid private evidence preflight custody", "invalid-private-evidence-preflight-custody"],
  ["Private evidence preflight does not match this exact attempt", "private-evidence-preflight-does-not-match"],
  ["Invalid private evidence staging ownership", "invalid-private-evidence-staging-ownership"],
  ["Invalid original framework result", "invalid-original-framework-result"],
  ["Private evidence execution is outside preflight", "private-evidence-execution-is-outside-preflight"],
  ["Invalid original standard evidence root", "invalid-original-standard-evidence-root"],
  ["Private original handoff escaped its preflight root", "private-original-handoff-escaped-its-preflight"],
  ["Original evidence contains an unsupported entry", "original-evidence-contains-an-unsupported-entry"],
  ["Original evidence exceeds depth allowance", "original-evidence-exceeds-depth-allowance"],
  ["Original evidence escaped its owned root", "original-evidence-escaped-its-owned-root"],
  ["Original evidence changed during handoff", "original-evidence-changed-during-handoff"],
  ["Original evidence copy stopped", "original-evidence-copy-stopped"],
  ["Original evidence failed unchanged privacy or required-file checks", "original-evidence-failed-unchanged-privacy-or"],
  ["Packaged evidence escaped its owned root", "packaged-evidence-escaped-its-owned-root"],
  ["Invalid packaged evidence entry", "invalid-packaged-evidence-entry"],
  ["Unsupported packaged evidence carrier", "unsupported-packaged-evidence-carrier"],
  ["Complete packaged evidence exceeds allowance", "complete-packaged-evidence-exceeds-allowance"],
  ["No genuine packaged evidence was produced", "no-genuine-packaged-evidence-was-produced"],
  ["Packaged evidence contains credential contamination", "packaged-evidence-contains-credential-contamination"],
  ["Packaged evidence changed during handoff", "packaged-evidence-changed-during-handoff"],
  ["Invalid private cell packaging layout", "invalid-private-cell-packaging-layout"],
  ["Invalid private cell evidence byte accounting", "invalid-private-cell-evidence-byte-accounting"],
  ["Private framework attachment requires redaction", "private-framework-attachment-requires-redaction"],
  ["Invalid canonical report allowance", "invalid-canonical-report-allowance"],
  ["Invalid report package identity", "invalid-report-package-identity"],
  ["Invalid canonical report directory", "invalid-canonical-report-directory"],
  ["Canonical report closure exceeds entry allowance", "canonical-report-closure-exceeds-entry-allowance"],
  ["Invalid canonical report closure", "invalid-canonical-report-closure"],
  ["Empty canonical report closure", "empty-canonical-report-closure"],
  ["Invalid private cell report owner", "invalid-private-cell-report-owner"],
  ["Invalid private cell report custody", "invalid-private-cell-report-custody"],
  ["Unverified private cell report owner", "unverified-private-cell-report-owner"],
  ["Private cell report custody changed", "private-cell-report-custody-changed"],
  ["Cell report escaped private staging", "cell-report-escaped-private-staging"],
  ["Invalid private cell report directory", "invalid-private-cell-report-directory"],
  ["Overlapping private cell report directories", "overlapping-private-cell-report-directories"],
  ["Credential-contaminated original evidence cannot be retained", "credential-contamination"],
  ["Unsupported original evidence carrier cannot be retained", "unsupported-carrier"],
  ["Complete original evidence exceeds byte allowance", "byte-bound"],
  ["Complete original evidence exceeds entry allowance", "entry-bound"],
  ["Private cell evidence exceeds byte allowance", "byte-bound"],
  ["Private cell evidence exceeds entry allowance", "entry-bound"],
  ["Unsupported private cell evidence carrier", "unsupported-carrier"],
  ["Unsupported private cell trace owner", "trace-owner"],
  ["Invalid private cell trace asset", "trace-asset"],
  ["Private cell trace content differs from canonical producer", "trace-producer-mismatch"],
  ["Private cell report producer differs from trusted preflight", "report-producer-mismatch"],
  ["Canonical report source changed", "report-source-changed"],
  ["Invalid canonical report source", "report-source"],
]);
const phases = [["Real prior active Launch checkout", "held-work-timeout"], ["Canonical project-defaults turn settles", "canonical-turn-timeout"], ["Actual new native task reads inherited project context", "future-work-timeout"]];
const toolNames = ["bash", "paperclip_call_api", "paperclip_finish", "paperclip_get_workspace", "paperclip_get_run", "paperclip_list_runs"];
const recognizedTools = new Set([...toolNames, "read", "glob", "grep", "task", "todowrite", "question",
  ...PAPERCLIP_PROTOCOL_ACTIONS.map(action => `paperclip_${action.id}`)]);
const toolName = (value: unknown) => typeof value === "string" && recognizedTools.has(value) ? value : "other";
const apiOperations = new Map([
  ["GET /api/projects/{id}", "read-project"], ["PATCH /api/projects/{id}", "update-project"],
  ["GET /api/companies/{companyId}/projects", "list-projects"], ["GET /api/companies/{companyId}/goals", "list-goals"],
  ["GET /api/issues/{id}", "read-task"], ["PATCH /api/issues/{id}", "update-task"],
  ["GET /api/companies/{companyId}/issues", "list-tasks"], ["GET /api/companies/{companyId}/agents", "list-agents"],
]);
function sourceProgress(value: unknown) {
  const rows = Array.isArray(value) ? value : [];
  const events = rows.map(row => record(record(row).payload).prpEvent ?? row).map(record);
  const tools = events.filter(event => ["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(event.eventType));
  const names = [...new Set([...toolNames, ...tools.map(event => toolName(record(event.payload).name)), "other"])];
  return {
    events: Math.min(events.length, 100000),
    turns: Math.min(events.filter(event => event.eventType === "turn.started").length, 1000),
    finishProposals: Math.min(events.filter(event => event.eventType === "run.result.proposed").length, 1000),
    finishFeedback: Object.fromEntries(([
      ["timeout", /MCP error -32001|timed out/i], ["contract", /Stale completionClaim\.contractRevision/i],
      ["criteria", /completionClaim\.criteria must contain exactly/i], ["incomplete", /done report includes unfinished work/i],
      ["approval", /requires a persisted human decision|Required human quality review is incomplete/i],
    ] as const).map(([label, pattern]) => [label, Math.min(tools.filter(event => event.eventType === "tool.execution.completed"
      && record(event.payload).name === "paperclip_finish" && pattern.test(String(record(event.payload).output ?? ""))).length, 1000)])),
    tools: Object.fromEntries(names.map(name => [name, Object.fromEntries(["started", "progressed", "completed"].map(status =>
      [status, Math.min(tools.filter(event => event.eventType === `tool.execution.${status}` &&
        toolName(record(event.payload).name) === name).length, 10000)]))])),
    lastTools: tools.filter(event => event.eventType !== "tool.execution.progressed").slice(-12).map(event => ({
      name: toolName(record(event.payload).name), phase: event.eventType === "tool.execution.started" ? "started" : "completed",
      status: member(record(event.payload).status, ["running", "completed", "failed", "cancelled"]),
    })),
    apiResults: events.filter(event => event.eventType === "item.completed" && record(event.payload).kind === "dynamicToolCall")
      .map(event => record(record(record(event.payload).item).result)).filter(result => typeof result.apiOperationId === "string").slice(-12)
      .map(result => ({ operation: apiOperations.get(result.apiOperationId) ?? "other",
        status: Number.isSafeInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : null, ok: result.ok === true })),
  };
}
/** Closed labels/counts only; never copy an error, identity, path, body or provider value. */
export function privateAttemptDiagnostic(input: PrivateAttemptDiagnosticInput) {
  const result = record(input.result), envelope = record(input.observation), observation = record(envelope.observation), state = record(observation.state);
  const runs = Array.isArray(observation.runs) ? observation.runs.map(record) : [];
  const status = (run: Record<string, any> | undefined) => member(run?.status, ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]);
  const message = input.error instanceof Error ? input.error.message : "", productError = typeof result.error === "string" ? result.error : "";
  const privacy = record(envelope.privacy), original = record(privacy.originalResult), persistedState = record(envelope.persistedState);
  const errors = [productError, original.error, persistedState.scanError, record(persistedState.originalResult).error].filter(value => typeof value === "string") as string[];
  const evidence = record(input.evidence), leaks = Array.isArray(evidence.leaks) ? evidence.leaks : [];
  return {
    schema: "paperclip.private-attempt-diagnostic/v1",
    packagingBudget: closedPackagingBudget(record(input.error).evidenceBudget ?? evidence.budget, message),
    stage: member(input.stage, ["execution", "package-original", "seal-original", "attach-original"]),
    status: member(result.status, ["passed", "failed", "skipped"]),
    failureClass: member(result.failureClass, ["candidate_failure", "transient_infrastructure", "permanent_infrastructure", "secret_leak", "cleanup_failure"]),
    finalization: failures.get(message) ?? (record(input.error).code === "ENOENT" ? "missing-file"
      : typeof record(input.error).code === "string" && /^(?:E[A-Z]{2,15}|ERR_[A-Z0-9_]{2,48})$/.test(record(input.error).code) ? `fs-${record(input.error).code}`
      : input.error !== undefined && !(input.error instanceof Error) ? "non-error-thrown"
      : input.error instanceof Error && input.error.name !== "Error" && /^[A-Z][A-Za-z]{2,40}$/.test(input.error.name) ? `error-type-${input.error.name}`
      : /^Secret leak in [\s\S]*: (?:exact secret value|secret-shaped value)$/.test(message) ? "text-secret-finding" : "unclassified"),
    phase: phases.find(([label]) => [...errors, message].some(error => error.includes(label!)))?.[1] ?? "unclassified",
    privacy: { persistedState: errors.some(error => error.startsWith("Secret leak in persisted ")),
      reporter: Array.isArray(privacy.issues) ? Math.min(privacy.issues.length, 1000) : 0,
      reporterReasons: Object.fromEntries(reporterReasons.map(reason =>
        [reason, Array.isArray(privacy.issues) ? Math.min(privacy.issues.filter(issue => record(issue).reason === reason).length, 1000) : 0])),
      packaging: /^Secret leak in /.test(message) ? (/^Secret leak in snapshots\//.test(message) ? "snapshot" : /^Secret leak in .*\.json:/.test(message) ? "json" : "text") : "unknown" },
    runStatusCounts: Object.fromEntries(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"].map(label =>
      [label, Math.min(runs.filter(run => run.status === label).length, 1000)])),
    runs: Math.min(runs.length || (Array.isArray(result.runIds) ? result.runIds.length : 0), 1000),
    checks: Array.isArray(result.matcherResults) ? Math.min(result.matcherResults.length, 1000) : 0,
    source: status(runs.find(run => typeof observation.leadId === "string" && run.agentId === observation.leadId)),
    future: status(runs.find(run => typeof record(state.futureWorker).id === "string" && run.agentId === record(state.futureWorker).id)),
    held: status(runs.find(run => typeof state.activeRunId === "string" && run.id === state.activeRunId)),
    productGradePassed: record(envelope.grade).passed === true,
    sourceProgress: sourceProgress(envelope.sourceEvents),
    carrierReasons: [...carrierReasons(privacy.issues, "reporter"), ...carrierReasons(leaks, "packaging")],
    carrier: leaks.some(leak => record(leak).reason === "zip inspection exceeded its expanded-byte bound") ? "zip-byte-bound"
      : leaks.some(leak => record(leak).reason === "zip inspection exceeded its time bound") ? "zip-time-bound" : leaks.length ? "other-finding" : "none",
  };
}
export async function readPrivateAttemptObservation(casePrivateDir: string) {
  const read = async (name: string, limit = 8 * 1024 * 1024) => {
    try {
      const file = path.join(casePrivateDir, "snapshots", name), metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) return;
      return JSON.parse(await readFile(file, "utf8"));
    } catch { return; }
  };
  const envelope = record(await read("chat-catalog-observation.json"));
  const observation = record(envelope.observation);
  const runs = Array.isArray(observation.runs) ? observation.runs.map(record) : [];
  const source = runs.find(run => typeof observation.leadId === "string" && run.agentId === observation.leadId);
  const evidence = await read("chat-catalog-runs.json", 64 * 1024 * 1024);
  const sourceEvents = Array.isArray(evidence) ? record(evidence.find(row => source && record(row).runId === source.id)).events : undefined;
  return { ...envelope, sourceEvents, privacy: await read("diagnostic-privacy.json"), persistedState: await read("persisted-state-scan.json") };
}
/**
 * GITHUB_ENV survives the paid step's private stdout redirect. SetEnvFileCommand
 * updates the env context; ActionRunner passes it to ScriptHandler, whose
 * PrintActionDetails prints it before the next trusted shell step runs.
 * https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/ScriptHandler.cs#L120-L126
 * The variable is not consumed as authority by the protected transfer.
 */
export async function appendPrivateAttemptDiagnostic(input: PrivateAttemptDiagnosticInput, env = process.env) {
  if (env.GITHUB_ACTIONS !== "true") return;
  if (!env.GITHUB_ENV || !env.RUNNER_TEMP) throw new Error("Closed private diagnostic channel is unavailable");
  const root = await realpath(env.RUNNER_TEMP), parent = await realpath(path.dirname(env.GITHUB_ENV));
  if (!parent.startsWith(`${root}${path.sep}`) || !path.basename(env.GITHUB_ENV).startsWith("set_env_")) throw new Error("Diagnostic environment file escaped runner commands");
  const file = await open(env.GITHUB_ENV, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error("Invalid diagnostic environment file owner");
    await file.write(`PAPERCLIP_E2E_CLOSED_DIAGNOSTIC_V1=${JSON.stringify(privateAttemptDiagnostic(input))}\n`);
  } finally { await file.close(); }
}
