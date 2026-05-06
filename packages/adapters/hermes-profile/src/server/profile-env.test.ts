import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseAdapterConfigFromContext } from "./config.js";
import { buildPrompt } from "./execute.js";
import { buildHermesProfileEnv } from "./profile-env.js";

const baseCtx: AdapterExecutionContext = {
  runId: "run-123",
  agent: { id: "agent-1", companyId: "company-1", name: "Stella", adapterType: "hermes_profile", adapterConfig: {} },
  runtime: { sessionParams: null, sessionId: "session-1", sessionDisplayId: null, taskKey: null },
  config: { profile: "stella" },
  context: {},
  onLog: async () => {},
};

describe("hermes_profile wake context", () => {
  it("propagates nested wake task and comment context into env", () => {
    const env = buildHermesProfileEnv(
      { profile: "stella", paperclipApiUrl: "https://paperclip.example/api" },
      {
        ...baseCtx,
        context: {
          task: { id: "BLO-123", title: "Do the thing", body: "Fix the thing" },
          wakeComment: { id: "comment-456" },
          wakeReason: "issue-wake",
          linkedIssueIds: ["BLO-1", " BLO-2 ", ""],
        },
      },
      { PATH: "/usr/bin" },
    );

    expect(env.HERMES_PROFILE).toBe("stella");
    expect(env.PAPERCLIP_ADAPTER_TYPE).toBe("hermes_profile");
    expect(env.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(env.PAPERCLIP_TASK_ID).toBe("BLO-123");
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-456");
    expect(env.PAPERCLIP_WAKE_REASON).toBe("issue-wake");
    expect(env.PAPERCLIP_LINKED_ISSUE_IDS).toBe("BLO-1,BLO-2");
    expect(env.PAPERCLIP_API_URL).toBe("https://paperclip.example/api");
  });

  it("falls back to runtime session paperclipWake values when direct context is absent", () => {
    const env = buildHermesProfileEnv(
      { profile: "cleo" },
      {
        ...baseCtx,
        context: {},
        runtime: {
          sessionId: "session-2",
          sessionParams: {
            paperclipWake: {
              issueId: "BLO-999",
              taskTitle: "runtime task",
              taskBody: "runtime body",
              wakeCommentId: "comment-999",
              wakeReason: "runtime-wake",
            },
          },
          sessionDisplayId: null,
          taskKey: "runtime-task-key",
        },
      },
      { PATH: "/usr/bin" },
    );

    expect(env.PAPERCLIP_TASK_ID).toBe("BLO-999");
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-999");
    expect(env.PAPERCLIP_WAKE_REASON).toBe("runtime-wake");
  });

  it("renders prompt task fields from nested paperclipWake data", () => {
    const prompt = buildPrompt(
      {
        ...baseCtx,
        context: {
          paperclipWake: {
            taskId: "BLO-222",
            taskTitle: "wake title",
            taskBody: "wake body",
            wakeCommentId: "comment-222",
          },
        },
      },
      { profile: "stella" },
    );

    expect(prompt).toMatch(/Task ID: BLO-222/);
    expect(prompt).toMatch(/Title: wake title/);
    expect(prompt).toMatch(/Comment ID: comment-222/);
    expect(prompt).toMatch(/wake body/);
  });

  it("derives profile from the agent name when adapterConfig.profile is missing", () => {
    const config = parseAdapterConfigFromContext({
      agent: { adapterConfig: {}, name: "Fiona" },
      config: {},
    });

    expect(config.profile).toBe("fiona");
  });
});
