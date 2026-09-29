import type { RunnerTaskFixture } from "./types.js";

export const PI_NATIVE_MEMORY_PATH = "memory/pi-native.txt";
export const piNativeTasks: readonly RunnerTaskFixture[] = [
  ["native-questions", "Four native questions survive browser reconnect", 1],
  ["agent-files-fresh-run", "Agent files save and survive a fresh task", 2],
  ["restrictive-denial", "Restrictive native write denial prevents a file effect", 1],
].map(([id, label, turns]) => ({
  id: String(id), label: String(label), groups: [], workMode: "standard", flow: "pi_native",
  expectedRunCount: Number(turns), attemptTimeoutMs: { local: 5 * 60_000, daytona: 5 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Pi ${id} ${nonce}`,
  buildVisibleMarker: nonce => `PI-NATIVE-${id}-${nonce}`,
  buildPrompt: nonce => piNativePrompt(String(id), nonce),
  buildMatchers: () => [], // The flow grades durable state and independent bytes.
}));

export function piNativeFinish(marker: string): string {
  return `After verifying the requested outcome, call paperclip_finish once with reportedWorkDisposition done, summary ${marker}, the current completion contract revision, satisfied objective criterion, no remaining work, evidence [], and verification []. Wait for acceptance, then reply exactly ${marker}. Do not create unrelated work.`;
}

export function piNativePrompt(id: string, nonce: string): string {
  if (id === "native-questions") return [
    "Use paperclip_native_question exactly four times, sequentially, waiting for each answer. Do not substitute semantic request_human_input.",
    'First: {method:"select",title:"Pi native color",options:[{id:"blue",label:"Blue"},{id:"red",label:"Red"}]}.',
    'Second: {method:"confirm",title:"Pi native confirmation",message:"Continue this fixture?"}.',
    'Third: {method:"input",title:"Pi native name",placeholder:"Name"}.',
    'Fourth: {method:"editor",title:"Pi native draft",prefill:"Old draft"}.',
    "Keep the actual four tool result objects in order. Using the native write tool, write their JSON array to pi-native-answers.json in the task workspace. This is an internal verification file, not a deliverable. Do not infer, change, or prefill any answer.",
    piNativeFinish(`PI-NATIVE-${id}-${nonce}`),
  ].join("\n");
  if (id === "agent-files-fresh-run") return [
    "Find the exact registered AGENT_HOME working-copy path in your runtime instructions. Use native write/read file tools for this task, not bash or the instructions API.",
    `Write exactly ${JSON.stringify(`${nonce}\n`)} to ${PI_NATIVE_MEMORY_PATH} inside that AGENT_HOME and read it back. This is personal memory, not a task deliverable. Do not edit AGENTS.md or a project file instead.`,
    "Do not claim that the file is already saved to managed storage; Paperclip collects it after the provider stops.",
    piNativeFinish("PI-NATIVE-MEMORY-STAGED"),
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
