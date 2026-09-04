import { describe, expect, it } from "vitest";
import type { RunnerApi } from "./api.js";
import { runnerMatrix } from "./catalog.js";
import { setupLiveFixtures } from "./live-fixtures.js";

describe("live runner fixtures", () => {
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
});
