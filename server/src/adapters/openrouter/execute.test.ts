import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext(): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "OpenRouter Agent",
      adapterType: "openrouter_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: `/tmp/paperclip-openrouter-test-${Date.now()}`,
      env: { OPENROUTER_API_KEY: "test-key" },
      maxTurns: 2,
    },
    context: {},
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
  };
}

describe("openrouter adapter issue tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an update_issue comment with the issue status patch", async () => {
    let openrouterCalls = 0;
    let patchBody: unknown = null;

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        openrouterCalls += 1;
        if (openrouterCalls === 1) {
          return mockJsonResponse({
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "tool-1",
                  type: "function",
                  function: {
                    name: "update_issue",
                    arguments: JSON.stringify({
                      issue_identifier: "PAP-1135",
                      status: "in_progress",
                      comment: "Changes requested: add a regression test.",
                    }),
                  },
                }],
              },
            }],
          });
        }

        return mockJsonResponse({
          choices: [{ message: { role: "assistant", content: "Updated the issue." } }],
        });
      }

      if (url === "http://localhost:3100/api/companies/company-1/issues?identifier=PAP-1135") {
        return mockJsonResponse([{ id: "issue-1", identifier: "PAP-1135" }]);
      }

      if (url === "http://localhost:3100/api/issues/issue-1/checkout") {
        return mockJsonResponse({ ok: true });
      }

      if (url === "http://localhost:3100/api/issues/issue-1" && init?.method === "PATCH") {
        patchBody = JSON.parse(String(init.body));
        return mockJsonResponse({ id: "issue-1", identifier: "PAP-1135", status: "in_progress" });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeContext());

    expect(result.exitCode).toBe(0);
    expect(patchBody).toEqual({
      status: "in_progress",
      comment: "Changes requested: add a regression test.",
    });
  });
});
