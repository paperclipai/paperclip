import { describe, expect, it } from "vitest";
import type { RunnerApi } from "./api.js";
import { runnerMatrix } from "./catalog.js";
import { setupLiveFixtures } from "./live-fixtures.js";

describe("live runner fixtures", () => {
  it.each([
    ["runner-codex", "everyday-workflows", "hire-reuse"],
    ["runner-acpx-claude", "everyday-workflows", "hire-reuse"],
    ["runner-codex", "agent-chat-hardening", "hire-delegate-reuse"],
    ["runner-acpx-claude", "agent-chat-hardening", "hire-delegate-reuse"],
  ])(
    "gives %s %s/%s a personal managed account without env overrides",
    async (profile, suite, task) => {
      const execution = runnerMatrix.find(
        (e) =>
          e.suite.id === suite &&
          e.task.id === task &&
          e.profile.id === profile &&
          e.environment.id === "local",
      )!;
      const provider =
        profile === "runner-acpx-claude" ? "anthropic" : "openai";
      let connected = false;
      let agentBody: any;
      const api = {
        async post(url: string, data: any) {
          if (url === "/api/companies") return { id: "company", name: "Test" };
          if (url.endsWith("/agents")) {
            agentBody = data;
            return { id: "lead", ...data };
          }
          throw new Error(`Unexpected POST ${url}`);
        },
        async postSensitive(url: string, data: any) {
          if (url.endsWith("/ai-connections")) {
            expect(data).toMatchObject({
              provider,
              method: "api_key",
              ownership: "personal",
              apiKey: "test-value",
              agentIds: [],
              allAgents: false,
            });
            connected = true;
            return { connectionId: "managed-account" };
          }
          return { id: "secret" };
        },
        async get() {
          return [{ id: "local", driver: "local" }];
        },
      } as unknown as RunnerApi;
      const fixtures = await setupLiveFixtures({
        api,
        execution,
        executionNonce: "nonce",
        workspacePath: "/tmp/test",
        credentials: {
          OPENAI_API_KEY: "test-value",
          ANTHROPIC_API_KEY: "test-value",
        },
      });
      expect(connected).toBe(true);
      expect(agentBody.adapterConfig.env).toBeUndefined();
      expect(agentBody.runtimeConfig.aiConnection).toEqual({
        provider,
        method: "api_key",
        mode: "responsible_user",
      });
      expect((fixtures as any).aiConnection.connectionId).toBe(
        "managed-account",
      );
    },
  );

  it("installs the Daytona provider through the public API before creating its environment", async () => {
    const calls: string[] = [];
    const api = {
      async post(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") {
          expect(data).toMatchObject({ isLocalPath: true });
          expect(data?.packageName).toEqual(
            expect.stringContaining(
              "packages/plugins/sandbox-providers/daytona",
            ),
          );
          return {
            id: "plugin-daytona",
            pluginKey: "paperclip.daytona-sandbox-provider",
            status: "ready",
          };
        }
        if (path === "/api/companies") {
          return { id: "company-1", name: "Runner E2E" };
        }
        if (path.endsWith("/environments")) {
          expect(calls).toContain("POST /api/plugins/install");
          return { id: "environment-1", driver: "sandbox" };
        }
        if (path.endsWith("/agents")) {
          return { id: "agent-1", name: "Agent", companyId: "company-1" };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
      async postSensitive(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        return { id: `secret-${String(data?.key).toLowerCase()}` };
      },
      async delete(path: string) {
        calls.push(`DELETE ${path}`);
      },
    } as unknown as RunnerApi;
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.id ===
        "core-compatibility.legacy-codex.daytona.message-marker",
    );
    expect(execution).toBeDefined();

    const fixtures = await setupLiveFixtures({
      api,
      execution: execution!,
      executionNonce: "nonce",
      workspacePath: "/tmp/workspace",
      credentials: {
        OPENAI_API_KEY: "openai-test-value",
        DAYTONA_API_KEY: "daytona-test-value",
      },
      daytonaImage:
        "ghcr.io/paperclip/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(calls.indexOf("POST /api/plugins/install")).toBeLessThan(
      calls.indexOf("POST /api/companies/company-1/environments"),
    );
    await fixtures.teardown();
    expect(calls).toContain(
      "DELETE /api/environments/environment-1?destroyReusableSandboxLeases=true",
    );
  });

  it("creates a primary project workspace for reusable Daytona scope", async () => {
    const calls: string[] = [];
    const api = {
      async post(path: string, data?: Record<string, unknown>) {
        calls.push(`POST ${path}`);
        if (path === "/api/plugins/install") {
          return {
            id: "plugin-daytona",
            pluginKey: "paperclip.daytona-sandbox-provider",
            status: "ready",
          };
        }
        if (path === "/api/companies") {
          return { id: "company-1", name: "Runner E2E" };
        }
        if (path.endsWith("/environments")) {
          return { id: "environment-1", driver: "sandbox" };
        }
        if (path.endsWith("/agents")) {
          return { id: "agent-1", name: "Agent", companyId: "company-1" };
        }
        if (path.endsWith("/projects")) {
          expect(data).toMatchObject({
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "shared_workspace",
              environmentId: "environment-1",
            },
            workspace: {
              sourceType: "local_path",
              cwd: "/tmp/workspace",
              isPrimary: true,
            },
          });
          return {
            id: "project-1",
            name: data?.name,
            primaryWorkspace: {
              id: "project-workspace-1",
              cwd: "/tmp/workspace",
            },
          };
        }
        throw new Error(`Unexpected POST ${path}`);
      },
      async postSensitive(_path: string, data?: Record<string, unknown>) {
        return { id: `secret-${String(data?.key).toLowerCase()}` };
      },
      async delete() {},
    } as unknown as RunnerApi;
    const execution = runnerMatrix.find(
      (candidate) =>
        candidate.id ===
        "daytona-warm-continuity.runner-codex.daytona.warm-three-turn",
    )!;

    const fixtures = await setupLiveFixtures({
      api,
      execution,
      executionNonce: "nonce",
      workspacePath: "/tmp/workspace",
      credentials: {
        OPENAI_API_KEY: "openai-test-value",
        DAYTONA_API_KEY: "daytona-test-value",
      },
      daytonaImage:
        "ghcr.io/paperclip/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(fixtures.project?.primaryWorkspace?.id).toBe("project-workspace-1");
    expect(
      calls.indexOf("POST /api/companies/company-1/environments"),
    ).toBeLessThan(calls.indexOf("POST /api/companies/company-1/projects"));
    await fixtures.teardown();
  });
});
