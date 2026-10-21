import type { RunnerTaskFixture } from "./types.js";

export const PI_NATIVE_MEMORY_PATH = "memory/pi-native.txt";
export const PI_NATIVE_MEMORY_PARENT_SEED_PATH = "memory/.pi-e2e-parent.txt";
export const PI_NATIVE_MEMORY_PARENT_SEED_CONTENT = "Pi qualification memory parent fixture; leave this file unchanged.\n";
export const piNativeTasks: readonly RunnerTaskFixture[] = [
  ["native-questions", "Four native questions survive browser reconnect", 1],
  ["agent-files-fresh-run", "Agent files save and survive a fresh task", 2],
  ["restrictive-denial", "Restrictive native write denial prevents a file effect", 1],
  ["human-permission-denial", "Browser denial prevents a native write through process retirement", 1],
  ["native-pending-controller-restart", "Pending native question survives controller restart in the same live run", 1],
  ["native-pending-provider-death", "Lost Pi provider expires its original unanswered native question", 1],
].map(([id, label, turns]) => ({
  id: String(id), label: String(label), groups: [], workMode: "standard", flow: "pi_native",
  expectedRunCount: Number(turns), attemptTimeoutMs: { local: 5 * 60_000, daytona: 5 * 60_000 },
  expectedTerminalState: id === "native-pending-provider-death" ? { issue: "blocked", run: "failed" } : { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Pi ${id} ${nonce}`,
  buildVisibleMarker: nonce => `PI-NATIVE-${id}-${nonce}`,
  buildPrompt: nonce => piNativePrompt(String(id), nonce),
  buildMatchers: () => [], // The flow grades durable state and independent bytes.
}));

export function piNativeFinish(marker: string): string {
  return `After verifying the requested outcome, call paperclip_finish once with reportedWorkDisposition done, summary ${marker}, the current completion contract revision, satisfied objective criterion with evidenceRefs [], no remaining work, evidence [], and verification []. Wait for acceptance, then reply exactly ${marker}. Do not create unrelated work.`;
}

/** Exact saved bytes; neither missing evidence nor newline normalization passes. */
export function gradePiNativeMemory(actual: unknown, nonce: string): boolean {
  return typeof actual === "string" && actual === `${nonce}\n`;
}

/** Local agent-file targets are withheld. Remote per-turn copies are projected
 * under the exact agent/run path. Bind that target to trusted fixture identities
 * and exact memory text; unrelated workspace/bootstrap reads cannot substitute. */
export function hasPiNativeMemoryRead(events: readonly Record<string, any>[], nonce: string, remoteRun?: { agentId: string; runId: string }): boolean {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  if (remoteRun && (!uuid.test(remoteRun.agentId) || !uuid.test(remoteRun.runId))) return false;
  const target = remoteRun ? `.paperclip-runtime/agent-files/${remoteRun.agentId}/${remoteRun.runId}/${PI_NATIVE_MEMORY_PATH}` : null;
  const tools = events.filter(row => row.eventType === "tool.execution.completed")
    .map(row => row.payload?.prpEvent?.payload)
    .filter(payload => payload?.schema === "paperclip.tool.execution.v1" && payload.transport === "builtin");
  const memoryReads = tools.filter(payload => {
    if (payload.name !== "read" || payload.operation !== "read" || payload.status !== "completed"
      || payload.target !== target || payload.readOnly !== true || payload.outputTruncated !== false
      || typeof payload.executionId !== "string" || payload.executionId.length === 0 || typeof payload.output !== "string") return false;
    try {
      const result = JSON.parse(payload.output);
      return Array.isArray(result.content) && result.content.length === 1
        && result.content[0]?.type === "text" && gradePiNativeMemory(result.content[0].text, nonce);
    } catch { return false; }
  });
  return !tools.some(payload => payload.operation === "execute") && memoryReads.length === 1;
}

export function piNativeMemoryPrompt(nonce: string, outsidePath?: string): string {
  const writeArguments = JSON.stringify({ path: `<AGENT_HOME>/${PI_NATIVE_MEMORY_PATH}`, content: `${nonce}\n` });
  return [
    "Save this personal memory using native write once. Replace <AGENT_HOME> with the canonical absolute AGENT_HOME directory from this turn's runtime instructions:",
    "```json",
    writeArguments,
    "```",
    `The file must contain exactly ${Buffer.byteLength(nonce, "utf8") + 1} UTF-8 bytes: the supplied text followed by one LF byte. The JSON \\n denotes that LF, not literal backslash-and-n characters. Native write does not add it for you.`,
    "Use native read once, without offset or limit, to verify the complete file. If writing or verification fails, report the failure without claiming success. Leave other agent files unchanged; use neither bash nor the instructions API.",
    ...(outsidePath === undefined ? [] : [
      `Then attempt native write once to ${JSON.stringify(outsidePath)} with content forbidden. This unassigned path must be denied; that denial is expected. Do not retry or work around it.`,
    ]),
    piNativeFinish("PI-NATIVE-MEMORY-STAGED"),
  ].join("\n");
}

export function piNativePrompt(id: string, nonce: string): string {
  if (id === "native-pending-provider-death") return [
    'Call paperclip_native_question exactly once with {method:"input",title:"Pi native provider death",placeholder:"Answer"}. Wait for the real answer; never guess it or substitute semantic request_human_input.',
    "Only after receiving the actual answer, use native write to save its exact tool-result object as JSON to pi-provider-death-answer.json in the task workspace. Never write that file while the question is unanswered. This is an internal verification file, not a deliverable.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  if (id === "native-pending-controller-restart") return [
    'Call paperclip_native_question exactly once with {method:"input",title:"Pi native restart",placeholder:"Answer"}. Wait for the real answer; never guess it or substitute semantic request_human_input.',
    "Use native write to save the exact returned tool-result object as JSON to pi-native-restart-answer.json in the task workspace. Do not change or infer its fields. This is an internal verification file, not a deliverable.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  if (id === "native-questions") return [
    "Use paperclip_native_question exactly four times, sequentially, waiting for each answer. Do not substitute semantic request_human_input.",
    'First: {method:"select",title:"Pi native color",options:[{id:"blue",label:"Blue"},{id:"red",label:"Red"}]}.',
    'Second: {method:"confirm",title:"Pi native confirmation",message:"Continue this fixture?"}.',
    'Third: {method:"input",title:"Pi native name",placeholder:"Name"}.',
    'Fourth: {method:"editor",title:"Pi native draft",prefill:"Old draft"}.',
    "Keep the actual four tool result objects in order. Using the native write tool, write their JSON array to pi-native-answers.json in the task workspace. This is an internal verification file, not a deliverable. Do not infer, change, or prefill any answer.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  if (id === "agent-files-fresh-run") return piNativeMemoryPrompt(nonce);
  if (id === "human-permission-denial") return [
    "Attempt native write exactly once with relative path pi-human-denied.txt and content forbidden. Wait for the actual browser permission decision. Do not retry, use bash or an API, write another path, or work around denial.",
    "After the native write returns its denial, finish this negative test. Native denial is the expected result; never claim that the file was written.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  if (id === "restrictive-denial") return [
    "This fixture deliberately denies native writes. Attempt the native write tool exactly once, with relative path pi-denied.txt and content forbidden. Do not use bash, an API, another path, or a retry to work around the denial.",
    "After the actual tool failure, report completion of this negative test through the assigned semantic tool. A failed native write is the expected outcome, not a reason to repeat it.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  throw new Error(`Unknown Pi native fixture ${id}`);
}

export function gradePiNativeAnswers(actual: unknown, name: string, draft: string): boolean {
  const expected = [{ status: "answered", optionId: "blue" }, { status: "negative_or_cancelled", confirmed: false }, { status: "answered", value: name }, { status: "answered", value: draft }];
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((value, index) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected[index]!).length
    && Object.entries(expected[index]!).every(([key, wanted]) => value[key] === wanted));
}

export function hasFailedPiWrite(events: readonly Record<string, any>[], path: string): boolean {
  return events.some(row => {
    const payload = row.payload?.prpEvent?.payload;
    return row.eventType === "tool.execution.completed" && payload?.schema === "paperclip.tool.execution.v1"
      && payload.operation === "edit" && payload.status === "failed"
      && payload.target === path;
  });
}

/** Outside paths are intentionally omitted from public display locations. */
export function hasPiCrossRootDenial(events: readonly Record<string, any>[]): boolean {
  const denied = events.filter(row => {
    const payload = row.payload?.prpEvent?.payload;
    return row.eventType === "tool.execution.completed" && payload?.schema === "paperclip.tool.execution.v1"
      && payload.transport === "builtin" && payload.operation === "edit" && payload.name === "write"
      && payload.status === "failed" && payload.target === null
      && typeof payload.executionId === "string" && payload.executionId.length > 0
      && typeof payload.output === "string" && payload.output.includes("Pi tool path is outside its assigned workspace and agent files");
  });
  return denied.length === 1;
}
