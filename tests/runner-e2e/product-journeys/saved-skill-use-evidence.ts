import { createHash } from "node:crypto";
import { isBoundNativePrpEventRow, type NativePrpRunBinding } from "../native-event-envelope.js";

type Row = Record<string, any>;
export interface SavedSkillFixture {
  name: string; slug: string; key: "saved-skill-result"; markdown: string; procedure: string;
  expected: { reference: string; total: number };
}

/** The public request names the skill; only its saved version contains these inputs. */
export function savedSkillFixture(identity: string, reference: string): SavedSkillFixture {
  if (!/^[a-f0-9]{32}$/.test(reference)) throw new Error("invalid_saved_skill_reference");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(identity) || identity.length > 48 || identity.includes(reference))
    throw new Error("invalid_saved_skill_identity");
  const slug = `qa-saved-skill-${identity}`, key = "saved-skill-result";
  const seed = createHash("sha256").update(reference).digest();
  const first = seed[0]! + 1, second = seed[1]! + 1;
  const procedure = `# Saved receipt procedure\n\nThe receipt reference is ${reference}.\n`
    + `Add the two amounts ${first} and ${second}.\n`
    + `Save exactly one Paperclip task document with key ${key}. Its body must be JSON with exactly `
    + `two fields: reference (the receipt reference) and total (the sum of the two amounts).\n`
    + "Check the saved document and finish the task. Do not create other tasks or deliverables.\n";
  return { name: slug, slug, key, procedure,
    markdown: `---\nname: ${slug}\ndescription: Make a receipt using this saved procedure.\n---\n\n${procedure}`,
    expected: { reference, total: first + second } };
}

export function savedSkillSourceMatches(skill: Row | undefined, version: Row | undefined, assignments: Row | undefined,
  fixture: SavedSkillFixture, companyId: string): boolean {
  if (!skill || !version || !assignments) return false;
  const files = version.fileInventory;
  const entries = assignments.desiredSkillEntries;
  return Boolean(skill.id && skill.companyId === companyId && skill.sourceType === "managed"
    && skill.name === fixture.name && skill.slug === fixture.slug && skill.key === `company/${companyId}/${fixture.slug}`
    && skill.markdown === fixture.markdown && skill.currentVersionId
    && version.id === skill.currentVersionId && version.companyId === companyId && version.companySkillId === skill.id
    && Array.isArray(files) && files.length === 1 && files[0].path === "SKILL.md" && files[0].content === fixture.markdown
    && (files[0].encoding === undefined || files[0].encoding === "utf8")
    && Array.isArray(entries) && entries.filter(row => row.key === skill.key).length === 1
    && entries.find(row => row.key === skill.key)?.versionId === null);
}

export function savedSkillResultMatches(body: unknown, expected: SavedSkillFixture["expected"]): boolean {
  if (typeof body !== "string") return false;
  const text = body.trim(), json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text;
  try {
    const value = JSON.parse(json);
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === "reference,total"
      && value.reference === expected.reference && value.total === expected.total);
  } catch { return false; }
}

export interface SavedSkillReadAssignment { key: string; versionId: string }

/** All native providers share the canonical skill/version selection contract. */
export function savedSkillReadAssignment(skill: Row, assignments: Row, run: Row): SavedSkillReadAssignment | undefined {
  const input = run.runnerProfileJson?.nativeExecutionInput;
  const assigned = Array.isArray(assignments.entries) ? assignments.entries.filter((row: Row) => row.key === skill.key) : [];
  const native = Array.isArray(input?.runtimeContext?.skills)
    ? input.runtimeContext.skills.filter((row: Row) => row.key === skill.key) : [];
  const versions = run.contextSnapshot?.skillVersions;
  if (typeof skill.key !== "string" || !skill.key.trim() || assigned.length !== 1 || native.length !== 1
    || typeof skill.currentVersionId !== "string" || !skill.currentVersionId
    || run.contextSnapshot?.skillSelectionSnapshot !== true
    || !versions || typeof versions !== "object" || Array.isArray(versions) || !Object.hasOwn(versions, skill.key)
    || versions[skill.key] !== skill.currentVersionId
    || assigned[0].versionId !== skill.currentVersionId || native[0].versionId !== skill.currentVersionId) return undefined;
  return { key: skill.key, versionId: skill.currentVersionId };
}

/** OpenCode's file wrapper also needs the exact materialized directory identity. */
export function savedSkillReadRuntimeName(skill: Row, assignments: Row, run: Row): string | undefined {
  if (run.runnerProfileJson?.nativeExecutionInput?.provider?.kind !== "opencode"
    || !savedSkillReadAssignment(skill, assignments, run)) return undefined;
  const assigned = assignments.entries.find((row: Row) => row.key === skill.key);
  const native = run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills.find((row: Row) => row.key === skill.key);
  if (assigned.runtimeName !== native.runtimeName
    || typeof native.runtimeName !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(native.runtimeName)) return undefined;
  return native.runtimeName;
}

/** Core's assigned-skill read verifies the pinned manifest and returns one UTF-8 page. */
function assignedSkillReadText(output: string, binding: NativePrpRunBinding, fixture: SavedSkillFixture, versionId: string): string | undefined {
  try {
    const wrapper = JSON.parse(output);
    if (wrapper?.type !== "inputText" || typeof wrapper.text !== "string"
      || Object.keys(wrapper).sort().join(",") !== "text,type") return undefined;
    const result = JSON.parse(wrapper.text);
    if (Object.keys(result).sort().join(",") !== "byteSize,nextOffset,path,sha256,skill,text,versionId"
      || result.skill !== `company/${binding.companyId}/${fixture.slug}` || result.versionId !== versionId
      || result.path !== "SKILL.md" || result.nextOffset !== null || result.text !== fixture.markdown
      || result.byteSize !== Buffer.byteLength(fixture.markdown)
      || result.sha256 !== createHash("sha256").update(fixture.markdown).digest("hex")) return undefined;
    return result.text;
  } catch { return undefined; }
}

/** OpenCode's proxy forwards the builtin skill loader without an operation.
 * Core091 therefore records unknown/false even though the loader exposes its saved body.
 * Only this complete, immutable-version-bound native loader may use that shape.
 */
function nativeOpenCodeSkillLoad(row: Row, bound: Row[], binding: NativePrpRunBinding, fixture: SavedSkillFixture,
  runtimeName: string | undefined, assignment: SavedSkillReadAssignment | undefined, run: Row | undefined): boolean {
  const event = row.payload.prpEvent, payload = event.payload, input = run?.runnerProfileJson?.nativeExecutionInput;
  const skills = Array.isArray(input?.runtimeContext?.skills)
    ? input.runtimeContext.skills.filter((skill: Row) => skill.key === assignment?.key) : [];
  if (!run || run.runtimeMode !== "native" || input?.provider?.kind !== "opencode"
    || run.id !== binding.runId || run.companyId !== binding.companyId || run.agentId !== binding.agentId
    || typeof run.runnerInstanceId !== "string" || !run.runnerInstanceId.trim()
    || typeof run.nativeSessionId !== "string" || !run.nativeSessionId.trim()
    || event.sourceInstanceId !== run.runnerInstanceId || event.normalizedSessionId !== run.nativeSessionId
    || typeof event.itemId !== "string" || !event.itemId.trim() || !Number.isSafeInteger(row.seq)
    || !assignment || assignment.key !== `company/${binding.companyId}/${fixture.slug}`
    || typeof assignment.versionId !== "string" || !assignment.versionId.trim()
    || skills.length !== 1 || skills[0].versionId !== assignment.versionId || skills[0].runtimeName !== runtimeName
    || run.contextSnapshot?.skillSelectionSnapshot !== true
    || run.contextSnapshot?.skillVersions?.[assignment.key] !== assignment.versionId
    || typeof runtimeName !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(runtimeName)
    || payload.name !== "skill" || payload.operation !== "unknown" || payload.readOnly !== false || payload.target !== null) return false;
  const wrapper = /^<skill_content name="([^"<>\r\n]+)">\n# Skill: ([^\r\n]+)\n\n([\s\S]*?)\n\nBase directory for this skill: ([^\r\n]+)\n([\s\S]*)\n<\/skill_content>\s*$/.exec(payload.output);
  if (!wrapper || wrapper[1] !== fixture.slug || wrapper[2] !== fixture.slug || wrapper[3] !== fixture.procedure.trim()
    || !/<skill_files>\s*<\/skill_files>/.test(wrapper[5]!)
    || (payload.output.match(/<skill_content\b/g) ?? []).length !== 1
    || (payload.output.match(/<\/skill_content>/g) ?? []).length !== 1
    || (payload.output.match(/<skill_files>/g) ?? []).length !== 1
    || (payload.output.match(/<\/skill_files>/g) ?? []).length !== 1) return false;
  // The native loader prints an absolute filesystem path, not a URI.
  const path = wrapper[4]!;
  if (!path.startsWith("/") || /[\\\0\r\n?#]/.test(path) || /%[a-f0-9]{2}/i.test(path)
    || path.split("/").some(part => part === "." || part === "..")
    || !path.replace(/\/$/, "").endsWith(`/.claude/skills/${runtimeName}`)) return false;
  const pair = bound.filter(candidate => ["tool.execution.started", "tool.execution.completed"].includes(candidate.payload.prpEvent.eventType)
    && candidate.payload.prpEvent.payload?.executionId === payload.executionId);
  const start = pair.find(candidate => candidate.payload.prpEvent.eventType === "tool.execution.started");
  const initial = start?.payload.prpEvent, initialPayload = initial?.payload;
  return Boolean(pair.length === 2 && start && Number.isSafeInteger(start.seq) && start.seq < row.seq
    && initial.sourceSeq < event.sourceSeq && initial.normalizedSessionId === event.normalizedSessionId && initial.itemId === event.itemId
    && initialPayload?.readOnly === false && initialPayload.target === null);
}

// Core091 provider_bridge.rs hashes UTF-8 JSON with object keys ordered by UTF-16.
// This oracle reconstructs the complete pinned read result, not provider display text.
function semanticDigest(value: unknown): string {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

/** Codex's raw dynamic name, namespace and optional readOnly hint grant no authority.
 * Its admitted first-party read instead has a controller-bound semantic input/result.
 * Core's read_assigned_skill operation is read-only and verifies the immutable file.
 */
function codexAssignedSkillReceipts(bound: Row[], binding: NativePrpRunBinding, fixture: SavedSkillFixture,
  assignment: SavedSkillReadAssignment | undefined, run: Row | undefined) {
  const input = run?.runnerProfileJson?.nativeExecutionInput;
  const skills = Array.isArray(input?.runtimeContext?.skills)
    ? input.runtimeContext.skills.filter((skill: Row) => skill.key === assignment?.key) : [];
  if (!run || run.runtimeMode !== "native" || input?.provider?.kind !== "codex"
    || run.id !== binding.runId || run.companyId !== binding.companyId || run.agentId !== binding.agentId
    || typeof run.runnerInstanceId !== "string" || !run.runnerInstanceId.trim()
    || typeof run.nativeSessionId !== "string" || !run.nativeSessionId.trim()
    || !assignment || assignment.key !== `company/${binding.companyId}/${fixture.slug}` || !assignment.versionId
    || skills.length !== 1 || skills[0].versionId !== assignment.versionId
    || run.contextSnapshot?.skillSelectionSnapshot !== true
    || run.contextSnapshot?.skillVersions?.[assignment.key] !== assignment.versionId
    || !fixture.markdown.includes(fixture.procedure.trim()) || !fixture.markdown.includes(fixture.expected.reference)) return [];
  const expected = { skill: assignment.key, versionId: assignment.versionId, path: "SKILL.md", text: fixture.markdown,
    sha256: createHash("sha256").update(fixture.markdown, "utf8").digest("hex"),
    byteSize: Buffer.byteLength(fixture.markdown), nextOffset: null };
  const semantic = (row: Row): Row | undefined => row.payload.prpEvent.payload?.semantic_tool;
  const content = (value: Row, digest: string) => value.content?.digest === digest
    && value.content.redactionDisposition === "digest_only" && Array.isArray(value.content.references)
    && value.content.references.length === 0
    && Object.keys(value.content).sort().join(",") === "digest,redactionDisposition,references";
  const correlated = (row: Row, phase: "input" | "result") => {
    const event = row.payload.prpEvent, value = semantic(row), correlation = value?.correlation;
    const keys = ["schema", "schemaVersion", "phase", "operationId", "callId", "correlation", "idempotencyKey", "content",
      ...(phase === "input" ? ["input"] : ["outcome", "code", "retryable", "authorizationBoundary", "operationReceiptId"])];
    return Boolean(value && event.eventType === `semantic_tool.${phase}` && value.phase === phase
      && value.schema === "paperclip.prp.semantic_tool.v1" && value.schemaVersion === 1
      && Object.keys(value).sort().join(",") === keys.sort().join(",")
      && value.operationId === "read_assigned_skill" && typeof value.callId === "string" && value.callId.trim()
      && value.idempotencyKey === null && Number.isSafeInteger(row.seq)
      && event.sourceInstanceId === run.runnerInstanceId && event.normalizedSessionId === run.nativeSessionId
      && typeof event.turnId === "string" && event.turnId.trim() && typeof event.itemId === "string" && event.itemId.trim()
      && correlation && Object.keys(correlation).sort().join(",") === "itemId,normalizedSessionId,runId,turnId"
      && correlation.runId === binding.runId && correlation.normalizedSessionId === run.nativeSessionId
      && correlation.turnId === event.turnId && correlation.itemId === event.itemId);
  };
  return bound.flatMap(start => {
    if (!correlated(start, "input")) return [];
    const initial = semantic(start)!, args = initial.input;
    if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some(key => !["skill", "path", "offset"].includes(key))
      || !(args.skill === assignment.key || typeof skills[0].runtimeName === "string"
        && skills[0].runtimeName.trim() && args.skill === skills[0].runtimeName)
      || Object.hasOwn(args, "path") && args.path !== "SKILL.md"
      || Object.hasOwn(args, "offset") && args.offset !== 0 || !content(initial, semanticDigest(args))) return [];
    // Duplicates, reconciled alternatives and foreign same-call carriers cannot supply a second interpretation.
    const pair = bound.filter(row => semantic(row)?.callId === initial.callId);
    const end = pair.find(row => correlated(row, "result"));
    if (pair.length !== 2 || !end || start.seq >= end.seq
      || start.payload.prpEvent.sourceSeq >= end.payload.prpEvent.sourceSeq) return [];
    const result = semantic(end)!;
    if (semanticDigest(initial.correlation) !== semanticDigest(result.correlation)
      || result.outcome !== "succeeded" || result.code !== "semantic_tool_succeeded" || result.retryable !== false
      || result.authorizationBoundary !== "active_task" || result.operationReceiptId !== `operation_${initial.callId}`
      || !content(result, semanticDigest(expected))) return [];
    return [{ runId: binding.runId, executionId: String(initial.callId), seq: Number(end.seq) }];
  });
}

/** Successful built-in reads and native skill loads expose the actual skill text.
 * A model claim, discovered name, shell echo, failed read or foreign run cannot qualify. */
export function savedSkillReadReceipts(events: Row[], binding: NativePrpRunBinding, fixture: SavedSkillFixture,
  runtimeName?: string, assignment?: SavedSkillReadAssignment, run?: Row) {
  const bound = events.filter(row => isBoundNativePrpEventRow(row, binding));
  const builtin = bound.filter(row => {
    const event = row.payload.prpEvent, payload = event.payload;
    if (event.eventType !== "tool.execution.completed" || payload?.schema !== "paperclip.tool.execution.v1"
      || payload.transport !== "builtin" || payload.status !== "completed"
      || typeof event.turnId !== "string" || !event.turnId.trim()
      || typeof payload.executionId !== "string" || !payload.executionId.trim()
      || payload.outputTruncated !== false || typeof payload.output !== "string" || payload.outputBytes <= 0
      || payload.outputBytes !== Buffer.byteLength(payload.output)) return false;
    const name = String(payload.name ?? "").toLowerCase();
    const target = typeof payload.target === "string" ? payload.target.replaceAll("\\", "/") : "";
    const reading = payload.operation === "read" && payload.readOnly === true && /^(read|read_file|file_read)$/.test(name)
      && !target.split("/").includes("..") && target.endsWith(`/${fixture.slug}/SKILL.md`);
    // OpenCode's skill tool names the loaded skill in its provider-visible result.
    const loading = payload.operation === "execute" && name === "skill"
      && payload.output.includes(`<skill_content name="${fixture.slug}">`);
    const nativeLoading = name === "skill" && payload.operation === "unknown"
      && nativeOpenCodeSkillLoad(row, bound, binding, fixture, runtimeName, assignment, run);
    // Deployed OpenCode reports this read with operation unknown and target null.
    // Its successful file-result wrapper supplies the exact materialized source path.
    const wrapped = /^<path>([^<>\r\n]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\n([\s\S]*)\r?\n<\/content>\s*$/.exec(payload.output);
    const wrappedPath = wrapped?.[1];
    const wrappedRead = name === "read" && payload.readOnly === true && payload.target === null
      && (payload.operation === "unknown" || payload.operation === "read")
      && typeof runtimeName === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(runtimeName)
      && wrappedPath?.startsWith("/") && !wrappedPath.includes("\\") && !wrappedPath.includes("\0")
      && !wrappedPath.split("/").some(part => part === "." || part === "..")
      && wrappedPath.endsWith(`/.claude/skills/${runtimeName}/SKILL.md`);
    // The ordinary semantic tool is another native read path, not a filesystem wrapper.
    // Its canonical key/version binding does not depend on a provider's directory name.
    const assignedText = name === "paperclip_read_assigned_skill" && payload.readOnly === true && payload.target === null
      && (payload.operation === "unknown" || payload.operation === "read")
      && assignment?.key === `company/${binding.companyId}/${fixture.slug}`
      && typeof assignment.versionId === "string" && assignment.versionId.trim()
      ? assignedSkillReadText(payload.output, binding, fixture, assignment.versionId) : undefined;
    if (!reading && !loading && !nativeLoading && !wrappedRead && assignedText === undefined) return false;
    // File readers may prefix each source line with its line number.
    const output = (assignedText ?? (wrappedRead ? wrapped![2]! : payload.output)).split("\n").map((line: string) => line.replace(/^\s*\d+(?:[:|]|→)\s?/, "")).join("\n");
    if (!output.includes(fixture.procedure.trim())) return false;
    return bound.some(start => {
      const initial = start.payload.prpEvent, p = initial.payload;
      return initial.eventType === "tool.execution.started" && start.seq < row.seq
        && initial.sourceInstanceId === event.sourceInstanceId && initial.turnId === event.turnId
        && p?.schema === payload.schema && p.executionId === payload.executionId && p.name === payload.name
        && p.transport === payload.transport && p.operation === payload.operation && p.status === "running"
        && (!(wrappedRead || assignedText !== undefined) || p.readOnly === true);
    });
  }).map(row => ({ runId: binding.runId, executionId: String(row.payload.prpEvent.payload.executionId), seq: Number(row.seq) }));
  return [...builtin, ...codexAssignedSkillReceipts(bound, binding, fixture, assignment, run)];
}

export function savedSkillDocumentAttributed(document: Row | undefined, revision: Row | undefined, fixture: SavedSkillFixture,
  binding: NativePrpRunBinding & { issueId: string }): boolean {
  if (!document || !revision) return false;
  return Boolean(document.id && document.companyId === binding.companyId && document.issueId === binding.issueId
    && document.key === fixture.key && document.format === "markdown" && document.latestRevisionId
    && Number.isSafeInteger(document.latestRevisionNumber) && document.latestRevisionNumber > 0
    && document.createdByAgentId === binding.agentId && document.createdByUserId === null
    && document.updatedByAgentId === binding.agentId && document.updatedByUserId === null
    && savedSkillResultMatches(document.body, fixture.expected)
    && revision.id === document.latestRevisionId && revision.documentId === document.id
    && revision.companyId === binding.companyId && revision.issueId === binding.issueId && revision.key === fixture.key && revision.format === document.format
    && revision.createdByRunId === binding.runId && revision.createdByAgentId === binding.agentId && revision.createdByUserId === null
    && revision.revisionNumber === document.latestRevisionNumber && savedSkillResultMatches(revision.body, fixture.expected));
}
