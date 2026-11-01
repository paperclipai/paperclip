import { createHash } from "node:crypto";
import { HIRING_TEMPLATE_READ_FILES, HIRING_TEMPLATE_SKILL_KEY } from "./hiring-template-cases.js";
import type { ChatIssue, ChatRun } from "./chat-flow.js";
import { gradeHiringTemplateTurns } from "./hiring-template-turn-accounting.js";

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export const hiringTemplateHash = (content: string) => createHash("sha256").update(content).digest("hex");
export const hiringTemplateSize = (content: string) => ({ bytes: Buffer.byteLength(content), words: content.trim().split(/\s+/).filter(Boolean).length });
export interface HiringInstructionSnapshot { entryFile: string; mode: string | null; files: Record<string, string> }
export interface HiringReadRun { runId: string; agentId: string; events: Array<{ eventType?: string; payload?: unknown; createdAt?: string }> }
export interface HiringAgent {
  id: string; name: string; role?: string; reportsTo?: string | null; adapterType?: string; createdAt?: string;
  adapterConfig?: Record<string, any>; runtimeConfig?: Record<string, any>;
}
export interface HiringDocument { issueId: string; key: string; body: string; latestRevisionId: string; createdByAgentId?: string }
export interface HiringTemplateEvidence {
  leadId: string; chatIssueId: string; hireName: string; marker: string; projectId: string; inputs: readonly string[];
  expectedCeoFiles: Record<string, string>; leadInstructions?: HiringInstructionSnapshot;
  expectedSourceHashes: Record<string, string>; servedSourceHashes: Record<string, string>;
  assignedSkills: string[]; coderExample: string; hiredInstructions?: HiringInstructionSnapshot;
  hiredInstructionsAfterReuse?: HiringInstructionSnapshot; hiredSkills?: unknown; hiredSkillsAfterReuse?: unknown; agents: HiringAgent[];
  connectionId: string; binding: unknown; tasks: ChatIssue[]; runs: ChatRun[];
  first?: HiringDocument; firstAfterReuse?: HiringDocument; second?: HiringDocument;
  readRuns: HiringReadRun[];
  /** Independent public chat/comment/run observations for strict lifecycle accounting. */
  turnApiState?: unknown;
}

function expectedFixture(inputs: readonly string[], marker: string, separator: "-" | "_") {
  return { reference: marker, entries: inputs.map(input => ({
    input, value: input.trim().toLowerCase().replace(/[^a-z0-9]+/g, separator).replace(/^[-_]+|[-_]+$/g, ""),
  })) };
}
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((v, i) => sameJson(v, right[i]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = Object.keys(left).sort();
    return sameJson(keys, Object.keys(right).sort()) && keys.every(k => sameJson(record(left)[k], record(right)[k]));
  }
  return left === right;
}
function documentMatches(document: HiringDocument | undefined, expected: unknown) {
  try { return sameJson(JSON.parse((document?.body ?? "").trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")), expected); }
  catch { return false; }
}

function payload(event: { payload?: unknown }) {
  const outer = record(event.payload);
  return record(outer.prpEvent).payload ? record(record(outer.prpEvent).payload) : outer;
}
function matchingReadPath(value: unknown, file: string) {
  return typeof value === "string" && value.replace(/\\/g, "/").endsWith(`/paperclip-create-agent/${file}`);
}
function commandReads(command: unknown, file: string) {
  if (typeof command !== "string" || /[|;&><`$\\\r\n]/.test(command)) return false;
  // Admit only direct reads with explicit arguments. Unknown options, scripts,
  // expansions and help/version output leave source coverage uncomparable.
  const matches = [...command.matchAll(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g)];
  if (!matches.length || command.slice(0, matches[0]!.index).trim()) return false;
  for (let i = 1; i < matches.length; i++) {
    if (!/^\s+$/.test(command.slice(matches[i - 1]!.index! + matches[i - 1]![0].length, matches[i]!.index))) return false;
  }
  const last = matches.at(-1)!;
  if (command.slice(last.index! + last[0].length).trim()) return false;
  const tokens = matches.map(match => match[0].replace(/^['"]|['"]$/g, ""));
  const program = tokens.shift();
  if (program === "head" || program === "tail") {
    if (tokens[0] === "-n" || tokens[0] === "-c") {
      tokens.shift();
      const count = tokens.shift();
      if (!count || !/^[1-9]\d*$/.test(count)) return false;
    } else if (/^-[nc][1-9]\d*$/.test(tokens[0] ?? "")) tokens.shift();
  } else if (program === "sed") {
    if (tokens.shift() !== "-n") return false;
    if (tokens[0] === "-e") tokens.shift();
    const script = tokens.shift() ?? "";
    // Only printing from the beginning is supported, without editing or shell
    // execution. Other valid sed programs still require different evidence.
    if (!/^(?:p|1p|1,[1-9]\d*p)$/.test(script)) return false;
  } else if (program !== "cat") return false;
  if (tokens[0] === "--") tokens.shift();
  return tokens.length > 0 && tokens.every(token => token.length > 0 && !token.startsWith("-") && !/["'*?\[\]]/.test(token))
    && tokens.some(token => matchingReadPath(token, file));
}

/** Only completed provider read operations count; prose and discovery listings do not. */
export function hiringTemplateReadReceipts(readRuns: HiringReadRun[], leadId: string) {
  const receipts: Array<{ file: string; runId: string; itemId: string; createdAt?: string }> = [];
  for (const run of readRuns.filter(run => run.agentId === leadId)) {
    const starts = new Map<string, Record<string, any>>();
    for (const event of run.events) {
      const p = payload(event), item = record(p.item);
      if (event.eventType === "item.started" && item.id) starts.set(item.id, item);
      if (event.eventType !== "item.completed" && event.eventType !== "tool.execution.completed") continue;
      const start = starts.get(item.tool_use_id ?? item.id) ?? item;
      const name = String(start.name ?? "").toLowerCase();
      const input = record(start.input);
      const result = record(item.result);
      const toolRead = item.type === "tool_result" && /^(read|read_file|file_read)$/.test(name)
        && item.isError !== true && item.is_error !== true && result.isError !== true
        && result.is_error !== true && !result.error
        && Object.keys(result).length > 0;
      const commandRead = item.type === "commandExecution" && item.exitCode === 0 && item.status === "completed"
        && typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0;
      const executionRead = event.eventType === "tool.execution.completed" && p.status === "completed";
      const canonicalFileRead = executionRead && p.transport === "builtin" && p.operation === "read" && p.readOnly === true
        && typeof p.outputBytes === "number" && p.outputBytes > 0;
      for (const file of HIRING_TEMPLATE_READ_FILES) {
        if ((toolRead && [input.file_path, input.path, input.filePath].some(path => matchingReadPath(path, file)))
          || (commandRead && commandReads(item.command, file))
          || (executionRead && p.exitCode === 0 && p.outputBytes > 0 && commandReads(p.name, file))
          || (canonicalFileRead && matchingReadPath(p.target, file))) {
          receipts.push({ file, runId: run.runId, itemId: String(item.id ?? p.executionId ?? ""), createdAt: event.createdAt });
        }
      }
    }
  }
  return receipts;
}

export function gradeHiringTemplate(e: HiringTemplateEvidence) {
  const checks: Array<{ id: string; dimension: "outcome" | "coverage"; passed: boolean; detail: string }> = [];
  const check = (id: string, dimension: "outcome" | "coverage", passed: boolean, detail: string) => checks.push({ id, dimension, passed, detail });
  const hires = e.agents.filter(a => a.id !== e.leadId), hired = hires[0];
  const lead = e.agents.find(a => a.id === e.leadId);
  check("one-coder-hire", "outcome", hires.length === 1 && hired?.name === e.hireName && hired.role === "engineer"
    && hired.reportsTo === e.leadId && hired.adapterType === "paperclip_runner", "Exactly one permanent coding teammate reports to the lead.");
  check("execution-account", "outcome", Boolean(e.connectionId) && Boolean(hired && lead)
    && hired?.adapterConfig?.model === lead?.adapterConfig?.model
    && sameJson(hired?.runtimeConfig?.aiConnection, e.binding), "Hire keeps the lead model and managed account binding.");
  const ids = [e.first?.issueId, e.second?.issueId];
  check("two-worker-tasks", "outcome", ids.every(Boolean) && new Set(ids).size === 2 && e.tasks.length === 2
    && ids.every(id => e.tasks.some(t => t.id === id && t.status === "done" && t.assigneeAgentId === hired?.id
      && t.projectId === e.projectId && !t.parentId)), "Both independent tasks are completed by the same coder in the chosen project.");
  const turnAccounting = gradeHiringTemplateTurns({ evidence: e, apiState: e.turnApiState });
  check("bounded-work-and-completion-turns", "outcome", turnAccounting.passed,
    "Exactly three requested lead turns and two coder executions, plus at most two strictly attributed completion notifications; every actual run remains counted.");
  check("initial-json-artifact", "outcome", documentMatches(e.first, expectedFixture(e.inputs, e.marker, "-"))
    && e.first?.createdByAgentId === hired?.id, "Independent computation checks each original input/value and worker authorship.");
  check("reused-json-artifact", "outcome", documentMatches(e.second, expectedFixture(e.inputs, `REUSE${e.marker}`, "_"))
    && e.second?.createdByAgentId === hired?.id, "The reused coder applies the changed separator to every input.");
  check("original-preserved", "outcome", Boolean(e.first) && sameJson(e.first, e.firstAfterReuse), "Reuse preserves the original document, revision and task identity.");
  const requiredSources = [...HIRING_TEMPLATE_READ_FILES.map(file => `skills/paperclip-create-agent/${file}`),
    "skills/paperclip-create-agent/references/baseline-role-guide.md",
    ...Object.keys(e.expectedCeoFiles).map(file => `server/src/onboarding-assets/ceo/${file}`)];
  check("source-fingerprints", "coverage", requiredSources.every(file => /^[a-f0-9]{64}$/.test(e.expectedSourceHashes[file] ?? ""))
    && Object.entries(e.expectedSourceHashes).every(([file, hash]) => e.servedSourceHashes[file] === hash), "Served instruction and hiring source bytes match the evaluated revision.");
  check("production-ceo-bundle", "coverage", e.leadInstructions?.mode === "managed" && e.leadInstructions.entryFile === "AGENTS.md"
    && Object.keys(e.expectedCeoFiles).length > 0 && sameJson(e.leadInstructions.files, e.expectedCeoFiles), "The API-created lead receives this revision's default CEO bundle, without a fixture override.");
  check("assigned-hiring-skill", "coverage", e.assignedSkills.includes(HIRING_TEMPLATE_SKILL_KEY), "Production CEO defaults assign the hiring skill.");
  const receipts = hiringTemplateReadReceipts(e.readRuns, e.leadId);
  check("production-source-reads", "coverage", HIRING_TEMPLATE_READ_FILES.every(file => receipts.some(receipt => receipt.file === file && receipt.itemId
    && Date.parse(receipt.createdAt ?? "") <= Date.parse(hired?.createdAt ?? ""))), "Completed lead read receipts before the hire prove the explicitly requested skill, guide, checklist and coder example paths. Unrecognized or missing reads leave coverage uncomparable.");
  const instruction = e.hiredInstructions?.files["AGENTS.md"] ?? "";
  // The same fixture can compare a long historical role and a short candidate:
  // it requires the supplied role example, never a fixed size or new wording.
  const expectedCoder = e.coderExample.trim();
  check("supplied-coder-instructions", "coverage", expectedCoder.length > 0 && e.hiredInstructions?.mode === "managed"
    && e.hiredInstructions.entryFile === "AGENTS.md" && instruction.trim() === expectedCoder, "Saved hired instructions use the source revision's coder example with its company/name placeholders filled.");
  check("hired-instructions-durable", "coverage", Boolean(e.hiredInstructions) && sameJson(e.hiredInstructions, e.hiredInstructionsAfterReuse), "The same saved instruction bundle survives the reused worker execution.");
  check("hired-skills-durable", "coverage", Boolean(e.hiredSkills) && sameJson(e.hiredSkills, e.hiredSkillsAfterReuse), "The saved skill selections survive the reused worker execution.");
  check("completion-action-attribution", "coverage", turnAccounting.actionEvidence.status !== "uncomparable",
    "Notification actions require exact canonical/native identities; missing cross-namespace mapping is uncomparable, not proof of extra work.");
  return {
    checks, readReceipts: receipts, turnAccounting,
    outcomePassed: checks.filter(c => c.dimension === "outcome").every(c => c.passed),
    comparisonStatus: checks.filter(c => c.dimension === "coverage").every(c => c.passed) ? "comparable" : "uncomparable",
    instructionSizes: { ceo: Object.fromEntries(Object.entries(e.leadInstructions?.files ?? {}).map(([file, content]) => [file, hiringTemplateSize(content)])), coder: hiringTemplateSize(instruction) },
  };
}
