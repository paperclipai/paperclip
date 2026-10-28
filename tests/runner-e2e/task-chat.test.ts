import { describe, expect, it } from "vitest";
import { captureTaskChat, projectTaskChatThread, type TaskChatEvidence } from "./task-chat.js";
import { renderTaskChat } from "./task-chat-report.js";
import { taskChatProgress } from "./task-chat-progress.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { RunnerE2EResult } from "./types.js";

const time = "2026-10-28T12:00:00Z";
const issue = { id: "task", companyId: "company", identifier: "E2E-1", title: "Write the release note", description: "Please write a release note.", createdAt: time };
const question = { id: "question", createdAt: "2026-10-28T12:00:02Z", resolvedAt: "2026-10-28T12:00:03Z", kind: "ask_user_questions", status: "answered",
  payload: { questionSet: { questions: [{ id: "tone", prompt: "Which tone?", options: [{ id: "warm", label: "Warm" }, { id: "formal", label: "Formal" }] }] },
    toolAction: { argumentsJson: "PRIVATE_TOOL_ARGUMENTS" } },
  result: { answers: { tone: { selectedOptionIds: ["warm"], text: "Include the launch date" } }, providerSessionId: "PRIVATE_SESSION" } };
const comment = (i: number) => ({ id: `comment-${i}`, body: `Message ${i}`, authorAgentId: i % 2 ? "agent" : null,
  authorUserId: i % 2 ? null : "PRIVATE_USER", createdAt: new Date(Date.parse(time) + i * 1000).toISOString() });

function fixture(overrides: { comments?: ReturnType<typeof comment>[]; fail?: string; empty?: boolean; chats?: boolean } = {}) {
  const comments = overrides.comments ?? [comment(1), comment(4)];
  const calls: string[] = [];
  const get = async <T>(route: string): Promise<T> => {
    calls.push(route);
    if (overrides.fail && route.includes(overrides.fail)) throw new Error("PRIVATE_API_RESPONSE");
    const url = new URL(route, "http://fixture.test");
    let response: unknown;
    if (url.pathname.endsWith("/agents")) response = [{ id: "agent", name: "Morgan", apiKey: "PRIVATE_AGENT_KEY" }];
    else if (url.pathname.endsWith("/experimental")) response = { enableAgentChat: overrides.chats ?? false };
    else if (url.pathname.endsWith("/chats")) response = [{ ...issue, id: "chat", title: "Chat with Morgan", description: null }];
    else if (url.pathname.endsWith("/issues")) response = overrides.empty ? [] : [issue];
    else if (url.pathname.endsWith("/comments")) {
      const cursor = comments.findIndex(c => c.id === url.searchParams.get("after"));
      response = comments.slice(cursor + 1, cursor + 101);
    } else if (url.pathname.endsWith("/interactions")) response = [question];
    else if (url.pathname.endsWith("/runs")) response = [];
    else if (url.pathname === "/api/issues/chat") response = { ...issue, id: "chat", title: "Chat with Morgan", description: null };
    else throw new Error(`Unexpected route ${route}`);
    return structuredClone(response) as T;
  };
  return { get, calls };
}

describe("automatic task conversation evidence", () => {
  it("reads a long saved conversation beyond the first page and retains every full message", async () => {
    const comments = Array.from({ length: 1105 }, (_, i) => comment(i));
    comments[1104]!.body = "Final reply " + "Long text. ".repeat(2000);
    const api = fixture({ comments });
    const e = await captureTaskChat({ get: api.get, companyId: "company", secrets: [] });
    expect(e.status).toBe("complete");
    const messages = e.threads[0]!.messages.filter(m => m.kind === "comment");
    expect(messages).toHaveLength(1105);
    expect(messages.at(-1)?.body).toBe(comments[1104]!.body);
    expect(new Set(messages.map(m => m.id)).size).toBe(1105);
    expect(api.calls.filter(route => route.includes("/comments"))).toHaveLength(12);
    expect(renderTaskChat(e)).toContain(comments[1104]!.body);
  });

  it("includes the standing chat after its setting is restored, plus the delegated task", async () => {
    const api = fixture();
    const e = await captureTaskChat({ get: api.get, companyId: "company", issueIds: ["chat", "chat"], secrets: [] });
    expect(e.threads.map(t => t.issueId)).toEqual(["task", "chat"]);
    expect(e.status).toBe("complete");
    expect(api.calls).not.toContain("/api/companies/company/chats");
    expect(e.threads[0]!.messages.map(m => m.kind)).toEqual(["description", "comment", "interaction", "answer", "comment"]);
    const body = e.threads[0]!.messages.find(m => m.kind === "answer")!.body;
    expect(body).toContain("Warm");
    expect(body).toContain("Include the launch date");
    for (const privateValue of ["PRIVATE_USER", "PRIVATE_AGENT_KEY", "PRIVATE_TOOL_ARGUMENTS", "PRIVATE_SESSION"])
      expect(JSON.stringify(e)).not.toContain(privateValue);
  });

  it("redacts credentials and escapes untrusted chat HTML without cutting off messages", async () => {
    const c = comment(1); c.body = 'A secret: fixture-secret-123 <img src=x onerror="alert(1)">';
    const e = await captureTaskChat({ get: fixture({ comments: [c] }).get, companyId: "company", secrets: ["fixture-secret-123"] });
    const page = renderTaskChat(e);
    expect(page).not.toContain("fixture-secret-123");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;img");
  });

  it("collects native progress beyond the first event page through the task API", async () => {
    const api = fixture();
    const requests: string[] = [];
    const e = await captureTaskChat({ companyId: "company", secrets: [], get: async <T>(route: string): Promise<T> => {
      requests.push(route);
      if (route.endsWith("/runs")) return [{ runId: "run", runtimeMode: "native", agentId: "agent" }] as T;
      if (route.startsWith("/api/heartbeat-runs/run/events?")) {
        const after = Number(new URL(route, "http://fixture.test").searchParams.get("afterSeq"));
        if (!after) return Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, eventType: "runtime.status" })) as T;
        return [{ seq: 1001, eventType: "item.completed", createdAt: time, payload: { prpEvent: {
          schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", itemId: "provider-item", eventType: "item.completed",
          payload: { kind: "agent_message", channel: "progress", text: "I found the file." },
        } } }] as T;
      }
      return api.get<T>(route);
    } });
    expect(e.status).toBe("complete");
    expect(e.threads[0]!.messages).toContainEqual(expect.objectContaining({ kind: "progress", body: "I found the file.", author: "Morgan" }));
    expect(requests.some(route => route.includes("afterSeq=1000"))).toBe(true);
    expect(JSON.stringify(e)).not.toContain("provider-item");
    expect(requests.some(route => route.includes("undefined"))).toBe(false);
  });

  it("retains every item-review verdict and reason with its visible label", () => {
    const review = { id: "review", kind: "request_item_verdicts", status: "resolved", createdAt: time, resolvedAt: time,
      payload: { prompt: "Review both changes", items: [{ id: "a", label: "Release note" }, { id: "b", label: "Announcement" }] },
      result: { items: [{ id: "a", verdict: "approve", reason: "Ready to publish" }, { id: "b", verdict: "reject", reason: "Fix the date", metadata: "PRIVATE_VERDICT_METADATA" }] } };
    const thread = projectTaskChatThread(issue, [], [review], new Map());
    const answer = thread.messages.find(message => message.kind === "answer")!;
    for (const content of ["Release note", "approve", "Ready to publish", "Announcement", "reject", "Fix the date"]) expect(answer.body).toContain(content);
    expect(JSON.stringify(thread)).not.toContain("PRIVATE_VERDICT_METADATA");
  });

  it("keeps company boundaries and does not read a foreign task's messages", async () => {
    const api = fixture({ empty: true });
    const calls: string[] = [];
    const e = await captureTaskChat({ companyId: "company", issueIds: ["foreign"], secrets: [], get: async <T>(route: string): Promise<T> => {
      calls.push(route);
      return route === "/api/issues/foreign" ? { ...issue, id: "foreign", companyId: "other", description: "PRIVATE_FOREIGN_TASK" } as T : api.get<T>(route);
    } });
    expect(e.status).toBe("unavailable");
    expect(e.missing).toContain("task-read");
    expect(calls.some(route => route.includes("/foreign/comments"))).toBe(false);
    expect(JSON.stringify(e)).not.toContain("PRIVATE_FOREIGN_TASK");
  });

  it("keeps available history and labels failed capture without retaining the API error body", async () => {
    const e = await captureTaskChat({ get: fixture({ fail: "/interactions" }).get, companyId: "company", secrets: [] });
    expect(e).toMatchObject({ status: "partial", missing: ["interactions"], threads: [{ status: "partial" }] });
    expect(renderTaskChat(e)).toContain("Message 4");
    expect(renderTaskChat(e)).toContain("partial capture");
    expect(JSON.stringify(e)).not.toContain("PRIVATE_API_RESPONSE");
  });

  it("rejects repeated pages and retains the already collected prefix as partial", async () => {
    const api = fixture({ comments: Array.from({ length: 100 }, (_, i) => comment(i)) });
    const e = await captureTaskChat({ get: route => api.get(route.replace(/&after=[^&]+/, "")), companyId: "company", secrets: [] });
    expect(e.status).toBe("partial");
    expect(e.missing).toContain("comments");
    expect(e.threads[0]!.messages.filter(m => m.kind === "comment")).toHaveLength(100);
  });

  it("has no chat section for a browser-only test with no tasks", async () => {
    const e = await captureTaskChat({ get: fixture({ empty: true }).get, companyId: "company", secrets: [] });
    expect(e).toMatchObject({ status: "complete", threads: [] });
    expect(renderTaskChat(e)).toBe("");
    expect(renderTaskChat()).toBe("");
  });

  it("survives normalized result validation and rejects raw fields inside the public projection", () => {
    const taskChat: TaskChatEvidence = { schema: "paperclip.runner-e2e.task-chat/v1", capturedAt: time, status: "complete", missing: [],
      threads: [projectTaskChatThread(issue, [comment(1)], [], new Map())] };
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: "core-compatibility.runner-codex.local.message-marker",
      suiteId: "core-compatibility", attempt: 1, status: "failed", profileId: "runner-codex", environmentId: "local", caseId: "message-marker",
      runtimeMode: "native", provider: "codex", model: "fixture", startedAt: time, finishedAt: time, durationMs: 0, cleanup: "passed", taskChat };
    expect(() => validateRetainedRunnerResult(JSON.parse(JSON.stringify(result)))).not.toThrow();
    Object.assign(taskChat.threads[0]!.messages[0]!, { rawProviderEnvelope: {} });
    expect(() => validateRetainedRunnerResult(result)).toThrow();
  });

  it("reassembles native progress, prefers completed text, and withholds reasoning and final duplicates", () => {
    const event = (eventType: string, itemId: string, payload: object, seq: number) => ({ eventType, createdAt: time,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", sourceEventId: `event-${seq}`, itemId, eventType, payload } } });
    const events = [event("item.started", "provider-item", { kind: "agent_message", channel: "progress" }, 1),
      event("item.delta", "provider-item", { text: "Checking " }, 2), event("item.delta", "provider-item", { text: "files" }, 3),
      event("item.completed", "provider-item", { text: "Checking files now." }, 4),
      event("item.completed", "reasoning", { kind: "reasoning", channel: "progress", text: "PRIVATE_REASONING" }, 5),
      event("item.completed", "final", { kind: "agent_message", channel: "final", text: "Final duplicate" }, 6)];
    const progress = taskChatProgress("run", events, "Morgan");
    expect(progress).toEqual([{ id: "progress:run:1", at: time, role: "agent", author: "Morgan", kind: "progress", body: "Checking files now." }]);
    expect(taskChatProgress("other-run", events, "Morgan")).toEqual([]);
    expect(taskChatProgress("run", [...events.slice(0, 3), events[2]!], "Morgan")[0]!.body).toBe("Checking files");
    const terminal = event("turn.completed", "", { outputTails: [{ itemId: "provider-item", payload: { text: " now." } }] }, 7);
    expect(taskChatProgress("run", [...events.slice(0, 3), terminal], "Morgan")[0]!.body).toBe("Checking files now.");
  });
});
