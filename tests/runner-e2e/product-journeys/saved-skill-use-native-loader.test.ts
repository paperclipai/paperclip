import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromOpenCodePart } from "../../../packages/paperclip-runner/src/provider-events.js";
import { openCodeProxyToolNotification } from "../../../packages/paperclip-runner/src/cli/opencode-proxy-events.js";
import { validatePrpEvent } from "../../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { savedSkillFixture, savedSkillReadAssignment, savedSkillReadReceipts, savedSkillReadRuntimeName } from "./saved-skill-use-evidence.js";

type Row = Record<string, any>;
const binding = { companyId: "company", agentId: "agent", runId: "run" };
const fixture = savedSkillFixture("native-loader", "62ff548dfec748da8fef6d5fbf6cc23d");
const key = `company/${binding.companyId}/${fixture.slug}`, runtimeName = `${fixture.slug}--0123456789`;
const body = `<skill_content name="${fixture.slug}">\n# Skill: ${fixture.slug}\n\n${fixture.procedure.trim()}\n\n`
  + `Base directory for this skill: /workspace/.claude/skills/${runtimeName}\n`
  + "Relative paths are relative to this base directory.\n\n<skill_files>\n</skill_files>\n</skill_content>";

function observations() {
  const skill = { key, currentVersionId: "version" };
  const assignments = { entries: [{ key, versionId: "version", runtimeName }] };
  const run: Row = { id: "run", companyId: "company", agentId: "agent", runtimeMode: "native",
    runnerInstanceId: "runner", nativeSessionId: "session",
    contextSnapshot: { skillSelectionSnapshot: true, skillVersions: { [key]: "version" } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode" },
      runtimeContext: { skills: [{ key, versionId: "version", runtimeName }] } } } };
  const notifications: Row[] = [];
  const events = ["pending", "completed"].map((status, index) => {
    const direct = canonicalProviderEventsFromOpenCodePart({ id: "load", type: "tool", tool: "skill",
      state: { status, output: index ? body : "" } })[0]!;
    const forwarded = openCodeProxyToolNotification({ eventType: direct.eventType, threadId: "session",
      turnId: "turn", payload: direct.payload })!;
    notifications.push(forwarded);
    // Actual Core091 retained builtin fixture. The real proxy drops operation;
    // Rust provider_events.rs maps builtinToolCall to unknown, not TS's execute.
    // This JS fixture does not claim to run the Rust converter itself.
    const payload: Row = { ...direct.payload, operation: "unknown" };
    const eventType = direct.eventType;
    return { ...binding, seq: index + 1, eventType, protocolSchemaVersion: 1,
      sourceSeq: index + 1, sourceEventId: `event-${index}`, sourceInstanceId: "runner",
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner",
        priority: 0, emittedAt: "2026-11-04T04:00:00.000Z",
        runId: "run", normalizedSessionId: "session", turnId: "turn", itemId: "item",
        sourceSeq: index + 1, sourceEventId: `event-${index}`, sourceInstanceId: "runner", eventType, payload } } };
  });
  return { skill, assignments, run, events, notifications };
}
type Observations = ReturnType<typeof observations>;
const read = (value: Observations) => savedSkillReadReceipts(value.events, binding, fixture,
  savedSkillReadRuntimeName(value.skill, value.assignments, value.run),
  savedSkillReadAssignment(value.skill, value.assignments, value.run), value.run);
const completed = (v: Observations) => v.events[1]!.payload.prpEvent.payload;
function output(v: Observations, change: (text: string) => string) {
  const payload = completed(v); payload.output = change(payload.output); payload.outputBytes = Buffer.byteLength(payload.output);
}

describe("saved-skill native OpenCode builtin loader", () => {
  it("keeps the real proxy's builtin identity and qualifies Core091's version-bound native receipt", () => {
    const value = observations();
    expect(value.notifications[0]!.params.item).toMatchObject({ type: "builtinToolCall", tool: "skill", readOnlyHint: false });
    expect(value.notifications[0]!.params.item).not.toHaveProperty("operation");
    expect(completed(value)).toMatchObject({ operation: "unknown", readOnly: false, transport: "builtin" });
    for (const row of value.events) expect(validatePrpEvent(row.payload.prpEvent).ok).toBe(true);
    expect(read(value)).toEqual([{ runId: "run", executionId: "load", seq: 2 }]);
  });
  it("accepts an absolute local directory with a space and its optional trailing slash", () => {
    const value = observations(); output(value, text => text.replace("/workspace/", "/work space/")
      .replace(`${runtimeName}\n`, `${runtimeName}/\n`)); expect(read(value)).toHaveLength(1);
  });
  it.each([
    ["missing start", (v: Observations) => { v.events.shift(); }],
    ["missing completion", (v: Observations) => { v.events.pop(); }],
    ["duplicate start", (v: Observations) => { v.events.push(structuredClone(v.events[0]!)); }],
    ["duplicate completion", (v: Observations) => { v.events.push(structuredClone(v.events[1]!)); }],
    ["foreign call", (v: Observations) => { v.events[0]!.payload.prpEvent.payload.executionId = "foreign"; }],
    ["foreign run", (v: Observations) => { v.events[1]!.runId = v.events[1]!.payload.prpEvent.runId = "foreign"; }],
    ["foreign company", (v: Observations) => { v.events[1]!.companyId = "foreign"; }],
    ["foreign agent", (v: Observations) => { v.events[1]!.agentId = "foreign"; }],
    ["foreign runner", (v: Observations) => { v.events[1]!.sourceInstanceId = v.events[1]!.payload.prpEvent.sourceInstanceId = "foreign"; }],
    ["foreign turn", (v: Observations) => { v.events[0]!.payload.prpEvent.turnId = "foreign"; }],
    ["foreign session", (v: Observations) => { v.events[0]!.payload.prpEvent.normalizedSessionId = "foreign"; }],
    ["foreign item", (v: Observations) => { v.events[0]!.payload.prpEvent.itemId = "foreign"; }],
    ["missing session", (v: Observations) => { delete v.run.nativeSessionId; }],
    ["missing runner", (v: Observations) => { delete v.run.runnerInstanceId; }],
    ["wrong native provider", (v: Observations) => { v.run.runnerProfileJson.nativeExecutionInput.provider.kind = "codex"; }],
    ["wrong run owner", (v: Observations) => { v.run.companyId = "foreign"; }],
    ["unselected skill", (v: Observations) => { v.run.contextSnapshot.skillSelectionSnapshot = false; }],
    ["foreign admitted version", (v: Observations) => { v.run.contextSnapshot.skillVersions[key] = "foreign"; }],
    ["foreign API version", (v: Observations) => { v.assignments.entries[0]!.versionId = "foreign"; }],
    ["foreign API runtime directory", (v: Observations) => { v.assignments.entries[0]!.runtimeName = "foreign"; }],
    ["foreign native version", (v: Observations) => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].versionId = "foreign"; }],
    ["duplicate native assignment", (v: Observations) => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills.push(v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]); }],
    ["failed load", (v: Observations) => { completed(v).status = "failed"; }],
    ["truncated load", (v: Observations) => { completed(v).outputTruncated = true; }],
    ["wrong bytes", (v: Observations) => { completed(v).outputBytes++; }],
    ["another operation", (v: Observations) => { for (const row of v.events) row.payload.prpEvent.payload.operation = "read"; }],
    ["wrong completed hint", (v: Observations) => { completed(v).readOnly = true; }],
    ["wrong started hint", (v: Observations) => { v.events[0]!.payload.prpEvent.payload.readOnly = true; }],
    ["started target", (v: Observations) => { v.events[0]!.payload.prpEvent.payload.target = "/foreign"; }],
    ["completed target", (v: Observations) => { completed(v).target = "/foreign"; }],
    ["reversed row order", (v: Observations) => { v.events[0]!.seq = 3; }],
    ["reversed source order", (v: Observations) => { v.events[0]!.sourceSeq = v.events[0]!.payload.prpEvent.sourceSeq = 3; }],
    ["raw dynamic loader", (v: Observations) => { for (const row of v.events) row.payload.prpEvent.payload.transport = "dynamic"; }],
    ["MCP loader", (v: Observations) => { for (const row of v.events) row.payload.prpEvent.payload.transport = "mcp"; }],
    ["copied shell output", (v: Observations) => { for (const row of v.events) row.payload.prpEvent.payload.name = "bash"; }],
    ["foreign skill name", (v: Observations) => { output(v, text => text.replaceAll(fixture.slug, "foreign")); }],
    ["foreign heading", (v: Observations) => { output(v, text => text.replace(`# Skill: ${fixture.slug}`, "# Skill: foreign")); }],
    ["nonce only", (v: Observations) => { output(v, text => text.replace(fixture.procedure.trim(), fixture.expected.reference)); }],
    ["changed source body", (v: Observations) => { output(v, text => text.replace(fixture.procedure.trim(), fixture.procedure.trim() + "\nChanged.")); }],
    ["foreign base directory", (v: Observations) => { output(v, text => text.replace(runtimeName, "foreign")); }],
    ["nonempty skill inventory", (v: Observations) => { output(v, text => text.replace("<skill_files>\n", "<skill_files>\nother.txt\n")); }],
    ["duplicate inventory", (v: Observations) => { output(v, text => text.replace("</skill_files>", "</skill_files><skill_files></skill_files>")); }],
    ["extra inventory closing tag", (v: Observations) => { output(v, text => text.replace("</skill_files>", "</skill_files></skill_files>")); }],
    ["extra wrapper closing tag", (v: Observations) => { output(v, text => text.replace("</skill_content>", "</skill_content></skill_content>")); }],
  ] as const)("rejects %s", (_label, mutate) => { const value = observations(); mutate(value); expect(read(value)).toEqual([]); });
  it.each([
    "https://example.test/.claude/skills/", "file://foreign/.claude/skills/", "file:///workspace/.claude/skills/",
    "relative/.claude/skills/", "/workspace/../.claude/skills/", "/workspace/%2e%2e/.claude/skills/",
    "/workspace%2fother/.claude/skills/", "/workspace%5cother/.claude/skills/",
    "/workspace%00/.claude/skills/", "/workspace%0a/.claude/skills/", "/workspace\\other/.claude/skills/",
  ])("rejects an unbound or ambiguous base address %s", prefix => {
    const value = observations(); output(value, text => text.replace("/workspace/.claude/skills/", prefix));
    expect(read(value)).toEqual([]);
  });
  it.each(["?query", "#fragment", "/../foreign", "%00", "%2Fextra"])("rejects URI suffix %s", suffix => {
    const value = observations(); output(value, text => text.replace(`${runtimeName}\n`, `${runtimeName}${suffix}\n`));
    expect(read(value)).toEqual([]);
  });
});
