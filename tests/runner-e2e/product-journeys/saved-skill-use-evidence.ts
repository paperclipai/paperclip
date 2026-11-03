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
  const suffix = identity.replace(/[^a-z0-9]/gi, "").slice(-32).toLowerCase();
  if (!suffix || identity.includes(reference)) throw new Error("invalid_saved_skill_identity");
  const slug = `qa-saved-skill-${suffix}`, key = "saved-skill-result";
  const seed = createHash("sha256").update(reference).digest();
  const first = seed[0]! + 1, second = seed[1]! + 1;
  const procedure = `# Saved receipt procedure\n\nThe receipt reference is ${reference}.\n`
    + `Add the two amounts ${first} and ${second}.\n`
    + `Save exactly one Paperclip task document with key ${key}. Its body must be JSON with exactly `
    + `two fields: reference (the receipt reference) and total (the sum of the two amounts).\n`
    + "Check the saved document and finish the task. Do not create other tasks or deliverables.\n";
  return { name: `Journey QA saved skill ${identity}`, slug, key, procedure,
    markdown: `---\nname: ${slug}\ndescription: Make a receipt using this saved procedure.\n---\n\n${procedure}`,
    expected: { reference, total: first + second } };
}

export function savedSkillSourceMatches(skill: Row | undefined, version: Row | undefined, assignments: Row | undefined,
  fixture: SavedSkillFixture, companyId: string): boolean {
  if (!skill || !version || !assignments) return false;
  const files = version.fileInventory;
  const entries = assignments.desiredSkillEntries;
  return Boolean(skill.id && skill.companyId === companyId && skill.slug === fixture.slug && skill.key
    && skill.markdown === fixture.markdown && skill.currentVersionId
    && version.id === skill.currentVersionId && version.companyId === companyId && version.companySkillId === skill.id
    && Array.isArray(files) && files.length === 1 && files[0].path === "SKILL.md" && files[0].content === fixture.markdown
    && (files[0].encoding === undefined || files[0].encoding === "utf8")
    && Array.isArray(entries) && entries.filter(row => row.key === skill.key).length === 1
    && entries.find(row => row.key === skill.key)?.versionId === version.id);
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

/** Successful built-in reads and native skill loads expose the actual skill text.
 * A model claim, discovered name, shell echo, failed read or foreign run cannot qualify. */
export function savedSkillReadReceipts(events: Row[], binding: NativePrpRunBinding, fixture: SavedSkillFixture) {
  const bound = events.filter(row => isBoundNativePrpEventRow(row, binding));
  return bound.filter(row => {
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
    if (!reading && !loading) return false;
    // File readers may prefix each source line with its line number.
    const output = payload.output.split("\n").map((line: string) => line.replace(/^\s*\d+(?:[:|]|→)\s?/, "")).join("\n");
    if (!output.includes(fixture.procedure.trim())) return false;
    return bound.some(start => {
      const initial = start.payload.prpEvent, p = initial.payload;
      return initial.eventType === "tool.execution.started" && start.seq < row.seq
        && initial.sourceInstanceId === event.sourceInstanceId && initial.turnId === event.turnId
        && p?.schema === payload.schema && p.executionId === payload.executionId && p.name === payload.name
        && p.transport === payload.transport && p.operation === payload.operation && p.status === "running";
    });
  }).map(row => ({ runId: binding.runId, executionId: String(row.payload.prpEvent.payload.executionId), seq: Number(row.seq) }));
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
