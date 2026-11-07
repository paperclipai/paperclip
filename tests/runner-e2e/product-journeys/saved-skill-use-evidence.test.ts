import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { savedSkillDocumentAttributed, savedSkillFixture, savedSkillReadAssignment, savedSkillReadReceipts, savedSkillReadRuntimeName, savedSkillResultMatches, savedSkillSourceMatches } from "./saved-skill-use-evidence.js";

type Row = Record<string, any>;
const fixture = savedSkillFixture("campaign-id", "62ff548dfec748da8fef6d5fbf6cc23d");
const binding = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run" };
const assignment = { key: `company/${binding.companyId}/${fixture.slug}`, versionId: "version" };
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
const runtimeName = `${fixture.slug}--0123456789`;
function wrappedReadEvents(): Row[] {
  const output = `<path>/workspace/.claude/skills/${runtimeName}/SKILL.md</path>\n<type>file</type>\n<content>\n`
    + fixture.markdown.trimEnd().split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n")
    + "\n(End of file - total 12 lines)\n</content>";
  const events = readEvents();
  for (const row of events) Object.assign(row.payload.prpEvent.payload, { operation: "unknown", target: null });
  Object.assign(events[1]!.payload.prpEvent.payload, { output, outputBytes: Buffer.byteLength(output) });
  return events;
}
function assignedReadEvents(): Row[] {
  const result = { skill: `company/${binding.companyId}/${fixture.slug}`, versionId: "version", path: "SKILL.md",
    text: fixture.markdown, sha256: createHash("sha256").update(fixture.markdown).digest("hex"),
    byteSize: Buffer.byteLength(fixture.markdown), nextOffset: null };
  const output = JSON.stringify({ type: "inputText", text: JSON.stringify(result) });
  const events = readEvents();
  for (const row of events) Object.assign(row.payload.prpEvent.payload,
    { name: "paperclip_read_assigned_skill", operation: "unknown", target: null });
  Object.assign(events[1]!.payload.prpEvent.payload, { output, outputBytes: Buffer.byteLength(output) });
  return events;
}
function changeAssignedResult(events: Row[], change: (value: Row) => void) {
  const payload = events[1]!.payload.prpEvent.payload, wrapper = JSON.parse(payload.output), result = JSON.parse(wrapper.text);
  change(result); wrapper.text = JSON.stringify(result); payload.output = JSON.stringify(wrapper);
}
function source() {
  const skill: Row = { id: "skill", companyId: binding.companyId, key: `company/${binding.companyId}/${fixture.slug}`, sourceType: "managed", name: fixture.name, slug: fixture.slug,
    markdown: fixture.markdown, currentVersionId: "version" };
  const version: Row = { id: "version", companyId: binding.companyId, companySkillId: skill.id,
    fileInventory: [{ path: "SKILL.md", kind: "skill", content: fixture.markdown }] };
  const assignments: Row = { desiredSkillEntries: [{ key: skill.key, versionId: null }] };
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
    const owned = savedSkillFixture("journey-1234-5678", fixture.expected.reference);
    expect(owned.name).toBe(owned.slug);
    expect(owned.name).toContain("journey-1234-5678");
    expect(owned.markdown).toContain(`\nname: ${owned.name}\n`);
    expect(fixture.markdown).not.toContain("\\n");
    expect(() => savedSkillFixture("", fixture.expected.reference)).toThrow();
    expect(() => savedSkillFixture(fixture.expected.reference, fixture.expected.reference)).toThrow();
    expect(() => savedSkillFixture("campaign", "short")).toThrow();
  });
  it("requires an ordinary Latest assignment, its exact managed current version and original source bytes", () => {
    const good = source();
    expect(savedSkillSourceMatches(good.skill, good.version, good.assignments, fixture, binding.companyId)).toBe(true);
    const changes: Array<(value: ReturnType<typeof source>) => void> = [
      v => { v.skill.companyId = "foreign"; }, v => { v.version.companyId = "foreign"; },
      v => { v.version.companySkillId = "foreign"; }, v => { v.skill.slug = "foreign"; },
      v => { v.skill.name = "different saved name"; },
      v => { v.skill.sourceType = "local_path"; },
      v => { v.skill.key = "unknown"; v.assignments.desiredSkillEntries[0].key = "unknown"; },
      v => { v.skill.currentVersionId = "different"; },
      v => { v.skill.markdown += "changed"; }, v => { v.version.id = "stale"; },
      v => { v.version.fileInventory = []; }, v => { v.version.fileInventory[0].content += "changed"; },
      v => { v.version.fileInventory[0].encoding = "base64"; }, v => { v.assignments.desiredSkillEntries = []; },
      v => { v.assignments.desiredSkillEntries[0].versionId = "version"; },
      v => { v.assignments.desiredSkillEntries[0].versionId = "stale"; },
      v => { delete v.assignments.desiredSkillEntries[0].versionId; },
      v => { v.assignments.desiredSkillEntries[0].key = "foreign"; },
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
  it("accepts the deployed OpenCode read wrapper for its exact version-bound runtime skill directory", () => {
    expect(savedSkillReadReceipts(wrappedReadEvents(), binding, fixture, runtimeName)).toHaveLength(1);
    expect(savedSkillReadReceipts(wrappedReadEvents(), binding, fixture)).toEqual([]);
  });
  it("accepts the complete first-party assigned-skill receipt with exact immutable source identity and bytes", () => {
    expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, runtimeName, assignment))
      .toEqual([{ runId: "run", executionId: "read-skill", seq: 2 }]);
    expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, undefined, assignment)).toHaveLength(1);
    expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, runtimeName)).toEqual([]);
    expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, runtimeName, { ...assignment, key: "foreign" })).toEqual([]);
    expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, runtimeName, { ...assignment, versionId: "foreign" })).toEqual([]);
  });
  it.each([{ kind: "codex" }, { kind: "acpx", agent: "cursor" }, { kind: "cursor_cloud" }])(
    "binds the semantic source to common native skill entries for %j while preserving the OpenCode file guard", provider => {
      const { skill } = source();
      const good = () => ({ assignments: { entries: [{ key: skill.key, versionId: "version", runtimeName }] },
        run: { contextSnapshot: { skillSelectionSnapshot: true, skillVersions: { [skill.key]: "version" } },
          runnerProfileJson: { nativeExecutionInput: { provider,
            runtimeContext: { skills: [{ key: skill.key, versionId: "version", runtimeName }] } } } } });
      const valid = good(), selected = savedSkillReadAssignment(skill, valid.assignments, valid.run);
      expect(selected).toEqual(assignment);
      expect(savedSkillReadRuntimeName(skill, valid.assignments, valid.run)).toBeUndefined();
      expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, undefined, selected)).toHaveLength(1);
      expect(savedSkillReadReceipts(wrappedReadEvents(), binding, fixture, undefined, selected)).toEqual([]);
      const changes: Array<(value: ReturnType<typeof good>) => void> = [
        v => { v.assignments.entries = []; },
        v => { v.assignments.entries[0]!.key = "foreign"; },
        v => { v.assignments.entries[0]!.versionId = "foreign"; },
        v => { v.assignments.entries.push(v.assignments.entries[0]!); },
        v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; },
        v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.key = "foreign"; },
        v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.versionId = "foreign"; },
        v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills.push(v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!); },
        v => { v.run.contextSnapshot.skillSelectionSnapshot = false; },
        v => { v.run.contextSnapshot.skillVersions = {}; },
        v => { v.run.contextSnapshot.skillVersions[skill.key] = "foreign"; },
      ];
      for (const mutate of changes) {
        const wrong = good(); mutate(wrong);
        const selected = savedSkillReadAssignment(skill, wrong.assignments, wrong.run);
        expect(selected).toBeUndefined();
        expect(savedSkillReadReceipts(assignedReadEvents(), binding, fixture, undefined, selected)).toEqual([]);
      }
    });
  it.each([
    ["foreign canonical key", (e: Row[]) => changeAssignedResult(e, r => { r.skill = "company/foreign/skill"; })],
    ["foreign immutable version", (e: Row[]) => changeAssignedResult(e, r => { r.versionId = "foreign"; })],
    ["wrong file", (e: Row[]) => changeAssignedResult(e, r => { r.path = "other/SKILL.md"; })],
    ["incomplete page", (e: Row[]) => changeAssignedResult(e, r => { r.nextOffset = r.text.length; })],
    ["missing pagination receipt", (e: Row[]) => changeAssignedResult(e, r => { delete r.nextOffset; })],
    ["wrong checksum", (e: Row[]) => changeAssignedResult(e, r => { r.sha256 = "0".repeat(64); })],
    ["wrong source byte count", (e: Row[]) => changeAssignedResult(e, r => { r.byteSize++; })],
    ["partial procedure", (e: Row[]) => changeAssignedResult(e, r => { r.text = fixture.expected.reference; })],
    ["changed full source", (e: Row[]) => changeAssignedResult(e, r => { r.text += "extra source"; })],
    ["semantic failure with copied source", (e: Row[]) => changeAssignedResult(e, r => { r.outcome = "failed"; r.code = "runner_skill_not_assigned"; })],
    ["shell copied receipt", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.name = "bash"; }],
    ["another first-party tool", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.name = "paperclip_read_document"; }],
    ["non-builtin transport", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.transport = "process"; }],
    ["mutating operation", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.operation = "edit"; }],
    ["not read only", (e: Row[]) => { e[1]!.payload.prpEvent.payload.readOnly = false; }],
    ["start not read only", (e: Row[]) => { e[0]!.payload.prpEvent.payload.readOnly = false; }],
    ["failed completion", (e: Row[]) => { e[1]!.payload.prpEvent.payload.status = "failed"; }],
    ["truncated completion", (e: Row[]) => { e[1]!.payload.prpEvent.payload.outputTruncated = true; }],
    ["missing start", (e: Row[]) => { e.splice(0, 1); }],
    ["call mismatch", (e: Row[]) => { e[0]!.payload.prpEvent.payload.executionId = "another-call"; }],
    ["foreign runner", (e: Row[]) => { e[0]!.sourceInstanceId = e[0]!.payload.prpEvent.sourceInstanceId = "another-runner"; }],
    ["foreign run", (e: Row[]) => { e[1]!.runId = e[1]!.payload.prpEvent.runId = "another-run"; }],
    ["foreign company", (e: Row[]) => { e[1]!.companyId = "another-company"; }],
    ["foreign turn", (e: Row[]) => { e[1]!.payload.prpEvent.turnId = "another-turn"; }],
    ["invalid wrapper", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = fixture.markdown; }],
    ["wrong wrapper type", (e: Row[]) => { const p = e[1]!.payload.prpEvent.payload; p.output = p.output.replace("inputText", "outputText"); }],
  ] as const)("rejects a first-party assigned-skill receipt with %s", (_label, mutate) => {
    const events = assignedReadEvents(); mutate(events);
    const completed = events.find(row => row.eventType === "tool.execution.completed")!;
    completed.payload.prpEvent.payload.outputBytes = Buffer.byteLength(completed.payload.prpEvent.payload.output);
    expect(savedSkillReadReceipts(events, binding, fixture, runtimeName, assignment)).toEqual([]);
  });
  it.each([
    ["foreign path", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = e[1]!.payload.prpEvent.payload.output.replace(runtimeName, "foreign"); }],
    ["relative path", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = e[1]!.payload.prpEvent.payload.output.replace("/workspace/", "workspace/"); }],
    ["path traversal", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = e[1]!.payload.prpEvent.payload.output.replace("/workspace/", "/workspace/../"); }],
    ["wrong file type", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = e[1]!.payload.prpEvent.payload.output.replace("<type>file</type>", "<type>directory</type>"); }],
    ["missing wrapper", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = fixture.procedure; }],
    ["partial procedure", (e: Row[]) => { e[1]!.payload.prpEvent.payload.output = e[1]!.payload.prpEvent.payload.output.replace("Do not create other tasks or deliverables.", ""); }],
    ["copied shell output", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.name = "bash"; }],
    ["execute operation", (e: Row[]) => { for (const row of e) row.payload.prpEvent.payload.operation = "execute"; }],
    ["not read only", (e: Row[]) => { e[1]!.payload.prpEvent.payload.readOnly = false; }],
    ["start not read only", (e: Row[]) => { e[0]!.payload.prpEvent.payload.readOnly = false; }],
    ["failed read", (e: Row[]) => { e[1]!.payload.prpEvent.payload.status = "failed"; }],
    ["truncated read", (e: Row[]) => { e[1]!.payload.prpEvent.payload.outputTruncated = true; }],
    ["missing start", (e: Row[]) => { e.shift(); }],
    ["call mismatch", (e: Row[]) => { e[0]!.payload.prpEvent.payload.executionId = "another-call"; }],
    ["foreign runner", (e: Row[]) => { e[0]!.sourceInstanceId = e[0]!.payload.prpEvent.sourceInstanceId = "another-runner"; }],
    ["foreign run", (e: Row[]) => { e[1]!.runId = e[1]!.payload.prpEvent.runId = "another-run"; }],
    ["foreign turn", (e: Row[]) => { e[1]!.payload.prpEvent.turnId = "another-turn"; }],
  ] as const)("rejects a wrapped native read with %s", (_label, mutate) => {
    const events = wrappedReadEvents(); mutate(events);
    const completed = events.find(row => row.eventType === "tool.execution.completed")!;
    completed.payload.prpEvent.payload.outputBytes = Buffer.byteLength(completed.payload.prpEvent.payload.output);
    expect(savedSkillReadReceipts(events, binding, fixture, runtimeName)).toEqual([]);
  });
  it("requires both API and admitted native input to bind the same immutable skill runtime name", () => {
    const { skill } = source();
    const good = () => ({ assignments: { entries: [{ key: skill.key, runtimeName, versionId: "version" }] },
      run: { contextSnapshot: { skillSelectionSnapshot: true, skillVersions: { [skill.key]: "version" } },
        runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode" },
          runtimeContext: { skills: [{ key: skill.key, runtimeName, versionId: "version" }] } } } } });
    const valid = good();
    expect(savedSkillReadRuntimeName(skill, valid.assignments, valid.run)).toBe(runtimeName);
    const changes: Array<(value: ReturnType<typeof good>) => void> = [
      v => { v.assignments.entries = []; },
      v => { v.assignments.entries[0]!.key = "foreign"; },
      v => { v.assignments.entries[0]!.versionId = "stale"; },
      v => { v.assignments.entries[0]!.runtimeName = "foreign"; },
      v => { v.assignments.entries.push(v.assignments.entries[0]!); },
      v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; },
      v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.key = "foreign"; },
      v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.versionId = "stale"; },
      v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.runtimeName = "foreign"; },
      v => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills.push(v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!); },
      v => { v.run.contextSnapshot.skillSelectionSnapshot = false; },
      v => { v.run.contextSnapshot.skillVersions[skill.key] = "stale"; },
      v => { v.run.runnerProfileJson.nativeExecutionInput.provider.kind = "other"; },
      v => { v.assignments.entries[0]!.runtimeName = v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]!.runtimeName = "../foreign"; },
    ];
    for (const mutate of changes) {
      const wrong = good(); mutate(wrong);
      const name = savedSkillReadRuntimeName(skill, wrong.assignments, wrong.run);
      expect(name).toBeUndefined();
      expect(savedSkillReadReceipts(wrappedReadEvents(), binding, fixture, name)).toEqual([]);
    }
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
