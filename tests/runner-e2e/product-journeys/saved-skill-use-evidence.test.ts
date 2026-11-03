import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { savedSkillDocumentAttributed, savedSkillFixture, savedSkillReadReceipts, savedSkillResultMatches, savedSkillSourceMatches } from "./saved-skill-use-evidence.js";

type Row = Record<string, any>;
const fixture = savedSkillFixture("campaign-id", "62ff548dfec748da8fef6d5fbf6cc23d");
const binding = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run" };
function native(seq: number, eventType: string, payload: Row): Row {
  return { ...binding, seq, eventType, protocolSchemaVersion: 1, sourceSeq: seq, sourceInstanceId: "runner-instance", sourceEventId: `event-${seq}`,
    payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", runId: binding.runId,
      sourceSeq: seq, sourceInstanceId: "runner-instance", sourceEventId: `event-${seq}`, turnId: "turn", eventType, payload } } };
}
function readEvents(): Row[] {
  const payload = { schema: "paperclip.tool.execution.v1", executionId: "read-skill", name: "read", operation: "read",
    transport: "builtin", readOnly: true, target: `/workspace/.agents/skills/${fixture.slug}/SKILL.md` };
  return [native(1, "tool.execution.started", { ...payload, status: "running" }),
    native(2, "tool.execution.completed", { ...payload, status: "completed", output: fixture.markdown, outputBytes: Buffer.byteLength(fixture.markdown), outputTruncated: false })];
}
function source() {
  const skill: Row = { id: "skill", companyId: binding.companyId, key: "local:qa-skill", slug: fixture.slug,
    markdown: fixture.markdown, currentVersionId: "version" };
  const version: Row = { id: "version", companyId: binding.companyId, companySkillId: skill.id,
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: fixture.markdown }] };
  const assignments: Row = { desiredSkillEntries: [{ key: skill.key, versionId: version.id }] };
  return { skill, version, assignments };
}
function output() {
  const document: Row = { id: "document", companyId: binding.companyId, issueId: binding.issueId, key: fixture.key, format: "markdown",
    latestRevisionId: "revision", latestRevisionNumber: 1, createdByAgentId: binding.agentId, createdByUserId: null,
    updatedByAgentId: binding.agentId, updatedByUserId: null, body: JSON.stringify(fixture.expected) };
  const revision: Row = { id: "revision", documentId: document.id, companyId: binding.companyId, issueId: binding.issueId,
    key: fixture.key, format: "markdown", revisionNumber: 1, createdByAgentId: binding.agentId, createdByUserId: null, createdByRunId: binding.runId,
    body: document.body };
  return { document, revision };
}

describe("saved skill use evidence", () => {
  it("keeps the random output reference in the skill, independently of its discoverable name", () => {
    expect(fixture.markdown).toContain(fixture.expected.reference);
    expect(fixture.name + fixture.slug).not.toContain(fixture.expected.reference);
    expect(savedSkillFixture("journey-1234-5678", fixture.expected.reference).name).toContain("journey-1234-5678");
    expect(fixture.markdown).not.toContain("\\n");
    expect(() => savedSkillFixture("", fixture.expected.reference)).toThrow();
    expect(() => savedSkillFixture(fixture.expected.reference, fixture.expected.reference)).toThrow();
    expect(() => savedSkillFixture("campaign", "short")).toThrow();
  });
  it("requires exactly the assigned saved version and its original source bytes", () => {
    const good = source();
    expect(savedSkillSourceMatches(good.skill, good.version, good.assignments, fixture, binding.companyId)).toBe(true);
    const changes: Array<(value: ReturnType<typeof source>) => void> = [
      v => { v.skill.companyId = "foreign"; }, v => { v.version.companyId = "foreign"; },
      v => { v.version.companySkillId = "foreign"; }, v => { v.skill.slug = "foreign"; },
      v => { v.skill.markdown += "changed"; }, v => { v.version.id = "stale"; },
      v => { v.version.fileInventory = []; }, v => { v.version.fileInventory[0].content += "changed"; },
      v => { v.version.fileInventory[0].encoding = "base64"; }, v => { v.assignments.desiredSkillEntries = []; },
      v => { v.assignments.desiredSkillEntries[0].versionId = null; }, v => { v.assignments.desiredSkillEntries[0].key = "foreign"; },
      v => { v.assignments.desiredSkillEntries.push(v.assignments.desiredSkillEntries[0]); },
    ];
    for (const change of changes) {
      const wrong = source(); change(wrong);
      expect(savedSkillSourceMatches(wrong.skill, wrong.version, wrong.assignments, fixture, binding.companyId)).toBe(false);
    }
    expect(savedSkillSourceMatches(undefined, good.version, good.assignments, fixture, binding.companyId)).toBe(false);
  });
  it("accepts the bound successful source read and rejects missing, foreign, claimed and failed reads", () => {
    expect(savedSkillReadReceipts(readEvents(), binding, fixture)).toEqual([{ runId: "run", executionId: "read-skill", seq: 2 }]);
    const changes: Array<(events: Row[]) => void> = [
      e => { e.splice(0, 1); }, e => { e.pop(); }, e => { e[1].runId = "foreign"; },
      e => { e[1].companyId = "foreign"; }, e => { e[1].agentId = "foreign"; },
      e => { e[1].payload.prpEvent.runId = "foreign"; }, e => { e[1].payload.prpEvent.sourceKind = "provider"; },
      e => { e[1].sourceInstanceId = "foreign"; }, e => { e[1].sourceSeq += 1; },
      e => { e[1].payload.prpEvent.turnId = "foreign"; }, e => { e[1].payload.prpEvent.payload.status = "failed"; },
      e => { for (const row of e) delete row.payload.prpEvent.turnId; },
      e => { e[1].payload.prpEvent.payload.outputBytes = 0; }, e => { e[1].payload.prpEvent.payload.outputTruncated = true; },
      e => { delete e[1].payload.prpEvent.payload.outputTruncated; },
      e => { e[1].payload.prpEvent.payload.output = "I read the skill and followed it."; },
      e => { for (const row of e) row.payload.prpEvent.payload.target = `/workspace/other/${fixture.slug}/../SKILL.md`; },
      e => { for (const row of e) row.payload.prpEvent.payload.target = "/workspace/other-skill/SKILL.md"; },
      e => { for (const row of e) row.payload.prpEvent.payload.target = null; },
      e => { for (const row of e) Object.assign(row.payload.prpEvent.payload, { name: "bash", operation: "execute", transport: "process" }); },
      e => { e[1].payload.prpEvent.payload.executionId = "other-read"; },
      e => { e[1].payload.prpEvent.eventType = e[1].eventType = "item.completed"; },
    ];
    for (const change of changes) {
      const wrong = readEvents(); change(wrong);
      expect(savedSkillReadReceipts(wrong, binding, fixture)).toEqual([]);
    }
    expect(savedSkillReadReceipts([], binding, fixture)).toEqual([]);
  });
  it("accepts the real OpenCode native skill-loader mapping, including its completed provider output", () => {
    const part = (status: string) => ({ id: "load-skill", type: "tool", tool: "skill", state: {
      status, output: `<skill_content name="${fixture.slug}">\n${fixture.procedure}\n</skill_content>`,
    } });
    const events = ["pending", "completed"].map((status, index) => {
      const event = canonicalProviderEventsFromOpenCodePart(part(status))[0]!;
      return native(index + 1, event.eventType, event.payload);
    });
    expect(savedSkillReadReceipts(events, binding, fixture)).toHaveLength(1);
    for (const output of [fixture.procedure, `<skill_content name="other-skill">\n${fixture.procedure}\n</skill_content>`]) {
      const wrong = structuredClone(events); wrong[1]!.payload.prpEvent.payload.output = output;
      wrong[1]!.payload.prpEvent.payload.outputBytes = Buffer.byteLength(output);
      expect(savedSkillReadReceipts(wrong, binding, fixture)).toEqual([]);
    }
  });
  it("allows known file-reader line prefixes without treating partial output as a complete read", () => {
    const events = readEvents();
    events[1]!.payload.prpEvent.payload.output = fixture.markdown.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
    events[1]!.payload.prpEvent.payload.outputBytes = Buffer.byteLength(events[1]!.payload.prpEvent.payload.output);
    expect(savedSkillReadReceipts(events, binding, fixture)).toHaveLength(1);
    events[1]!.payload.prpEvent.payload.output = fixture.expected.reference;
    events[1]!.payload.prpEvent.payload.outputBytes = Buffer.byteLength(fixture.expected.reference);
    expect(savedSkillReadReceipts(events, binding, fixture)).toEqual([]);
  });
  it("requires the exact derived result and a saved revision authored by this run", () => {
    const good = output();
    expect(savedSkillResultMatches(`\u0060\u0060\u0060json\n${good.document.body}\n\u0060\u0060\u0060`, fixture.expected)).toBe(true);
    expect(savedSkillDocumentAttributed(good.document, good.revision, fixture, binding)).toBe(true);
    for (const body of ["I finished", "{}", JSON.stringify({ ...fixture.expected, extra: true }),
      JSON.stringify({ ...fixture.expected, total: fixture.expected.total + 1 }), JSON.stringify({ ...fixture.expected, reference: "foreign" })]) {
      expect(savedSkillResultMatches(body, fixture.expected)).toBe(false);
    }
    const changes: Array<(value: ReturnType<typeof output>) => void> = [
      v => { v.document.companyId = "foreign"; }, v => { v.document.issueId = "foreign"; },
      v => { v.document.createdByAgentId = "foreign"; }, v => { v.document.updatedByAgentId = "foreign"; },
      v => { v.document.createdByUserId = "owner"; }, v => { v.document.updatedByUserId = "owner"; },
      v => { v.document.key = "other"; }, v => { v.document.body = "{}"; },
      v => { v.document.latestRevisionId = null; }, v => { v.revision.id = "old"; },
      v => { delete v.document.latestRevisionNumber; delete v.revision.revisionNumber; },
      v => { v.revision.documentId = "foreign"; }, v => { v.revision.companyId = "foreign"; },
      v => { v.revision.issueId = "foreign"; }, v => { v.revision.key = "other"; },
      v => { v.revision.format = "unknown"; },
      v => { v.revision.createdByRunId = "foreign"; }, v => { v.revision.createdByAgentId = "foreign"; },
      v => { v.revision.createdByUserId = "owner"; }, v => { v.revision.revisionNumber = 2; },
      v => { v.revision.body = "{}"; },
    ];
    for (const change of changes) {
      const wrong = output(); change(wrong);
      expect(savedSkillDocumentAttributed(wrong.document, wrong.revision, fixture, binding)).toBe(false);
    }
    expect(savedSkillDocumentAttributed(undefined, good.revision, fixture, binding)).toBe(false);
  });
});
