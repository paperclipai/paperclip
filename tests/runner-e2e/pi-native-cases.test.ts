import { describe, expect, it } from "vitest";
import { gradePiNativeAnswers, gradePiNativeMemory, hasPiNativeMemoryRead, hasFailedPiWrite, hasPiCrossRootDenial, piNativeMemoryPrompt, piNativeTasks } from "./pi-native-cases.js";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("Pi native Product qualification", () => {
  it("supplies native write arguments with one authoritative content string and its final LF", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const prompt = piNativeMemoryPrompt(nonce, "/unassigned/denied.txt");
    expect(prompt.split(nonce)).toHaveLength(2);
    const encoded = /```json\n(.*?)\n```/s.exec(prompt)![1]!;
    const args = JSON.parse(encoded);
    expect(Object.keys(args)).toEqual(["path", "content"]);
    expect(args.path).toBe("<AGENT_HOME>/memory/pi-native.txt");
    expect(args.content).toBe(`${nonce}\n`);
    expect(Buffer.byteLength(args.content)).toBe(33);
    expect(Buffer.from(args.content).at(-1)).toBe(10);
    expect(prompt).toContain("Use native read once, without offset or limit");
    expect(prompt).toContain("Do not retry or work around it");
  });

  it("requires the current nonce and exactly one LF at every memory readback", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    expect(gradePiNativeMemory(`${nonce}\n`, nonce)).toBe(true);
    for (const wrong of [undefined, null, {}, nonce, `${nonce}\n\n`, `${nonce}\r\n`, `${nonce}\\n`, `${nonce}\\u000a`, `${"f".repeat(32)}\n`]) {
      expect(gradePiNativeMemory(wrong, nonce)).toBe(false);
    }
  });
  it("requires a completed native read and rejects a shell shortcut or missing receipt", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const read = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: {
      schema: "paperclip.tool.execution.v1", transport: "builtin", name: "read", operation: "read", status: "completed", executionId: "read-1", target: null, readOnly: true, outputTruncated: false, output: JSON.stringify({ content: [{ type: "text", text: `${nonce}\n` }] }),
    } } } };
    expect(hasPiNativeMemoryRead([read], nonce)).toBe(true);
    const change = (patch: Record<string, unknown>) => ({ ...read, payload: { prpEvent: { payload: { ...read.payload.prpEvent.payload, ...patch } } } });
    expect(hasPiNativeMemoryRead([change({ target: "bootstrap.md", output: JSON.stringify({ content: [{ type: "text", text: "bootstrap instructions" }] }) }), read], nonce)).toBe(true);
    for (const rows of [[], [{}], [read, read], [change({ target: undefined })], [change({ status: "failed" })], [change({ transport: "mcp" })], [change({ executionId: "" })], [change({ schema: "untrusted" })], [change({ target: "another-file.txt" })], [change({ output: "malformed" })], [change({ outputTruncated: true })], [change({ readOnly: false })], [change({ output: JSON.stringify({ content: [{ type: "text", text: "unrelated-file" }] }) })], [change({ output: JSON.stringify({ content: [{ type: "text", text: nonce }] }) })], [change({ name: "bash", operation: "execute" })], [read, change({ name: "bash", operation: "execute" })]]) {
      expect(hasPiNativeMemoryRead(rows, nonce)).toBe(false);
    }
  });

  it("binds the remote memory read to the exact agent and current run", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const remoteRun = { agentId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222" };
    const target = `.paperclip-runtime/agent-files/${remoteRun.agentId}/${remoteRun.runId}/memory/pi-native.txt`;
    const read = (patch: Record<string, unknown> = {}) => ({ eventType: "tool.execution.completed", payload: { prpEvent: { payload: {
      schema: "paperclip.tool.execution.v1", transport: "builtin", name: "read", operation: "read", status: "completed", executionId: "remote-read-1", target, readOnly: true, outputTruncated: false, output: JSON.stringify({ content: [{ type: "text", text: `${nonce}\n` }] }), ...patch,
    } } } });
    expect(hasPiNativeMemoryRead([read()], nonce, remoteRun)).toBe(true);
    expect(hasPiNativeMemoryRead([read({ target: "bootstrap.md", output: JSON.stringify({ content: [{ type: "text", text: "bootstrap" }] }) }), read()], nonce, remoteRun)).toBe(true);
    expect(hasPiNativeMemoryRead([read()], nonce)).toBe(false);
    for (const patch of [{ target: null }, { target: "memory/pi-native.txt" }, { target: `${target}.bak` }, { target: target.replace(remoteRun.agentId, remoteRun.runId) }, { target: target.replace(remoteRun.runId, remoteRun.agentId) }, { output: JSON.stringify({ content: [{ type: "text", text: nonce }] }) }, { status: "failed" }, { outputTruncated: true }]) {
      expect(hasPiNativeMemoryRead([read(patch)], nonce, remoteRun)).toBe(false);
    }
    expect(hasPiNativeMemoryRead([read(), read()], nonce, remoteRun)).toBe(false);
    expect(hasPiNativeMemoryRead([read(), read({ name: "bash", operation: "execute" })], nonce, remoteRun)).toBe(false);
    expect(hasPiNativeMemoryRead([read()], nonce, { ...remoteRun, runId: "../other-run" })).toBe(false);
  });

  it("selects five local and five remote Pi cases without changing the basic extended matrix", () => {
    const suite = runnerSuites.find(row => row.id === "pi-native")!;
    expect(suite.manualOnly).toBe(true); expect(suite.expectedMatrixSize).toBe(10);
    const cells = runnerMatrix.filter(row => row.suite.id === suite.id);
    expect(cells).toHaveLength(10);
    expect(cells.every(row => row.profile.qualificationCandidate === "pi")).toBe(true);
    expect(cells.filter(row => row.environment.id === "local").map(row => [row.task.id, row.task.expectedRunCount])).toEqual([
      ["native-questions", 1], ["agent-files-fresh-run", 2], ["restrictive-denial", 1], ["human-permission-denial", 1],
      ["native-pending-controller-restart", 1],
    ]);
    expect(cells.filter(row => row.environment.id === "daytona").map(row => [row.task.id, row.task.expectedRunCount])).toEqual([
      ["native-questions", 1], ["agent-files-fresh-run", 2], ["human-permission-denial", 1],
      ["native-pending-controller-restart", 1], ["native-pending-provider-death", 1],
    ]);
    expect(cells.reduce((sum, row) => sum + row.task.expectedRunCount, 0)).toBe(12);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.suite.id === suite.id)).toBe(false);
    expect(runnerMatrix.filter(row => row.suite.id === "extended-harnesses")).toHaveLength(30);
    expect(piNativeTasks[0]!.buildPrompt("fixture")).toContain("paperclip_native_question");
    expect(piNativeTasks[1]!.buildPrompt("fixture")).toContain("AGENT_HOME");
  });

  it("admits explicit local and remote Pi native candidates and discards ambient admission", () => {
    const cell = runnerMatrix.find(row => row.suite.id === "pi-native")!;
    const source = { PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" };
    expect(buildRunnerE2EProcessEnvironment(source, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    const remote = runnerMatrix.find(row => row.suite.id === "pi-native" && row.environment.id === "daytona")!;
    expect(buildRunnerE2EProcessEnvironment(source, [remote]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    expect(buildRunnerE2EProcessEnvironment(source, []).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
    for (const changed of [
      { ...cell, suite: { ...cell.suite, manualOnly: false } },
      { ...cell, suite: { ...cell.suite, id: "implicit" } },
      { ...cell, profile: { ...cell.profile, qualificationCandidate: "copilot" as const } },
    ]) expect(() => buildRunnerE2EProcessEnvironment(source, [changed])).toThrow("explicit provider qualification suite");
  });

  it("grades all four actual typed results and fails missing, stale or invented answers", () => {
    const valid = [{ status: "answered", optionId: "blue" }, { status: "negative_or_cancelled", confirmed: false }, { status: "answered", value: "hidden-name" }, { status: "answered", value: "hidden-draft\nsecond" }];
    expect(gradePiNativeAnswers(valid, "hidden-name", "hidden-draft\nsecond")).toBe(true);
    for (const actual of [undefined, [], valid.slice(0, 3), [...valid, valid[0]], valid.map((row, i) => i === 1 ? { status: "answered", confirmed: true } : row), valid.map((row, i) => i === 2 ? { ...row, value: "guessed-name" } : row), valid.map((row, i) => i === 0 ? { ...row, extra: "invented" } : row)]) {
      expect(gradePiNativeAnswers(actual, "hidden-name", "hidden-draft\nsecond")).toBe(false);
    }
  });

  it("requires exactly one native cross-root policy receipt when public paths are suppressed", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", transport: "builtin", operation: "edit", name: "write", status: "failed", target: null, executionId: "native-1", output: "Pi tool path is outside its assigned workspace and agent files" } } } };
    expect(hasPiCrossRootDenial([event])).toBe(true);
    expect(hasPiCrossRootDenial([event, event])).toBe(false);
    for (const patch of [{ output: "model claims denied" }, { executionId: "" }, { status: "completed" }, { transport: "mcp" }, { target: "other.txt" }]) {
      expect(hasPiCrossRootDenial([{ ...event, payload: { prpEvent: { payload: { ...event.payload.prpEvent.payload, ...patch } } } }])).toBe(false);
    }
  });

  it("requires a correlated failed native edit, never a model claim or an unexecuted intent", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { schema: "paperclip.tool.execution.v1", operation: "edit", status: "failed", name: "write", target: "pi-denied.txt" } } } };
    expect(hasFailedPiWrite([event], "pi-denied.txt")).toBe(true);
    for (const events of [[], [{ eventType: "assistant.message", text: "Write pi-denied.txt failed" }], [{ ...event, eventType: "tool.execution.started" }], [{ ...event, payload: { prpEvent: { payload: { ...event.payload.prpEvent.payload, status: "completed" } } } }]]) expect(hasFailedPiWrite(events, "pi-denied.txt")).toBe(false);
    expect(hasFailedPiWrite([event], "other.txt")).toBe(false);
  });
});
