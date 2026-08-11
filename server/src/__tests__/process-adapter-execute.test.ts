import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../adapters/process/execute.js";

function buildContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Process Agent",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: process.execPath,
      args: [
        "-e",
        [
          "const payload = {",
          "  taskId: process.env.PAPERCLIP_TASK_ID ?? null,",
          "  runId: process.env.PAPERCLIP_RUN_ID ?? null,",
          "  wakeReason: process.env.PAPERCLIP_WAKE_REASON ?? null,",
          "  wakeCommentId: process.env.PAPERCLIP_WAKE_COMMENT_ID ?? null,",
          "  approvalId: process.env.PAPERCLIP_APPROVAL_ID ?? null,",
          "  approvalStatus: process.env.PAPERCLIP_APPROVAL_STATUS ?? null,",
          "  linkedIssueIds: process.env.PAPERCLIP_LINKED_ISSUE_IDS ?? null,",
          "  issueWorkMode: process.env.PAPERCLIP_ISSUE_WORK_MODE ?? null,",
          "  wakePayload: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON ? JSON.parse(process.env.PAPERCLIP_WAKE_PAYLOAD_JSON) : null,",
          "  apiKey: process.env.PAPERCLIP_API_KEY ?? null,",
          "};",
          "console.log(JSON.stringify(payload));",
        ].join(" "),
      ],
    },
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

describe("process adapter execute", () => {
  it("injects Paperclip wake env vars for shell-style handlers", async () => {
    const result = await execute(buildContext({
      context: {
        taskId: "issue-1",
        wakeReason: "process_lost_retry",
        wakeCommentId: "comment-1",
        approvalId: "approval-1",
        approvalStatus: "approved",
        issueIds: ["issue-1", "issue-2"],
        paperclipWake: {
          issue: {
            id: "issue-1",
            identifier: "TSMC-13258",
            status: "in_progress",
            title: "Regression",
            workMode: "standard",
          },
          fallbackFetchNeeded: false,
          latestCommentId: "comment-1",
        },
      },
      authToken: "jwt-token-1",
    }));

    expect(result.exitCode).toBe(0);
    const stdout = String(result.resultJson?.stdout ?? "").trim();
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      taskId: "issue-1",
      runId: "run-1",
      wakeReason: "process_lost_retry",
      wakeCommentId: "comment-1",
      approvalId: "approval-1",
      approvalStatus: "approved",
      linkedIssueIds: "issue-1,issue-2",
      issueWorkMode: "standard",
      apiKey: "jwt-token-1",
    });
    expect(parsed.wakePayload).toMatchObject({
      issue: { id: "issue-1", identifier: "TSMC-13258" },
      latestCommentId: "comment-1",
      fallbackFetchNeeded: false,
    });
  });

  it("falls back to issueId when taskId is absent", async () => {
    const result = await execute(buildContext({
      context: { issueId: "issue-2" },
    }));

    expect(result.exitCode).toBe(0);
    const stdout = String(result.resultJson?.stdout ?? "").trim();
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.taskId).toBe("issue-2");
  });

  it("extracts and strips a final PAPERCLIP_DISPOSITION token from stdout", async () => {
    const result = await execute(buildContext({
      config: {
        command: process.execPath,
        args: [
          "-e",
          [
            "console.log('Not a routine op; returning to the source assignee.');",
            "console.log('PAPERCLIP_DISPOSITION: {\"status\":\"done\",\"hasBlocker\":false}');",
          ].join(" "),
        ],
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      stdout: "Not a routine op; returning to the source assignee.",
      stderr: "",
      disposition: {
        status: "done",
        hasBlocker: false,
      },
    });
    expect(String(result.resultJson?.stdout ?? "")).not.toContain("PAPERCLIP_DISPOSITION:");
  });

  it("extracts a disposition concatenated after Markdown emphasis", async () => {
    const result = await execute(buildContext({
      config: {
        command: process.execPath,
        args: [
          "-e",
          "console.log('**Final check**PAPERCLIP_DISPOSITION {\\\"status\\\":\\\"in_review\\\",\\\"hasBlocker\\\":false}');",
        ],
      },
    }));

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      stdout: "**Final check**",
      disposition: { status: "in_review", hasBlocker: false },
    });
  });

  it("injects auth and scoped wake env so shell handlers can close the issue", async () => {
    const requests: Array<{
      method: string;
      url: string;
      authorization: string | null;
      runId: string | null;
      body: string;
    }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : null,
          runId: typeof req.headers["x-paperclip-run-id"] === "string" ? req.headers["x-paperclip-run-id"] : null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      throw new Error("Failed to bind test server");
    }

    const originalApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    process.env.PAPERCLIP_RUNTIME_API_URL = `http://127.0.0.1:${address.port}`;

    try {
      const result = await execute(buildContext({
        context: { taskId: "issue-123" },
        authToken: "jwt-token-1",
        config: {
          command: process.execPath,
          args: [
            "-e",
            [
              "const apiUrl = process.env.PAPERCLIP_API_URL;",
              "const taskId = process.env.PAPERCLIP_TASK_ID;",
              "const apiKey = process.env.PAPERCLIP_API_KEY;",
              "const runId = process.env.PAPERCLIP_RUN_ID;",
              "const response = await fetch(`${apiUrl}/api/issues/${taskId}`, {",
              "  method: 'PATCH',",
              "  headers: {",
              "    'content-type': 'application/json',",
              "    authorization: `Bearer ${apiKey}`,",
              "    'x-paperclip-run-id': runId,",
              "  },",
              "  body: JSON.stringify({ status: 'done', comment: 'Closed from process adapter test.' }),",
              "});",
              "console.log(JSON.stringify({ status: response.status }));",
            ].join(" "),
          ],
        },
      }));

      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: "PATCH",
        url: "/api/issues/issue-123",
        authorization: "Bearer jwt-token-1",
        runId: "run-1",
      });
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        status: "done",
        comment: "Closed from process adapter test.",
      });
    } finally {
      if (originalApiUrl == null) {
        delete process.env.PAPERCLIP_RUNTIME_API_URL;
      } else {
        process.env.PAPERCLIP_RUNTIME_API_URL = originalApiUrl;
      }
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
