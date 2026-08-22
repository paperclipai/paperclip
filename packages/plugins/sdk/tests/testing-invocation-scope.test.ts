/**
 * The test harness must refuse the company-scoped calls the host refuses.
 *
 * A fake `ctx` that answers whatever it is asked does not merely fail to test
 * the host's governed-access gate — it deletes the gate from the model under
 * test. The plugin then passes its whole suite and is refused by the real host
 * on its first company-scoped call, which is how a merge-gate relay shipped
 * with 185 green tests and could not arm a single pull request.
 *
 * Every expectation below is pinned to the *host's* error string
 * (`host-client-factory.ts`), not to a harness-local message, so a divergence
 * between the fake and the host fails here rather than in production.
 */
import { describe, expect, it } from "vitest";

import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

const manifest = {
  id: "paperclip.test-invocation-scope",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Invocation Scope",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "issues.read",
    "issues.write",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
    "jobs.schedule",
    "events.subscribe",
  ],
  entrypoints: {},
} satisfies PaperclipPluginManifestV1;

/** The host's message for a company-scoped call made outside any invocation. */
const NO_SCOPE = /company context is required/;
/** The host's message for a call that leaves its invocation's company. */
const crossCompany = (requested: string, scoped: string) =>
  new RegExp(`requested company "${requested}" but the current invocation is scoped to company "${scoped}"`);

describe("createTestHarness invocation company scope", () => {
  describe("runJob", () => {
    it("refuses a company-scoped call from a job run with no company", async () => {
      const harness = createTestHarness({ manifest });
      let error: unknown;

      harness.ctx.jobs.register("sweep", async () => {
        try {
          await harness.ctx.config.get(COMPANY_A);
        } catch (err) {
          error = err;
        }
      });

      await harness.runJob("sweep");

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(NO_SCOPE);
    });

    it("allows the same call when the job handler declares its company", async () => {
      const harness = createTestHarness({ manifest, config: { token: "t" } });
      let config: Record<string, unknown> | undefined;

      harness.ctx.jobs.register("sweep", async () => {
        await harness.withCompanyScope(COMPANY_A, async () => {
          config = await harness.ctx.config.get(COMPANY_A);
        });
      });

      await harness.runJob("sweep");

      expect(config).toEqual({ token: "t" });
    });

    it("refuses a cross-company call from a company-scoped job run", async () => {
      const harness = createTestHarness({ manifest });
      let error: unknown;

      harness.ctx.jobs.register("sweep", async () => {
        await harness.withCompanyScope(COMPANY_A, async () => {
          try {
            await harness.ctx.config.get(COMPANY_B);
          } catch (err) {
            error = err;
          }
        });
      });

      await harness.runJob("sweep");

      expect((error as Error).message).toMatch(crossCompany(COMPANY_B, COMPANY_A));
    });

    it("refuses to fake a job company the scheduler cannot dispatch", async () => {
      // Both dispatch paths in `plugin-job-scheduler.ts` call `runJob` with
      // `{ job }` and no company, and `deriveInvocationScope` has no `runJob`
      // branch. A harness that minted a scope here would authorize a call the
      // real host refuses — the exact over-permissive fake this enforcement
      // exists to remove.
      const harness = createTestHarness({ manifest });
      harness.ctx.jobs.register("sweep", async () => {});

      await expect(
        (harness.runJob as (k: string, p: unknown) => Promise<void>)("sweep", { companyId: COMPANY_A }),
      ).rejects.toThrow(/cannot take a companyId/);
    });

    it("does not leak an outer scope into a nested job run", async () => {
      const harness = createTestHarness({ manifest });
      let error: unknown;

      harness.ctx.jobs.register("inner", async () => {
        try {
          await harness.ctx.config.get(COMPANY_A);
        } catch (err) {
          error = err;
        }
      });
      harness.ctx.jobs.register("outer", async () => {
        await harness.withCompanyScope(COMPANY_A, async () => {
          await harness.runJob("inner");
        });
      });

      await harness.runJob("outer");

      expect((error as Error).message).toMatch(NO_SCOPE);
    });
  });

  describe("entry points that carry a company", () => {
    it("scopes an event delivery to the event's company", async () => {
      const harness = createTestHarness({ manifest });
      harness.seed({
        issues: [
          { id: "issue-a", companyId: COMPANY_A, title: "A" },
          { id: "issue-b", companyId: COMPANY_B, title: "B" },
        ] as never,
      });
      const errors: string[] = [];
      let own: unknown;

      harness.ctx.events.on("issue.created", async () => {
        own = await harness.ctx.issues.get("issue-a", COMPANY_A);
        try {
          await harness.ctx.issues.get("issue-b", COMPANY_B);
        } catch (err) {
          errors.push((err as Error).message);
        }
      });

      await harness.emit("issue.created", {}, { companyId: COMPANY_A });

      expect(own).toBeTruthy();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(crossCompany(COMPANY_B, COMPANY_A));
    });

    it("scopes an action to the host-authorized actor company", async () => {
      const harness = createTestHarness({ manifest });
      harness.ctx.actions.register("touch", async () => {
        await harness.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY_A, stateKey: "k" },
          1,
        );
        return "ok";
      });

      await expect(harness.performAction("touch")).rejects.toThrow(NO_SCOPE);
      await expect(harness.performAction("touch", {}, { companyId: COMPANY_A }))
        .resolves.toBe("ok");
    });

    it("scopes a tool run to its run context company", async () => {
      const harness = createTestHarness({ manifest });
      harness.ctx.tools.register("write-state", {} as never, async () => {
        await harness.ctx.state.set(
          { scopeKind: "company", scopeId: COMPANY_A, stateKey: "k" },
          1,
        );
        return { content: [] } as never;
      });

      await expect(harness.executeTool("write-state", {}, { companyId: COMPANY_B }))
        .rejects.toThrow(crossCompany(COMPANY_A, COMPANY_B));
      await expect(harness.executeTool("write-state", {}, { companyId: COMPANY_A }))
        .resolves.toBeTruthy();
    });
  });

  describe("what stays allowed", () => {
    it("leaves instance-scoped state alone", async () => {
      const harness = createTestHarness({ manifest });

      await harness.ctx.state.set({ scopeKind: "instance", stateKey: "cursor" }, 7);

      expect(harness.getState({ scopeKind: "instance", stateKey: "cursor" })).toBe(7);
    });

    it("admits a proactive call for a company the plugin is configured for", async () => {
      const harness = createTestHarness({
        manifest,
        proactiveCompanyScopes: [COMPANY_A],
      });

      await harness.ctx.state.set(
        { scopeKind: "company", scopeId: COMPANY_A, stateKey: "k" },
        1,
      );

      await expect(
        harness.ctx.state.set({ scopeKind: "company", scopeId: COMPANY_B, stateKey: "k" }, 1),
      ).rejects.toThrow(NO_SCOPE);
    });

    it("does not let a proactive grant widen an active invocation", async () => {
      const harness = createTestHarness({
        manifest,
        proactiveCompanyScopes: [COMPANY_A, COMPANY_B],
      });
      let error: unknown;

      harness.ctx.jobs.register("sweep", async () => {
        await harness.withCompanyScope(COMPANY_A, async () => {
          try {
            await harness.ctx.state.set(
              { scopeKind: "company", scopeId: COMPANY_B, stateKey: "k" },
              1,
            );
          } catch (err) {
            error = err;
          }
        });
      });

      await harness.runJob("sweep");

      expect((error as Error).message).toMatch(crossCompany(COMPANY_B, COMPANY_A));
    });
  });

  describe("withCompanyScope", () => {
    it("lets a test drive ctx directly as one company", async () => {
      const harness = createTestHarness({ manifest, config: { token: "t" } });

      await expect(harness.ctx.config.get(COMPANY_A)).rejects.toThrow(NO_SCOPE);

      await harness.withCompanyScope(COMPANY_A, async () => {
        await expect(harness.ctx.config.get(COMPANY_A)).resolves.toEqual({ token: "t" });
      });
    });

    it("is a scope, not a bypass — another company is still refused inside it", async () => {
      const harness = createTestHarness({ manifest });

      await harness.withCompanyScope(COMPANY_A, async () => {
        await expect(harness.ctx.config.get(COMPANY_B))
          .rejects.toThrow(crossCompany(COMPANY_B, COMPANY_A));
      });
    });

    it("restores the previous scope when it returns", async () => {
      const harness = createTestHarness({ manifest });

      await harness.withCompanyScope(COMPANY_A, async () => {
        await harness.withCompanyScope(COMPANY_B, async () => {
          await expect(harness.ctx.config.get(COMPANY_B)).resolves.toBeTruthy();
        });
        await expect(harness.ctx.config.get(COMPANY_A)).resolves.toBeTruthy();
      });

      await expect(harness.ctx.config.get(COMPANY_A)).rejects.toThrow(NO_SCOPE);
    });

    it("restores the previous scope when the body throws", async () => {
      const harness = createTestHarness({ manifest });

      await harness.withCompanyScope(COMPANY_A, async () => {
        await expect(
          harness.withCompanyScope(COMPANY_B, async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        await expect(harness.ctx.config.get(COMPANY_A)).resolves.toBeTruthy();
      });
    });
  });
});
