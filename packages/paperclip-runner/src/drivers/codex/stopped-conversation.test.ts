import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { proveClosedReadOnlyCodexThread, readStoppedCodexThread } from "./stopped-conversation.js";

const binding = { threadId: "thread-1", turnId: "turn-1", cwd: "C:\\work\\task" };
const read = (tool = "get_task_context") => ({ type: "dynamicToolCall", tool, status: "failed" });
const thread = (items: unknown[] = [read()]) => ({ id: binding.threadId, cwd: binding.cwd,
  turns: [{ id: binding.turnId, status: "interrupted", items }] });
const allowed = new Set(["get_task_context", "list_assigned_skills"]);

describe("closed read-only Codex conversation", () => {
  it("proves an interrupted turn whose reads failed without dispatching work", () => {
    expect(proveClosedReadOnlyCodexThread(thread([{ type: "userMessage" }, read(), read("list_assigned_skills")]), binding, allowed))
      .toEqual({ threadId: binding.threadId, turnId: binding.turnId, readOperations: ["get_task_context", "list_assigned_skills"] });
  });
  it.each(["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "futureItem"])(
    "refuses native or unknown execution authority: %s", type => {
      expect(proveClosedReadOnlyCodexThread(thread([{ type }]), binding, allowed)).toBeNull();
    });
  it.each(["write_document", "finish_task", "call_api", "unknown_tool"])("refuses mutation or unknown tool %s", tool => {
    expect(proveClosedReadOnlyCodexThread(thread([read(tool)]), binding, allowed)).toBeNull();
  });
  it.each(["inProgress", "completed", "failed", "unknown"])("does not replay a %s turn", status => {
    const value = thread(); value.turns[0].status = status;
    expect(proveClosedReadOnlyCodexThread(value, binding, allowed)).toBeNull();
  });
  it("checks all turns, including native work before the interrupted turn", () => {
    const value = thread();
    value.turns.unshift({ id: "earlier", status: "completed", items: [{ type: "commandExecution" }] });
    expect(proveClosedReadOnlyCodexThread(value, binding, allowed)).toBeNull();
  });
  it.each([null, {}, { ...thread(), id: "other" }, { ...thread(), cwd: "C:\\other" }, { ...thread(), turns: [] },
    { ...thread(), turns: [{ id: "other", status: "interrupted", items: [] }] }])("refuses malformed or unbound evidence %#", value => {
    expect(proveClosedReadOnlyCodexThread(value, binding, allowed)).toBeNull();
  });
  it("refuses a live later turn even if the interrupted turn was read-only", () => {
    const value = thread(); value.turns.push({ id: "later", status: "inProgress", items: [] });
    expect(proveClosedReadOnlyCodexThread(value, binding, allowed)).toBeNull();
  });
});

describe("saved Codex thread reader", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["closed", "foreign", "escape", "timeout"])("uses only a credential-free disposable read (%s)", async mode => {
    const root = await mkdtemp(path.join(tmpdir(), "pc-reader-test-"));
    const sourceHome = path.join(root, "source"), script = path.join(root, "provider.cjs"), log = path.join(root, "calls");
    const relative = path.join("sessions", "2026", "01", "01", "rollout-test-thread-1.jsonl");
    await mkdir(path.dirname(path.join(sourceHome, relative)), { recursive: true });
    const saved = JSON.stringify(thread());
    await writeFile(path.join(sourceHome, relative), saved);
    await writeFile(path.join(sourceHome, "state_5.sqlite"), "original index");
    await writeFile(path.join(sourceHome, "thread_history_1.sqlite"), "original history");
    await writeFile(path.join(sourceHome, "auth.json"), "PRIVATE_AUTH_CANARY");
    vi.stubEnv("OPENAI_API_KEY", "PRIVATE_ENV_CANARY");
    await writeFile(script, `const fs=require('node:fs'),path=require('node:path');
      const root=process.env.CODEX_HOME, mode=process.argv[2], log=process.argv[3], relative=process.argv[4];
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line); if(!m.id)return;
        fs.appendFileSync(log,JSON.stringify({method:m.method,auth:fs.existsSync(path.join(root,'auth.json')),key:!!process.env.OPENAI_API_KEY,home:root})+'\\n');
        if(mode==='timeout')return;
        if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');return;}
        if(m.method!=='thread/read')throw Error('unexpected execution request');
        const thread={id:mode==='foreign'?'other':'thread-1',path:mode==='escape'?path.resolve(root,'..','outside.jsonl'):path.join(root,relative)};
        if(m.params.includeTurns)Object.assign(thread,JSON.parse(fs.readFileSync(path.join(root,relative),'utf8')));
        process.stdout.write(JSON.stringify({id:m.id,result:{thread}})+'\\n');
      });`);
    const before = await readdir(sourceHome);
    try {
      const operation = readStoppedCodexThread({ sourceHome, threadId: "thread-1", command: process.execPath,
        args: [script, mode, log, relative], timeoutMs: mode === "timeout" ? 150 : 8_000 });
      if (mode !== "closed") await expect(operation).rejects.toThrow();
      else {
        const result = await operation;
        expect(proveClosedReadOnlyCodexThread(result.thread, binding, allowed)).not.toBeNull();
        expect(result.sourceIsCurrent()).toBe(true);
        await writeFile(path.join(sourceHome, relative), saved + " ");
        expect(result.sourceIsCurrent()).toBe(false);
      }
      const calls = await readFile(log, "utf8").catch(() => "");
      const entries = calls.trim() ? calls.trim().split("\n").map(line => JSON.parse(line)) : [];
      expect(entries.every(entry => ["initialize", "thread/read"].includes(entry.method) && !entry.auth && !entry.key)).toBe(true);
      for (const home of new Set(entries.map(entry => entry.home)))
        await expect(readFile(path.join(home, "state_5.sqlite"))).rejects.toThrow();
      expect(await readFile(path.join(sourceHome, "state_5.sqlite"), "utf8")).toBe("original index");
      expect(await readFile(path.join(sourceHome, "auth.json"), "utf8")).toBe("PRIVATE_AUTH_CANARY");
      expect(await readdir(sourceHome)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }, 15_000);
});
