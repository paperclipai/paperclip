import { describe, it, expect } from "vitest";
import type { Page } from "@playwright/test";
import {
  enterGenericMcpThroughCatalog,
  gradeUnreachableMcp,
} from "./external-mcp-failure.js";
import { scopedSessionFailureDiagnostic } from "./external-gateway-client.js";
import type { ExternalObservation } from "./external-support.js";
function pageFixture(missing?: string) {
  const actions: string[] = [];
  const page = {
    getByRole: (role: string, options?: { name?: string }) => {
      const name = options?.name ?? "";
      const locator = {
        filter: () => locator,
        getByRole: (_r: string, o: { name: string }) => ({
          click: async () => {
            if (o.name === missing) throw new Error("Missing real control");
            actions.push(o.name);
          },
        }),
        click: async () => {
          if (name === missing) throw new Error("Missing real control");
          actions.push(name);
        },
      };
      return locator;
    },
    waitForURL: async (accept: (url: URL) => boolean) => {
      expect(accept(new URL("http://fixture.invalid/RUN/apps/byo"))).toBe(true);
      expect(accept(new URL("http://fixture.invalid/RUN/apps"))).toBe(false);
      actions.push("actual /RUN/apps/byo");
    },
    goto: () => {
      throw new Error("Direct navigation rescue is forbidden");
    },
  } as unknown as Page;
  return { page, actions };
}
describe("finite held external diagnostics and visible entry correction", () => {
  it("uses visible catalog controls including the expanded custom server option", async () => {
    const { page, actions } = pageFixture();
    await enterGenericMcpThroughCatalog(page, "RUN");
    expect(actions).toEqual([
      "Connectors",
      "Connect",
      "Connect your own MCP server",
      "actual /RUN/apps/byo",
    ]);
  });
  it("does not rescue a missing catalog entry with direct navigation", async () => {
    for (const name of [
      "Connectors",
      "Connect",
      "Connect your own MCP server",
    ]) {
      const { page, actions } = pageFixture(name);
      await expect(enterGenericMcpThroughCatalog(page, "RUN")).rejects.toThrow(
        "Missing real control",
      );
      expect(actions).not.toContain("actual /RUN/apps/byo");
    }
  });
  const context = {
    companyId: "owned-company",
    agentId: "owned-agent",
    runId: "owned-run",
    issueId: "owned-issue",
    observedRunStatusAtAdmission: "running",
  };
  it("retains actual HTTP500 and admitted run binding without inventing a cause or fixing admission", () => {
    expect(
      scopedSessionFailureDiagnostic(500, context, {
        error: "private diagnostic",
      }),
    ).toEqual({
      ...context,
      httpStatus: 500,
      reasonCode: "unclassified",
      responseBodyRetained: false,
    });
  });
  it("retains only a recognized policy/context code, never a secret-bearing error or extra response fields", () => {
    for (const reason of [
      "run_company_mismatch",
      "run_agent_mismatch",
      "run_inactive",
      "run_context_mismatch",
    ]) {
      const d = scopedSessionFailureDiagnostic(403, context, {
        reasonCode: reason,
        token: "synthetic-credential",
        error: "private body",
      });
      expect(d.reasonCode).toBe(reason);
      expect(JSON.stringify(d)).not.toMatch(
        /synthetic-credential|private body/,
      );
    }
  });
  it("omits unknown, malformed, nested and secret-bearing reason values", () => {
    for (const body of [
      { reasonCode: "Bearer synthetic-credential" },
      { reasonCode: "new_upstream_message" },
      { reasonCode: { token: "synthetic-credential" } },
      { error: { reasonCode: "run_inactive" } },
      null,
      "private body",
    ]) {
      const d = scopedSessionFailureDiagnostic(500, context, body);
      expect(d.reasonCode).toBe("unclassified");
      expect(JSON.stringify(d)).not.toMatch(
        /Bearer|synthetic-credential|private body|new_upstream_message/,
      );
    }
  });
  it("visible-entry correction does not turn the retained model missing-URL question into a completed setup pass", () => {
    const o = {
      scenarioId: "connection-setup.unreachable-mcp",
      companyId: "company",
      origin: "http://fixture.invalid",
      reply: "",
      connections: [],
      phaseReplies: [],
      profiles: [],
      secrets: [],
      endpoints: [],
      interactions: [],
      activity: [],
      links: [],
      runs: [],
      humanQueries: [],
      state: {
        fixtureServerClosed: true,
        serverUrl: "http://127.0.0.1:12345/",
        genericEntryThroughVisibleCatalog: true,
        setupStatus: 502,
        visibleConnectivityError: true,
        checkAgainAvailable: true,
        displayedServerPreserved: true,
        editableUrlPreserved: true,
        abandonedDraft: true,
        noUnexpectedConnection: true,
      },
    } as unknown as ExternalObservation;
    expect(gradeUnreachableMcp(o).passed).toBe(false);
    o.reply =
      "The MCP server is not connected; correct the address or abandon this setup.";
    expect(gradeUnreachableMcp(o).passed).toBe(true);
    o.state.genericEntryThroughVisibleCatalog = false;
    expect(gradeUnreachableMcp(o).passed).toBe(false);
  });
});
