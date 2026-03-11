import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

const FAKE_QWEN_SCRIPT = String.raw`#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function appendInvocation(cwd, payload) {
  const file = path.join(cwd, ".fake-qwen-invocations.jsonl");
  await fs.appendFile(file, JSON.stringify(payload) + "\n", "utf8");
}

async function apiFetch(targetPath, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", "Bearer " + process.env.PAPERCLIP_API_KEY);
  if (init.method && init.method !== "GET" && process.env.PAPERCLIP_RUN_ID) {
    headers.set("X-Paperclip-Run-Id", process.env.PAPERCLIP_RUN_ID);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(new URL(targetPath, process.env.PAPERCLIP_API_URL), {
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(init.method + " " + targetPath + " failed: " + response.status + " " + text);
  }
  return response;
}

async function main() {
  const prompt = readFlag("-p") ?? "";
  const outputFormat = readFlag("--output-format") ?? "stream-json";
  const resumeSessionId = readFlag("--resume");
  const cwd = process.cwd();
  const issueId = process.env.PAPERCLIP_TASK_ID;

  await appendInvocation(cwd, {
    issueId,
    outputFormat,
    resumeSessionId,
    promptPreview: prompt.slice(0, 120),
    argv: process.argv.slice(2),
  });

  if (outputFormat === "json") {
    process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    return;
  }

  if (!issueId) {
    throw new Error("PAPERCLIP_TASK_ID is required");
  }

  await apiFetch("/api/issues/" + issueId + "/checkout", {
    method: "POST",
    body: JSON.stringify({
      agentId: process.env.PAPERCLIP_AGENT_ID,
      expectedStatuses: ["todo", "backlog", "blocked", "in_progress"],
    }),
  });

  const issue = await apiFetch("/api/issues/" + issueId).then((res) => res.json());
  const title = typeof issue.title === "string" ? issue.title : "";
  const sessionId = resumeSessionId || "qwen-session-demo";
  const createdFiles = [];

  if (/test/i.test(title)) {
    await fs.writeFile(
      path.join(cwd, "test_hello.py"),
      'from hello import main\n\n\ndef test_main(capsys):\n    main()\n    captured = capsys.readouterr()\n    assert captured.out.strip() == "Hello World"\n',
      "utf8",
    );
    createdFiles.push("test_hello.py");
  } else if (/hello\.py/i.test(title)) {
    await fs.writeFile(
      path.join(cwd, "hello.py"),
      'def main():\n    print("Hello World")\n\n\nif __name__ == "__main__":\n    main()\n',
      "utf8",
    );
    createdFiles.push("hello.py");
  }

  const summary =
    createdFiles.length > 0
      ? "Updated " + createdFiles.join(", ")
      : "No filesystem changes were required";
  const commentLines = [
    "## Update",
    "",
    "Completed by the qwen_local end-to-end fixture.",
    "",
    "- Files: " + (createdFiles.length > 0 ? createdFiles.map((file) => "\`" + file + "\`").join(", ") : "none"),
    "- Session: \`" + sessionId + "\`",
  ];
  if (resumeSessionId) {
    commentLines.push("- Resumed via \`--resume " + resumeSessionId + "\`");
  }

  await apiFetch("/api/issues/" + issueId, {
    method: "PATCH",
    body: JSON.stringify({
      status: "done",
      comment: commentLines.join("\n"),
    }),
  });

  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "session_start",
      sessionId,
      model: "qwen3-coder-plus",
      provider: "qwen-fixture",
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: summary },
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      summary,
      usage: {
        inputTokens: resumeSessionId ? 42 : 24,
        outputTokens: resumeSessionId ? 14 : 9,
        cachedInputTokens: resumeSessionId ? 7 : 0,
        costUsd: resumeSessionId ? 0.00084 : 0.00042,
      },
    }) + "\n",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ type: "error", message }) + "\n");
  process.exitCode = 1;
});
`;

type HeartbeatRun = {
  id: string;
  status: string;
  error: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
};

type Issue = {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

async function apiJson<T>(responsePromise: Promise<{ ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }>): Promise<T> {
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`API request failed with ${response.status()}: ${await response.text()}`);
  }
  return response.json();
}

async function waitForRun(request: APIRequestContext, companyId: string, runId: string): Promise<HeartbeatRun> {
  await expect
    .poll(
      async () => {
        const runs = await apiJson<HeartbeatRun[]>(
          request.get(`/api/companies/${companyId}/heartbeat-runs?limit=20`),
        );
        return runs.find((run) => run.id === runId)?.status ?? null;
      },
      {
        timeout: 60_000,
        intervals: [250, 500, 1_000, 2_000],
      },
    )
    .toMatch(/^(succeeded|failed|timed_out|cancelled)$/);

  const runs = await apiJson<HeartbeatRun[]>(
    request.get(`/api/companies/${companyId}/heartbeat-runs?limit=20`),
  );
  const run = runs.find((entry) => entry.id === runId);
  if (!run) throw new Error(`Heartbeat run ${runId} disappeared`);
  return run;
}

async function readInvocationLog(workspaceDir: string) {
  const file = path.join(workspaceDir, ".fake-qwen-invocations.jsonl");
  const contents = await fs.readFile(file, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { issueId: string; resumeSessionId: string | null; argv: string[] });
}

test.describe("qwen_local heartbeat integration", () => {
  test("runs assigned issues and resumes qwen sessions across follow-up work", async ({ request }) => {
    test.setTimeout(120_000);

    const companyName = `Qwen E2E ${Date.now()}`;
    const company = await apiJson<{ id: string }>(
      request.post("/api/companies", { data: { name: companyName } }),
    );

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-qwen-e2e-"));
    const fakeQwenPath = path.join(workspaceDir, "fake-qwen.mjs");
    await fs.writeFile(fakeQwenPath, FAKE_QWEN_SCRIPT, "utf8");
    await fs.chmod(fakeQwenPath, 0o755);

    const agent = await apiJson<{ id: string; adapterType: string }>(
      request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "Qwen Fixture",
          role: "engineer",
          capabilities: "Deterministic qwen_local heartbeat fixture",
          adapterType: "qwen_local",
          adapterConfig: {
            command: fakeQwenPath,
            cwd: workspaceDir,
            model: "qwen3-coder-plus",
            yolo: true,
          },
        },
      }),
    );
    expect(agent.adapterType).toBe("qwen_local");

    const taskKey = `qwen-thread-${Date.now()}`;
    const firstIssue = await apiJson<Issue>(
      request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Create a hello.py file that prints Hello World",
          status: "backlog",
          assigneeAgentId: agent.id,
        },
      }),
    );

    const firstRun = await apiJson<{ id: string }>(
      request.post(`/api/agents/${agent.id}/wakeup`, {
        data: {
          source: "on_demand",
          triggerDetail: "callback",
          payload: {
            issueId: firstIssue.id,
            taskKey,
          },
        },
      }),
    );

    const completedFirstRun = await waitForRun(request, company.id, firstRun.id);
    expect(completedFirstRun.status).toBe("succeeded");
    expect(completedFirstRun.error).toBeNull();
    expect(completedFirstRun.sessionIdAfter).toBeTruthy();
    expect(completedFirstRun.usageJson).toMatchObject({
      inputTokens: 24,
      outputTokens: 9,
      cachedInputTokens: 0,
      costUsd: 0.00042,
    });

    const firstIssueAfter = await apiJson<Issue>(request.get(`/api/issues/${firstIssue.id}`));
    expect(firstIssueAfter.status).toBe("done");
    expect(await fs.readFile(path.join(workspaceDir, "hello.py"), "utf8")).toContain('print("Hello World")');

    const secondIssue = await apiJson<Issue>(
      request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Add a test for hello.py",
          status: "backlog",
          assigneeAgentId: agent.id,
        },
      }),
    );

    const secondRun = await apiJson<{ id: string }>(
      request.post(`/api/agents/${agent.id}/wakeup`, {
        data: {
          source: "on_demand",
          triggerDetail: "callback",
          payload: {
            issueId: secondIssue.id,
            taskKey,
          },
        },
      }),
    );

    const completedSecondRun = await waitForRun(request, company.id, secondRun.id);
    expect(completedSecondRun.status).toBe("succeeded");
    expect(completedSecondRun.sessionIdBefore).toBe(completedFirstRun.sessionIdAfter);
    expect(completedSecondRun.sessionIdAfter).toBe(completedFirstRun.sessionIdAfter);
    expect(completedSecondRun.usageJson).toMatchObject({
      inputTokens: 42,
      outputTokens: 14,
      cachedInputTokens: 7,
      costUsd: 0.00084,
    });

    const secondIssueAfter = await apiJson<Issue>(request.get(`/api/issues/${secondIssue.id}`));
    expect(secondIssueAfter.status).toBe("done");
    expect(await fs.readFile(path.join(workspaceDir, "test_hello.py"), "utf8")).toContain("assert captured.out.strip()");

    const invocationLog = await readInvocationLog(workspaceDir);
    expect(invocationLog).toHaveLength(2);
    expect(invocationLog[0]).toMatchObject({
      issueId: firstIssue.id,
      resumeSessionId: null,
    });
    expect(invocationLog[1]).toMatchObject({
      issueId: secondIssue.id,
      resumeSessionId: completedFirstRun.sessionIdAfter,
    });
    expect(invocationLog[1]?.argv).toEqual(
      expect.arrayContaining(["--resume", completedFirstRun.sessionIdAfter ?? ""]),
    );
  });
});
