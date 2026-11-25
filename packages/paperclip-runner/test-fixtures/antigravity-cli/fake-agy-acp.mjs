#!/usr/bin/env node
// Deterministic stand-in for `agy acp` 1.5.15 (Google Antigravity CLI), replaying
// the message shapes recorded in the 2026-11-24 spike (transcripts a1-a4, b1, d1,
// d2). It never touches the network. FAKE_AGY_SCENARIO selects the behaviour:
//   success        two writers and a verifier; files land in the workspace
//   live-helpers   the coordinator ends its first turn while helpers still run;
//                  the files appear only after the follow-up wait prompt
//   blocked        a helper is blocked outside the workspace; the coordinator
//                  also asks the client to approve an outside write
//   misreport      writer-b is reported done but b.txt was never written
//   escape         a helper is started on its own branch workspace
//   cancel         helpers keep running (a real child process) until session/cancel; the CLI
//                  streams a token count, then answers the stopped prompt with its usage so far
//   die            the CLI streams a token count, then exits in the middle of the swarm
//   orphan-helpers a helper runs as its own process-group leader holding the CLI's output
//                  pipe (as the real CLI's helper shells do) and writes late.txt in the
//                  workspace after FAKE_AGY_HELPER_DELAY_MS; the CLI never stops it itself.
//                  The test kills the CLI, stops the turn or closes the runtime.
//   refusal        the provider refusal arrives as ordinary text with end_turn
//   quota          the 429 quota refusal, as seen live on 2026-11-24
//   wrong-version | no-auto | wrong-mode | wrong-model   receipt mismatches
//   hang-helpers   the follow-up wait never ends
//   mode-flip      the CLI switches back to default mode right after the model is set
//   mode-flip-idle the CLI switches back to default mode after the session opened, between turns
//   context-read   the coordinator first reads Paperclip's get_task_context (the live
//                  2026-11-24 run6 opening), then runs the swarm and hands in
//   no-work        the coordinator ends its turn without helpers and without handing in
//   solo-edit      the coordinator writes a.txt itself (no helpers) and ends without handing in
//   denied-tool    the coordinator calls a Paperclip tool the swarm does not admit
//                  (create_task); the CLI ends the whole turn on the denial, as live
//   outside-edit   the coordinator edits a file outside the workspace (absolute path)
//   dotdot-edit    the coordinator edits ../escape.txt through its path argument
//   symlink-edit   the coordinator edits link/x.txt where link points outside the workspace
//   shell-escape   the coordinator runs `printf E > /tmp/...` (the CLI's shell sandbox allows temp dirs)
//   shell-read     the coordinator reads outside the workspace and copies into it (allowed)
//   cautious-brief a helper brief says "Do not create debug.log"; the run is correct
//   plan           the coordinator loads swarm_pane and writes its plan.json into its own
//                  --gemini-dir (recorded shape, run1); the run is correct
//   plan-sibling | plan-dotdot | plan-symlink | plan-home   the same plan write aimed at
//                  <gemini-dir>-evil, a .. escape out of it, a symlink inside it pointing
//                  outside, and the real ~/.gemini; never written, the swarm must stop
// FAKE_AGY_LOG (optional) appends every client message, one JSON per line.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scenario = process.env.FAKE_AGY_SCENARIO ?? "success";
// Like the real CLI, private state lives under --gemini-dir (it adds its own antigravity-cli/ inside).
const geminiDirectory = process.argv[process.argv.indexOf("--gemini-dir") + 1];
const log = message => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(message)}\n`); };
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, value) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODELS = ["gemini-4-argon-medium", "gemini-4-argon-low", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"];
const COMMANDS = ["goal", "compact", "schedule", "browser", "plan", "grill-me", "teamwork", "learn", "boost", "agy-customizations", "antigravity-guide", "run-workflow", "swarm"];

const state = { sessionId: "", cwd: "", model: "gemini-4-argon", level: "medium", mode: "default", prompts: 0, cancel: null, worker: null };
const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: [{ value: "gemini-4-argon" }, { value: "gemini-3.8-flash" }] },
  { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: state.level, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
  { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: [{ value: "default" }, { value: "accept-edits" }, { value: "auto" }, { value: "plan" }] },
];
let call = 1000;
const tool = async (name, args, status = "completed") => {
  const toolCallId = `call_${++call}`;
  update(state.sessionId, { sessionUpdate: "tool_call", toolCallId, name, args, status: "in_progress", kind: "other", title: `Run ${name}`, rawInput: args });
  await sleep(2);
  update(state.sessionId, { sessionUpdate: "tool_call_update", toolCallId, name, args, status, kind: "other", title: `Run ${name}`, rawInput: args });
};
// A call to a client MCP server exactly as the pinned CLI (1.5.15) sends it, recorded
// live (paperclip-mcp-call.recorded.json): name `mcp_<server>_<tool>`, kind other,
// no _meta, and a string request id. The CLI asks before every such call in auto mode,
// and a denial ends its whole turn (live run6: `approved=false`, then the cascade is cancelled).
const RECORDED = JSON.parse(readFileSync(new URL("./paperclip-mcp-call.recorded.json", import.meta.url), "utf8"));
const permissionAnswers = new Map();
let permissionId = 0;
const paperclipCall = async tool => {
  const name = `mcp_paperclip_${tool}`;
  const toolCallId = `call_${++call}`;
  const shape = update => ({ ...update, toolCallId, name, title: `Run ${name}` });
  for (const recorded of RECORDED.toolCallUpdates) update(state.sessionId, shape(recorded.params.update));
  const id = String(++permissionId);
  const answered = new Promise(resolve => permissionAnswers.set(id, resolve));
  write({ ...RECORDED.requestPermission, id, params: { ...RECORDED.requestPermission.params, sessionId: state.sessionId, toolCall: shape(RECORDED.requestPermission.params.toolCall) } });
  const answer = await answered;
  log({ permissionAnswer: answer.result, tool });
  if (answer.result?.outcome?.optionId === "allow") {
    for (const recorded of RECORDED.afterAllow) update(state.sessionId, shape(recorded.params.update));
    return true;
  }
  update(state.sessionId, shape({ sessionUpdate: "tool_call_update", args: {}, status: "failed", kind: "other", rawInput: {},
    rawOutput: `permission check failed for mcp "paperclip/${tool}": user denied permission for mcp(paperclip/${tool})` }));
  return false;
};
const handIn = () => paperclipCall("paperclip_finish");
const say = text => update(state.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
// Usage the CLI streams mid-prompt, and the usage it answers a stopped prompt with.
const streamedUsage = { inputTokens: 700, outputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 720 };
const stoppedUsage = { inputTokens: 1200, outputTokens: 30, cachedReadTokens: 400, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 1630 };
const usage = { inputTokens: 49646, outputTokens: 1421, cachedReadTokens: 81968, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 133035 };
const addWriters = async () => {
  await tool("swarm", { action: "title", title: "Two writers and a verifier" });
  await tool("swarm", { action: "add", name: "writer-a", workspace: "inherit", brief: "Write a.txt containing exactly 'A' in the current workspace directory. Once done, post to the board: '@verifier [done] a.txt written'." });
  await tool("swarm", { action: "add", name: "writer-b", workspace: "inherit", brief: "Write b.txt containing exactly 'B' in the current workspace directory. Once done, post to the board: '@verifier [done] b.txt written'." });
  await tool("swarm", { action: "add", name: "verifier", workspace: "inherit", brief: scenario === "cautious-brief"
    ? "Wait for writer-a and writer-b, then read a.txt and b.txt. Do not create debug.log or any other file. Write docs.google.com links only if v1.2 asks." : "Wait for writer-a and writer-b, then read a.txt and b.txt and report." });
  await tool("swarm", { action: "add", name: "monitor", workspace: "inherit", brief: "You are this swarm's stall monitor. Load the swarm_monitor skill and follow it." });
};
const PLAN = `${JSON.stringify({ goal: { title: "Write a.txt and b.txt", line: "Two writers, then verify." },
  tasks: { "writer-a": "Write a.txt", "writer-b": "Write b.txt", verifier: "Verify a.txt and b.txt", monitor: "Watch swarm for stalls" },
  threads: [{ id: "t-files", title: "Task files", goal: "Create a.txt and b.txt in the workspace.", tasks: ["writer-a", "writer-b"] },
    { id: "t-verify", title: "Verification and swarm health", goal: "Confirm both files.", tasks: ["verifier", "monitor"] }] }, null, 2)}\n`;
const planPath = () => {
  const brain = join(geminiDirectory, "antigravity-cli", "brain", state.sessionId);
  return {
    plan: join(brain, ".system_generated", "swarm", "plan.json"),
    "plan-sibling": join(`${geminiDirectory}-evil`, "antigravity-cli", "brain", state.sessionId, "plan.json"),
    "plan-dotdot": `${brain}/../../../../escape-plan.json`,
    "plan-symlink": join(brain, "link", "plan.json"),
    "plan-home": `~/.gemini/antigravity-cli/brain/${state.sessionId}/.system_generated/swarm/plan.json`,
  }[scenario];
};
/** The swarm_pane plan write as CLI 1.5.15 reports it: write_file, kind edit, args Content/Overwrite/Path. */
const writePlan = async path => {
  const toolCallId = "call_13884031054897948910";
  const args = { Content: PLAN, Overwrite: true, Path: path };
  const shape = { toolCallId, name: "write_file", kind: "edit", title: `File ${path}`, locations: [{ path }], args };
  update(state.sessionId, { sessionUpdate: "tool_call", status: "in_progress", ...shape });
  if (scenario !== "plan") { if (!state.cancelled) await new Promise(resolve => { state.cancel = resolve; }); return false; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PLAN);
  await sleep(2);
  update(state.sessionId, { sessionUpdate: "tool_call_update", status: "completed", ...shape, rawOutput: {}, content: [{ type: "diff", path, newText: PLAN }] });
  return true;
};
const writeFiles = () => {
  writeFileSync(join(state.cwd, "a.txt"), "A");
  writeFileSync(join(state.cwd, "b.txt"), "B");
};

async function prompt(id, params) {
  state.prompts += 1;
  const text = params.prompt?.[0]?.text ?? "";
  if (state.prompts > 1) {
    // Paperclip's follow-up: wait for the helpers, then confirm.
    // A session-wide token count streamed while the wait hangs (larger than the first prompt's answer).
    if (scenario === "hang-helpers") update(state.sessionId, { sessionUpdate: "usage_update", used: 60000, size: 1048576, _meta: { usage: { ...usage, inputTokens: 52000, totalTokens: 140000 } } });
    if (scenario === "hang-helpers") { await new Promise(resolve => { state.cancel = resolve; }); return write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } }); }
    await tool("read_board", { since: 5 });
    if (scenario === "live-helpers") { writeFiles(); await handIn(); }
    say("All helpers have finished. a.txt contains A and b.txt contains B.");
    return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { ...usage, totalTokens: 1000, inputTokens: 900, outputTokens: 100, cachedReadTokens: 0 } } });
  }
  if (!text.startsWith("/swarm ")) { say("not a swarm"); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); }
  update(state.sessionId, { sessionUpdate: "session_info_update", title: "Swarm" });
  if (scenario === "refusal") { say("\n⚠ agent executor error: Error 402 Your prepayment credits are depleted. Status: RESOURCE_EXHAUSTED\n"); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); }
  // Seen live: the CLI refuses its whole toolbox when a tool schema does not compile, then ends the turn.
  if (scenario === "executor-error") { say("\n⚠ agent executor error: building toolbox: tool \"mcp_paperclip_read_document\" advertises an invalid parameter schema\n"); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); }
  if (scenario === "quota") { say("\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n"); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); }
  const outside = {
    "outside-edit": { name: "write_file", kind: "edit", title: "Write /etc/elsewhere.txt", locations: [{ path: "/etc/elsewhere.txt" }] },
    "dotdot-edit": { name: "write_file", kind: "edit", title: "Write file", args: { TargetFile: `${state.cwd}/../escape.txt` } },
    "symlink-edit": { name: "write_file", kind: "edit", title: "Write file", locations: [{ path: `${state.cwd}/link/x.txt` }] },
    "shell-escape": { name: "run_command", kind: "execute", title: "Run command", args: { CommandLine: "printf E > /tmp/agy-escape-e.txt" } },
  }[scenario];
  if (scenario === "symlink-edit") (await import("node:fs")).symlinkSync("/etc", `${state.cwd}/link`);
  if (scenario === "shell-read") {
    await tool("run_command", { CommandLine: "cat /etc/hosts > ./hosts-copy.txt && cp /etc/hosts ./hosts2.txt" });
  }
  if (outside) {
    update(state.sessionId, { sessionUpdate: "tool_call", toolCallId: "call_out", status: "in_progress", rawInput: outside.args, ...outside });
    if (!state.cancelled) await new Promise(resolve => { state.cancel = resolve; });
    return write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
  }
  if (scenario === "solo-edit") { writeFileSync(join(state.cwd, "a.txt"), "A"); say("I wrote a.txt."); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } }); }
  if (scenario === "no-work") { say("I looked at the request; there is nothing to do."); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } }); }
  if (scenario === "denied-tool") { await paperclipCall("create_task"); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } }); }
  if (scenario === "context-read" && !await paperclipCall("get_task_context")) return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
  if (scenario === "escape") { await tool("swarm", { action: "add", name: "writer-a", workspace: "branch", brief: "Write a.txt." }); if (!state.cancelled) await new Promise(resolve => { state.cancel = resolve; }); return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); }
  await addWriters();
  if (scenario.startsWith("plan")) {
    if (scenario === "plan-symlink") {
      const brain = join(geminiDirectory, "antigravity-cli", "brain", state.sessionId);
      mkdirSync(brain, { recursive: true });
      symlinkSync(tmpdir(), join(brain, "link"));
    }
    if (!await writePlan(planPath())) return write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
  }
  // The terminal hint arrives in pieces, as recorded live: the hint complete without its period, then the period alone.
  for (const chunk of ["I have configured and launched the swarm.\n", "\nRun /swarm board (default shortcut alt+s) to open the live board", "."]) say(chunk);
  if (scenario === "orphan-helpers") {
    const late = join(state.cwd, "late.txt");
    const helper = spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(late)}, "late"), ${Number(process.env.FAKE_AGY_HELPER_DELAY_MS ?? 3000)})`],
      { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    if (process.env.FAKE_AGY_WORKER_PID_FILE) writeFileSync(process.env.FAKE_AGY_WORKER_PID_FILE, String(helper.pid));
    if (!state.cancelled) await new Promise(resolve => { state.cancel = resolve; });
    return write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled", usage: stoppedUsage } });
  }
  if (scenario === "cancel" || scenario === "die") {
    update(state.sessionId, { sessionUpdate: "usage_update", used: 52000, size: 1048576, _meta: { usage: streamedUsage } });
    // A helper is a real descendant in the CLI's process group.
    state.worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_AGY_WORKER_PID_FILE) writeFileSync(process.env.FAKE_AGY_WORKER_PID_FILE, String(state.worker.pid));
    if (scenario === "die") { await sleep(50); process.exit(3); }
    if (!state.cancelled) await new Promise(resolve => { state.cancel = resolve; });
    return write({ jsonrpc: "2.0", id, result: { stopReason: "cancelled", usage: stoppedUsage } });
  }
  if (scenario === "live-helpers" || scenario === "hang-helpers") return write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
  if (scenario === "misreport") writeFileSync(join(state.cwd, "a.txt"), "A"); else writeFiles();
  if (scenario === "blocked") {
    await tool("swarm", { action: "add", name: "writer-c", workspace: "inherit", brief: "Try once to write /outside/c.txt containing 'C'." });
    const permissionId = 77;
    write({ jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: { sessionId: state.sessionId,
      toolCall: { toolCallId: "call_perm", title: "Write /outside/c.txt", kind: "edit" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] } });
    await new Promise(resolve => { state.permission = resolve; });
    say("writer-c: the write outside the workspace failed (sandbox permission check timed out waiting for user response).\n");
  }
  await tool("read_board", { since: 5 });
  await tool("post_message", { text: "[done] Verification verified and tasks finished successfully." });
  await handIn();
  say("\n\nThe swarm has completed its work. a.txt contains A and b.txt contains B.");
  write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage } });
}

let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log(message);
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === undefined) {
    if (id === 77) { log({ permissionAnswer: message.result }); state.permission?.(); }
    permissionAnswers.get(id)?.(message);
    return;
  }
  if (method === "initialize") {
    return write({ jsonrpc: "2.0", id, result: { protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
      agentInfo: { name: "Antigravity ACP Server", version: scenario === "wrong-version" ? "1.5.16" : "1.5.15" },
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }] } });
  }
  if (method === "session/new") {
    state.sessionId = "e6536314-e108-4ecd-a0cf-efa59061510d"; state.cwd = params.cwd;
    write({ jsonrpc: "2.0", id, result: { sessionId: state.sessionId,
      models: { availableModels: MODELS.map(modelId => ({ modelId })), currentModelId: "gemini-4-argon-medium" },
      modes: { currentModeId: "default", availableModes: (scenario === "no-auto" ? ["default", "accept-edits", "plan"] : ["default", "accept-edits", "auto", "plan"]).map(id => ({ id })) },
      configOptions: configOptions() } });
    await sleep(5);
    update(state.sessionId, { sessionUpdate: "available_commands_update", availableCommands: COMMANDS.map(name => ({ name })) });
    return;
  }
  if (method === "session/set_mode") {
    write({ jsonrpc: "2.0", id, result: {} });
    if (scenario === "wrong-mode") return;
    state.mode = params.modeId;
    update(state.sessionId, { sessionUpdate: "current_mode_update", currentModeId: state.mode });
    return update(state.sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions() });
  }
  if (method === "session/set_model") {
    write({ jsonrpc: "2.0", id, result: {} });
    const match = /^(.*)-(low|medium|high)$/.exec(params.modelId);
    state.model = match[1]; state.level = scenario === "wrong-model" ? "high" : match[2];
    update(state.sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions() });
    if (scenario === "mode-flip") update(state.sessionId, { sessionUpdate: "current_mode_update", currentModeId: "default" });
    if (scenario === "mode-flip-idle") setTimeout(() => update(state.sessionId, { sessionUpdate: "current_mode_update", currentModeId: "default" }), 100);
    return;
  }
  if (method === "session/prompt") return prompt(id, params);
  if (method === "session/cancel") { state.cancelled = true; state.worker?.kill("SIGTERM"); state.cancel?.(); return; }
  if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
