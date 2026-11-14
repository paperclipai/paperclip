import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalProviderEventsFromCodex } from "../../../packages/paperclip-runner/src/provider-events.js";
import { createPrpSemanticToolInputEnvelope, createPrpSemanticToolResultEnvelope, digestPrpSemanticContent } from "../../../packages/paperclip-runner/src/protocol/semantic-tool-receipts.js";
import { validatePrpEvent } from "../../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { redactEventPayload } from "../../../server/src/redaction.js";
import { readAssignedSkill, RUNNER_BRIDGE_READ_OPERATIONS } from "../../../server/src/services/native-runtime/runner-bridge-tools.js";
import { savedSkillFixture, savedSkillReadAssignment, savedSkillReadReceipts } from "./saved-skill-use-evidence.js";

type Row = Record<string, any>;
const binding = { companyId: "company", agentId: "agent", runId: "run" };
const fixture = savedSkillFixture("codex-campaign", "62ff548dfec748da8fef6d5fbf6cc23d");
const key = `company/${binding.companyId}/${fixture.slug}`, runtimeName = `${fixture.slug}--0123456789`;
const correlation = { runId: "run", normalizedSessionId: "native-session", turnId: "turn", itemId: "item" };
const callId = "assigned-read";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function event(seq: number, eventType: string, payload: Row, itemId = correlation.itemId): Row {
  return { ...binding, seq, eventType, protocolSchemaVersion: 1, sourceSeq: seq,
    sourceInstanceId: "runner-instance", sourceEventId: `event-${seq}`,
    payload: redactEventPayload({ prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", ...correlation, itemId,
      priority: 0, emittedAt: "2026-11-03T12:00:00.000Z",
      sourceSeq: seq, sourceInstanceId: "runner-instance", sourceEventId: `event-${seq}`,
      eventType, payload,
    } }) };
}

// Read the real immutable-file producer, not a hand-written success result. No model or DB is used.
async function observedRead(text = fixture.markdown, rawInput?: Row) {
  const directory = await mkdtemp(path.join(tmpdir(), "saved-skill-native-read-"));
  try {
    const files = [{ path: "SKILL.md", sha256: hash(text), mode: 0o444, size: Buffer.byteLength(text) }];
    const digest = hash(JSON.stringify(files)), rootPath = path.join(directory, "bundles", digest);
    const manifest = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest,
      fileCount: 1, totalBytes: Buffer.byteLength(text), files })}\n`;
    await mkdir(rootPath, { recursive: true });
    await mkdir(path.join(directory, "manifests"));
    await writeFile(path.join(rootPath, "SKILL.md"), text);
    await writeFile(path.join(directory, "manifests", `${digest}.json`), manifest);
    const bundle = { rootPath, digest, manifestDigest: hash(manifest) };
    const input = rawInput ?? { offset: 0, skill: key, path: "SKILL.md" };
    const result = await readAssignedSkill({ skills: [{ key, runtimeName, versionId: "version", bundle }] } as any, input);
    return { input, result };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function observations(text = fixture.markdown, rawInput?: Row) {
  const { input, result } = await observedRead(text, rawInput);
  const run: Row = { id: binding.runId, companyId: binding.companyId, agentId: binding.agentId, runtimeMode: "native",
    runnerInstanceId: "runner-instance", nativeSessionId: correlation.normalizedSessionId,
    contextSnapshot: { skillSelectionSnapshot: true, skillVersions: { [key]: "version" } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" },
      runtimeContext: { skills: [{ key, versionId: "version", runtimeName }] } } } };
  const assignment = savedSkillReadAssignment({ key, currentVersionId: "version" },
    { entries: [{ key, versionId: "version", runtimeName }] }, run)!;
  // Core091 provider_backend.rs uses these protocol envelopes, adds safe input,
  // and names the successful fallback receipt operation_<callId>.
  const semanticInput = { ...createPrpSemanticToolInputEnvelope({ operationId: "read_assigned_skill", callId,
    correlation, content: input }), input };
  const semanticResult = createPrpSemanticToolResultEnvelope({ operationId: "read_assigned_skill", callId,
    correlation, content: result, outcome: "succeeded", code: "semantic_tool_succeeded", retryable: false,
    authorizationBoundary: "active_task", operationReceiptId: `operation_${callId}` });
  // Genuine converter output has dynamic transport and no invented first-party namespace/readOnly hint.
  const dynamic = ["item/started", "item/completed"].map(method => canonicalProviderEventsFromCodex(method,
    { item: { id: callId, type: "dynamicToolCall", tool: "read_assigned_skill", status: "completed" } })[0]!);
  const events = [event(1, dynamic[0]!.eventType, dynamic[0]!.payload, dynamic[0]!.itemId),
    event(2, "semantic_tool.input", { semantic_tool: semanticInput }),
    event(3, "semantic_tool.result", { semantic_tool: semanticResult }),
    event(4, dynamic[1]!.eventType, dynamic[1]!.payload, dynamic[1]!.itemId)];
  return { events, run, assignment, result, input };
}

const read = (value: Awaited<ReturnType<typeof observations>>, f = fixture) =>
  savedSkillReadReceipts(value.events, binding, f, undefined, value.assignment, value.run);
const semantic = (value: Awaited<ReturnType<typeof observations>>, index: number) =>
  value.events[index]!.payload.prpEvent.payload.semantic_tool as Row;

describe("saved-skill Codex native authority", () => {
  it("accepts the complete real read's authoritative input/result commitment after API redaction", async () => {
    const value = await observations();
    expect(RUNNER_BRIDGE_READ_OPERATIONS.has("read_assigned_skill")).toBe(true);
    expect(Object.keys(value.result).sort()).toEqual(["byteSize", "nextOffset", "path", "sha256", "skill", "text", "versionId"]);
    for (const row of value.events) expect(validatePrpEvent(row.payload.prpEvent).ok).toBe(true);
    expect(value.events[0]!.payload.prpEvent.payload).toMatchObject({ transport: "dynamic", readOnly: null, namespace: null });
    expect(read(value)).toEqual([{ runId: "run", executionId: callId, seq: 3 }]);
  });

  it("checks UTF-8 source bytes and canonical key order using the real Unicode producer", async () => {
    const text = `${fixture.markdown}\nUnicode: café 🌍\n`;
    const value = await observations(text);
    expect(value.result.byteSize).toBe(Buffer.byteLength(text));
    expect(value.result.byteSize).toBeGreaterThan(text.length);
    expect(read(value, { ...fixture, markdown: text })).toHaveLength(1);
  });

  it("accepts Core's omitted defaults and only its exact admitted runtime alias", async () => {
    const value = await observations(fixture.markdown, { skill: runtimeName });
    expect(read(value)).toHaveLength(1);
  });

  it("rejects raw dynamic calls even when they copy the complete source and invent readOnly/namespace", async () => {
    const value = await observations();
    value.events = [value.events[0]!, value.events[3]!];
    for (const row of value.events) Object.assign(row.payload.prpEvent.payload,
      { name: "paperclip_read_assigned_skill", readOnly: true, namespace: "paperclip",
        output: JSON.stringify({ type: "inputText", text: JSON.stringify(value.result) }), outputTruncated: false });
    const p = value.events[1]!.payload.prpEvent.payload; p.outputBytes = Buffer.byteLength(p.output);
    expect(read(value)).toEqual([]);
  });

  it.each([
    ["missing input", (v: any) => { v.events.splice(1, 1); }],
    ["missing result", (v: any) => { v.events.splice(2, 1); }],
    ["duplicate input", (v: any) => { v.events.push(structuredClone(v.events[1])); }],
    ["duplicate result", (v: any) => { v.events.push(structuredClone(v.events[2])); }],
    ["result before input", (v: any) => { v.events[2].seq = 0; }],
    ["foreign provider", (v: any) => { v.run.runnerProfileJson.nativeExecutionInput.provider.kind = "unknown"; }],
    ["foreign runner", (v: any) => { v.run.runnerInstanceId = "foreign"; }],
    ["foreign session", (v: any) => { v.run.nativeSessionId = "foreign"; }],
    ["missing runner identity", (v: any) => { delete v.run.runnerInstanceId; }],
    ["missing session identity", (v: any) => { delete v.run.nativeSessionId; }],
    ["foreign run owner", (v: any) => { v.run.companyId = "foreign"; }],
    ["missing native assignment", (v: any) => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills = []; }],
    ["duplicate native assignment", (v: any) => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills.push(v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0]); }],
    ["foreign native version", (v: any) => { v.run.runnerProfileJson.nativeExecutionInput.runtimeContext.skills[0].versionId = "foreign"; }],
    ["missing selection snapshot", (v: any) => { v.run.contextSnapshot.skillSelectionSnapshot = false; }],
    ["foreign admitted version", (v: any) => { v.run.contextSnapshot.skillVersions[key] = "foreign"; }],
    ["foreign call", (v: any) => { semantic(v, 2).callId = "foreign"; }],
    ["foreign turn", (v: any) => { semantic(v, 2).correlation.turnId = "foreign"; }],
    ["foreign item", (v: any) => { semantic(v, 2).correlation.itemId = "foreign"; }],
    ["foreign source", (v: any) => { v.events[2].sourceInstanceId = v.events[2].payload.prpEvent.sourceInstanceId = "foreign"; }],
    ["foreign operation", (v: any) => { for (const i of [1, 2]) semantic(v, i).operationId = "paperclip_read_assigned_skill"; }],
    ["MCP carriers", (v: any) => { for (const i of [1, 2]) v.events[i].eventType = v.events[i].payload.prpEvent.eventType = i === 1 ? "mcp_app.tool_input" : "mcp_app.tool_result"; }],
    ["failed result", (v: any) => { semantic(v, 2).outcome = "failed"; }],
    ["wrong boundary", (v: any) => { semantic(v, 2).authorizationBoundary = "company"; }],
    ["wrong receipt", (v: any) => { semantic(v, 2).operationReceiptId = "foreign"; }],
    ["wrong input digest", (v: any) => { semantic(v, 1).content.digest = `sha256:${"0".repeat(64)}`; }],
    ["foreign input key", (v: any) => { semantic(v, 1).input.skill = "foreign"; semantic(v, 1).content.digest = digestPrpSemanticContent(semantic(v, 1).input); }],
    ["wrong source path", (v: any) => { semantic(v, 1).input.path = "other.md"; semantic(v, 1).content.digest = digestPrpSemanticContent(semantic(v, 1).input); }],
    ["nonzero offset", (v: any) => { semantic(v, 1).input.offset = 1; semantic(v, 1).content.digest = digestPrpSemanticContent(semantic(v, 1).input); }],
    ["wrong result digest", (v: any) => { semantic(v, 2).content.digest = `sha256:${"0".repeat(64)}`; }],
    ["truncated disclosure", (v: any) => { semantic(v, 2).content.redactionDisposition = "redacted"; }],
    ["truncated marker", (v: any) => { semantic(v, 2).outputTruncated = true; }],
    ["partial page", (v: any) => { semantic(v, 2).content.digest = digestPrpSemanticContent({ ...v.result, nextOffset: 1 }); }],
    ["missing page completion", (v: any) => { const result = { ...v.result }; delete result.nextOffset; semantic(v, 2).content.digest = digestPrpSemanticContent(result); }],
    ["wrong source bytes", (v: any) => { semantic(v, 2).content.digest = digestPrpSemanticContent({ ...v.result, byteSize: v.result.byteSize + 1 }); }],
    ["wrong source checksum", (v: any) => { semantic(v, 2).content.digest = digestPrpSemanticContent({ ...v.result, sha256: "0".repeat(64) }); }],
    ["wrong version", (v: any) => { semantic(v, 2).content.digest = digestPrpSemanticContent({ ...v.result, versionId: "foreign" }); }],
    ["copied nonce only", (v: any) => { semantic(v, 2).content.digest = digestPrpSemanticContent({ ...v.result, text: fixture.expected.reference }); }],
  ] as const)("rejects authoritative-looking evidence with %s", async (_label, mutate) => {
    const value = await observations(); mutate(value); expect(read(value)).toEqual([]);
  });
});
