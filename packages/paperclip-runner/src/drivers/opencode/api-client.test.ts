import { describe, expect, it } from "vitest";

import {
  QUALIFIED_OPENCODE_V1_VERSION,
  QUALIFIED_OPENCODE_V2_VERSION,
  classifyOpenCodeServerInfo,
  compareOpenCodeVersions,
  createOpenCodeApiClient,
  formFieldsToQuestions,
  isQualifiedOpenCodeVersion,
  openCodeApiVersionForVersion,
  openCodeFormAnswer,
  protocolVersionForApiVersion,
} from "./api-client.js";

function captureClient(apiVersion: "v1" | "v2", directory = "/workspace") {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const response: unknown[] = [];
  const client = createOpenCodeApiClient({
    apiVersion,
    directory,
    transport: {
      request: (path, init) => {
        calls.push({ path, init });
        return Promise.resolve(response.shift() ?? {});
      },
    },
  });
  return { client, calls, respond: (value: unknown) => void response.push(value) };
}

describe("api-client version windows", () => {
  it("qualifies the documented V1 and V2 windows only", () => {
    expect(isQualifiedOpenCodeVersion(QUALIFIED_OPENCODE_V1_VERSION)).toBe(true);
    expect(isQualifiedOpenCodeVersion(QUALIFIED_OPENCODE_V2_VERSION)).toBe(true);
    expect(isQualifiedOpenCodeVersion("1.18.33")).toBe(false);
    expect(isQualifiedOpenCodeVersion("2.0.0")).toBe(true);
    expect(isQualifiedOpenCodeVersion("2.1.0")).toBe(false);
    expect(isQualifiedOpenCodeVersion("3.0.0")).toBe(false);
  });

  it("classifies the protocol family from the version", () => {
    expect(openCodeApiVersionForVersion("1.18.34")).toBe("v1");
    expect(openCodeApiVersionForVersion("2.0.26")).toBe("v2");
    expect(openCodeApiVersionForVersion("3.0.0")).toBe(null);
    expect(protocolVersionForApiVersion("v1")).toBe("http+sse/v1");
    expect(protocolVersionForApiVersion("v2")).toBe("http+sse/v2");
    expect(compareOpenCodeVersions("2.0.26", "2.0.24")).toBeGreaterThan(0);
    expect(
      classifyOpenCodeServerInfo({ version: "2.0.26", apiVersion: "v2" }),
    ).toEqual({ version: "2.0.26", apiVersion: "v2" });
    expect(
      classifyOpenCodeServerInfo({ version: "nope", apiVersion: "v2" }),
    ).toBe(null);
  });
});

describe("api-client V2 requests", () => {
  it("creates a session with the model and agent", async () => {
    const { client, calls, respond } = captureClient("v2");
    respond({ data: { id: "ses_1" } });
    const created = await client.createSession({
      title: "Paperclip run",
      providerID: "paperclip",
      modelID: "team/model",
      agent: "paperclip",
    });
    expect(created).toEqual({ id: "ses_1" });
    expect(calls[0]!.path).toBe("/api/session");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      title: "Paperclip run",
      model: { providerID: "paperclip", id: "team/model" },
      agent: "paperclip",
    });
  });

  it("prompts with plain text and interrupts through the V2 routes", async () => {
    const { client, calls } = captureClient("v2");
    await client.prompt({
      sessionId: "ses_1",
      providerID: "paperclip",
      modelID: "team/model",
      prompt: "hello",
      system: "ignored",
    });
    await client.interrupt("ses_1");
    expect(calls[0]!.path).toBe("/api/session/ses_1/prompt");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ text: "hello" });
    expect(calls[1]!.path).toBe("/api/session/ses_1/interrupt");
    expect(calls[1]!.init?.method).toBe("POST");
  });

  it("replies to permissions with a decision and to forms with an answer", async () => {
    const { client, calls } = captureClient("v2");
    await client.replyPermission({
      sessionId: "ses_1",
      requestId: "per_1",
      action: "accept_for_session",
    });
    await client.replyQuestion({
      sessionId: "ses_1",
      requestId: "frm_1",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          environment: { selectedOptionIds: ["staging"] },
          regions: { selectedOptionIds: ["US", "EU"] },
        },
      },
      nativeQuestions: formFieldsToQuestions([
        {
          key: "environment",
          type: "string",
          title: "Where?",
          options: [
            { value: "staging", label: "Staging" },
            { value: "production", label: "Production" },
          ],
        },
        {
          key: "regions",
          type: "multiselect",
          title: "Regions?",
          options: [
            { value: "US", label: "US" },
            { value: "EU", label: "EU" },
          ],
        },
      ]),
    });
    await client.rejectQuestion({ sessionId: "ses_1", requestId: "frm_2" });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ decision: "always" });
    expect(calls[0]!.path).toBe("/api/session/ses_1/permission/per_1/reply");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      answer: { environment: "staging", regions: ["US", "EU"] },
    });
    expect(calls[1]!.path).toBe("/api/session/ses_1/form/frm_1/reply");
    expect(calls[2]!.path).toBe("/api/session/ses_1/form/frm_2");
    expect(calls[2]!.init?.method).toBe("DELETE");
  });

  it("lists pending permissions and session forms", async () => {
    const { client, calls, respond } = captureClient("v2");
    respond({ data: [{ id: "per_1", sessionID: "ses_1" }] });
    respond({
      data: [
        {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Need input",
          fields: [{ key: "q", type: "string", title: "Question?" }],
        },
      ],
    });
    respond({ data: { ses_1: { type: "running" } } });
    const permissions = await client.listPendingPermissions();
    expect(permissions).toEqual([{ id: "per_1", sessionID: "ses_1" }]);
    const questions = await client.listPendingQuestions("ses_1");
    expect(questions).toEqual([
      {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Need input",
        questions: [
          expect.objectContaining({ id: "q", fieldType: "string" }),
        ],
      },
    ]);
    const active = await client.activeSessionIds();
    expect([...active]).toEqual(["ses_1"]);
    expect(calls[0]!.path).toBe("/api/permission/request");
    expect(calls[1]!.path).toBe("/api/session/ses_1/form");
    expect(calls[2]!.path).toBe("/api/session/active");
  });
});

describe("api-client V1 requests stay byte-identical", () => {
  it("uses the historical V1 prompt and question shapes", async () => {
    const { client, calls, respond } = captureClient("v1", "/workspace");
    respond({});
    respond({});
    await client.prompt({
      sessionId: "ses_1",
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
      prompt: "hello",
      system: "system text",
    });
    expect(calls[0]!.path).toBe("/session/ses_1/prompt_async");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      providerID: "openrouter",
      modelID: "deepseek/deepseek-v4-flash-0731",
      system: "system text",
      parts: [{ type: "text", text: "hello" }],
    });
    await client.replyQuestion({
      sessionId: "ses_1",
      requestId: "question-native-1",
      response: {
        schema: "paperclip.question_response.v1",
        answers: {},
      },
      nativeQuestions: [{ id: "environment", options: [{ id: "option-1", label: "Staging" }] }],
      answers: [["Canary"]],
    });
    expect(calls[1]!.path).toBe("/question/question-native-1/reply?directory=%2Fworkspace");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ answers: [["Canary"]] });
  });
});

describe("api-client V2 event normalization", () => {
  it("folds the granular session.* family into V1-shaped events", () => {
    const { client } = captureClient("v2");
    const step = client.normalizeEvent({
      id: "evt-step",
      type: "session.step.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1" },
    });
    expect(step).toEqual([
      {
        id: "evt-step#1",
        type: "message.updated",
        properties: { sessionID: "ses_1", info: { id: "msg_1", sessionID: "ses_1", role: "assistant" } },
      },
    ]);
    const firstDelta = client.normalizeEvent({
      id: "evt-delta-1",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "Hel" },
    });
    expect((firstDelta[0] as { properties: { part: { text: string } } }).properties.part.text).toBe("Hel");
    const secondDelta = client.normalizeEvent({
      id: "evt-delta-2",
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "lo" },
    });
    expect((secondDelta[0] as { properties: { part: { text: string } } }).properties.part.text).toBe("Hello");
    const ended = client.normalizeEvent({
      id: "evt-text-ended",
      type: "session.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "Hello" },
    });
    expect((ended[0] as { properties: { part: { time?: unknown } } }).properties.part.time).toBeDefined();
    const tool = client.normalizeEvent({
      id: "evt-tool",
      type: "session.tool.failed",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "bash", error: { message: "boom" } },
    });
    expect(tool).toEqual([
      {
        id: expect.stringMatching(/^evt-tool#\d+$/),
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: expect.objectContaining({
            id: "call_1",
            messageID: "msg_1",
            type: "tool",
            tool: "bash",
            state: expect.objectContaining({ status: "error", error: "boom" }),
          }),
        },
      },
    ]);
    expect(client.normalizeEvent({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })).toEqual([
      { id: expect.any(String), type: "session.idle", properties: { sessionID: "ses_1" } },
    ]);
    const permission = client.normalizeEvent({
      id: "evt-permission",
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["echo OK"] },
    });
    expect(permission).toEqual([
      {
        id: expect.stringMatching(/^evt-permission#\d+$/),
        type: "permission.updated",
        properties: expect.objectContaining({ id: "per_1", title: "shell echo OK" }),
      },
    ]);
    const form = client.normalizeEvent({
      id: "evt-form",
      type: "form.created",
      data: { form: { id: "frm_1", sessionID: "ses_1", title: "Need input", fields: [{ key: "q", type: "string", title: "Question?" }] } },
    });
    expect(form).toEqual([
      {
        id: expect.stringMatching(/^evt-form#\d+$/),
        type: "question.asked",
        properties: {
          sessionID: "ses_1",
          id: "frm_1",
          title: "Need input",
          questions: [expect.objectContaining({ id: "q", fieldType: "string" })],
        },
      },
    ]);
    expect(client.normalizeEvent({ type: "server.connected", data: {} })).toEqual([]);
  });

  it("retains the tool name across later V2 events that omit it", () => {
    const { client } = captureClient("v2");
    const started = client.normalizeEvent({
      id: "evt-tool-start",
      type: "session.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" },
    });
    expect((started[0] as { properties: { part: { tool: string } } }).properties.part.tool).toBe("read");
    // V2 omits `name` on the completed/failed update; the normalized part must
    // keep the name from the first event, or the tool is misclassified.
    const completed = client.normalizeEvent({
      id: "evt-tool-done",
      type: "session.tool.succeeded",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", output: "ok" },
    });
    expect((completed[0] as { properties: { part: { tool: string } } }).properties.part.tool).toBe("read");
    const failed = client.normalizeEvent({
      id: "evt-tool-fail",
      type: "session.tool.failed",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", error: { message: "boom" } },
    });
    expect((failed[0] as { properties: { part: { tool: string } } }).properties.part.tool).toBe("read");
  });

  it("maps Paperclip answers onto V2 form values", () => {
    const questions = formFieldsToQuestions([
      { key: "name", type: "string", title: "Name" },
      { key: "tags", type: "multiselect", title: "Tags", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    ]);
    expect(
      openCodeFormAnswer(questions, {
        schema: "paperclip.question_response.v1",
        answers: {
          name: { text: "Ada" },
          tags: { selectedOptionIds: ["a", "b"] },
        },
      }),
    ).toEqual({ name: "Ada", tags: ["a", "b"] });
  });
});
