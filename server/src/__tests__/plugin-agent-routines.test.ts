/**
 * Tests for the Agent Routines Plugin.
 *
 * Uses the SDK test harness to verify the plugin's dispatcher job handler,
 * cron matching, config validation, and error isolation.
 *
 * @see packages/plugins/examples/plugin-agent-routines/
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { TestHarness, PluginCapability } from "@paperclipai/plugin-sdk";
import manifest from "../../../packages/plugins/examples/plugin-agent-routines/src/manifest.js";
import plugin from "../../../packages/plugins/examples/plugin-agent-routines/src/worker.js";
import { shouldFireAt, validateCronExpression } from "../../../packages/plugins/examples/plugin-agent-routines/src/cron-match.js";

// ===========================================================================
// Helpers
// ===========================================================================

const AGENT_SEED = {
  id: "agent-1",
  companyId: "co-1",
  name: "Health Check Agent",
  title: null,
  role: "engineer" as const,
  reportsTo: null,
  status: "active" as const,
  adapterType: "codex-local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: [],
  capabilities: null,
  budgetMonthlyCents: 0,
  metadata: null,
  terminatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  urlKey: "health-check-agent",
};

function createRoutineHarness(config?: Record<string, unknown>): TestHarness {
  return createTestHarness({
    manifest,
    config,
  });
}

/** Build a scheduledAt timestamp matching a specific UTC time. */
function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).toISOString();
}

// ===========================================================================
// cron-match unit tests
// ===========================================================================

describe("cron-match", () => {
  describe("shouldFireAt", () => {
    it("matches every-minute wildcard", () => {
      const date = new Date(Date.UTC(2026, 2, 9, 14, 30)); // Mon March 9 2026 14:30 UTC
      expect(shouldFireAt("* * * * *", date)).toBe(true);
    });

    it("matches exact minute and hour", () => {
      const date = new Date(Date.UTC(2026, 2, 9, 9, 0));
      expect(shouldFireAt("0 9 * * *", date)).toBe(true);
    });

    it("rejects non-matching minute", () => {
      const date = new Date(Date.UTC(2026, 2, 9, 9, 5));
      expect(shouldFireAt("0 9 * * *", date)).toBe(false);
    });

    it("matches weekday range (Mon-Fri)", () => {
      // 2026-03-09 is a Monday (day 1)
      const monday = new Date(Date.UTC(2026, 2, 9, 9, 0));
      expect(shouldFireAt("0 9 * * 1-5", monday)).toBe(true);

      // 2026-03-08 is a Sunday (day 0)
      const sunday = new Date(Date.UTC(2026, 2, 8, 9, 0));
      expect(shouldFireAt("0 9 * * 1-5", sunday)).toBe(false);
    });

    it("matches step syntax", () => {
      const date = new Date(Date.UTC(2026, 2, 9, 14, 15));
      expect(shouldFireAt("*/15 * * * *", date)).toBe(true);
      expect(shouldFireAt("*/15 * * * *", new Date(Date.UTC(2026, 2, 9, 14, 7)))).toBe(false);
    });

    it("matches comma-separated values", () => {
      const date = new Date(Date.UTC(2026, 2, 9, 9, 0));
      expect(shouldFireAt("0 9,17 * * *", date)).toBe(true);

      const date2 = new Date(Date.UTC(2026, 2, 9, 17, 0));
      expect(shouldFireAt("0 9,17 * * *", date2)).toBe(true);

      const date3 = new Date(Date.UTC(2026, 2, 9, 12, 0));
      expect(shouldFireAt("0 9,17 * * *", date3)).toBe(false);
    });

    it("matches specific day of month", () => {
      const first = new Date(Date.UTC(2026, 2, 1, 0, 0));
      expect(shouldFireAt("0 0 1 * *", first)).toBe(true);

      const second = new Date(Date.UTC(2026, 2, 2, 0, 0));
      expect(shouldFireAt("0 0 1 * *", second)).toBe(false);
    });
  });

  describe("validateCronExpression", () => {
    it("returns null for valid expressions", () => {
      expect(validateCronExpression("* * * * *")).toBeNull();
      expect(validateCronExpression("0 9 * * 1-5")).toBeNull();
      expect(validateCronExpression("*/15 * * * *")).toBeNull();
      expect(validateCronExpression("0 2 1 * *")).toBeNull();
    });

    it("returns error for empty expression", () => {
      expect(validateCronExpression("")).not.toBeNull();
    });

    it("returns error for wrong number of fields", () => {
      expect(validateCronExpression("* * *")).not.toBeNull();
      expect(validateCronExpression("* * * * * *")).not.toBeNull();
    });

    it("returns error for out-of-range values", () => {
      expect(validateCronExpression("60 * * * *")).not.toBeNull();
      expect(validateCronExpression("* 25 * * *")).not.toBeNull();
      expect(validateCronExpression("* * 32 * *")).not.toBeNull();
      expect(validateCronExpression("* * * 13 *")).not.toBeNull();
      expect(validateCronExpression("* * * * 7")).not.toBeNull();
    });

    it("returns error for invalid syntax", () => {
      expect(validateCronExpression("abc * * * *")).not.toBeNull();
      expect(validateCronExpression("* * * * a-b")).not.toBeNull();
    });
  });
});

// ===========================================================================
// Plugin dispatcher tests
// ===========================================================================

describe("agent-routines plugin", () => {
  let h: TestHarness;

  describe("dispatcher fires matching routines", () => {
    beforeEach(async () => {
      h = createRoutineHarness({
        routines: [
          {
            name: "Morning health check",
            cronExpression: "0 9 * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "Run a production health check",
            enabled: true,
          },
        ],
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });
      await plugin.definition.setup(h.ctx);
    });

    it("invokes agent when cron matches", async () => {
      // 9:00 UTC — should match "0 9 * * *"
      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(1);
      expect(h.activity[0].message).toContain("invoked agent agent-1");
      expect(h.metrics).toHaveLength(1);
      expect(h.metrics[0].tags).toEqual({ routine: "Morning health check", status: "success" });
    });

    it("skips agent when cron does not match", async () => {
      // 10:00 UTC — should NOT match "0 9 * * *"
      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 10, 0),
      });

      expect(h.activity).toHaveLength(0);
      expect(h.metrics).toHaveLength(0);
    });
  });

  describe("disabled routines", () => {
    it("skips routines with enabled: false", async () => {
      h = createRoutineHarness({
        routines: [
          {
            name: "Disabled routine",
            cronExpression: "* * * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "Should not fire",
            enabled: false,
          },
        ],
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(0);
      expect(h.metrics).toHaveLength(0);
    });
  });

  describe("error isolation", () => {
    it("failing routine does not block subsequent routines", async () => {
      h = createRoutineHarness({
        routines: [
          {
            name: "Bad routine",
            cronExpression: "* * * * *",
            agentId: "missing-agent",
            companyId: "co-1",
            prompt: "This will fail",
          },
          {
            name: "Good routine",
            cronExpression: "* * * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "This should succeed",
          },
        ],
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      // Both routines should produce activity entries
      expect(h.activity).toHaveLength(2);
      expect(h.activity[0].message).toContain("failed");
      expect(h.activity[1].message).toContain("invoked");

      // Both should write metrics
      expect(h.metrics).toHaveLength(2);
      expect(h.metrics[0].tags).toEqual({ routine: "Bad routine", status: "error" });
      expect(h.metrics[1].tags).toEqual({ routine: "Good routine", status: "success" });
    });

    it("logs error for paused agent without crashing", async () => {
      h = createRoutineHarness({
        routines: [
          {
            name: "Paused agent routine",
            cronExpression: "* * * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "Target is paused",
          },
        ],
      });
      h.seed({ agents: [{ ...AGENT_SEED, status: "paused" as const }] });
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(1);
      expect(h.activity[0].message).toContain("failed");
      expect(h.metrics[0].tags).toEqual({ routine: "Paused agent routine", status: "error" });
      expect(h.logs.some((l) => l.level === "error")).toBe(true);
    });
  });

  describe("empty config", () => {
    it("handles no routines gracefully", async () => {
      h = createRoutineHarness({});
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(0);
      expect(h.metrics).toHaveLength(0);
    });

    it("handles undefined config gracefully", async () => {
      h = createRoutineHarness();
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(0);
    });
  });

  describe("multiple matching routines", () => {
    it("fires all matching routines in a single tick", async () => {
      h = createRoutineHarness({
        routines: [
          {
            name: "Routine A",
            cronExpression: "0 9 * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "Do task A",
          },
          {
            name: "Routine B",
            cronExpression: "0 9 * * *",
            agentId: "agent-1",
            companyId: "co-1",
            prompt: "Do task B",
          },
        ],
      });
      h.seed({ agents: [{ ...AGENT_SEED }] });
      await plugin.definition.setup(h.ctx);

      await h.runJob("routine-dispatcher", {
        scheduledAt: utcDate(2026, 3, 9, 9, 0),
      });

      expect(h.activity).toHaveLength(2);
      expect(h.metrics).toHaveLength(2);
    });
  });
});

// ===========================================================================
// Config validation
// ===========================================================================

describe("agent-routines config validation", () => {
  it("accepts valid config", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        {
          name: "Daily check",
          cronExpression: "0 9 * * *",
          agentId: "agent-1",
          companyId: "co-1",
          prompt: "Run health check",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid cron expression", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        {
          name: "Bad cron",
          cronExpression: "invalid cron",
          agentId: "agent-1",
          companyId: "co-1",
          prompt: "Won't work",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors![0]).toContain("Bad cron");
  });

  it("rejects out-of-range cron values", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        {
          name: "Bad range",
          cronExpression: "60 * * * *",
          agentId: "agent-1",
          companyId: "co-1",
          prompt: "Invalid minute",
        },
      ],
    });

    expect(result.ok).toBe(false);
  });

  it("reports errors for multiple invalid routines", async () => {
    const result = await plugin.definition.onValidateConfig!({
      routines: [
        {
          name: "Bad 1",
          cronExpression: "invalid",
          agentId: "a1",
          companyId: "c1",
          prompt: "p1",
        },
        {
          name: "Good",
          cronExpression: "0 9 * * *",
          agentId: "a2",
          companyId: "c1",
          prompt: "p2",
        },
        {
          name: "Bad 2",
          cronExpression: "* 25 * * *",
          agentId: "a3",
          companyId: "c1",
          prompt: "p3",
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors![0]).toContain("Bad 1");
    expect(result.errors![1]).toContain("Bad 2");
  });

  it("accepts empty routines array", async () => {
    const result = await plugin.definition.onValidateConfig!({ routines: [] });
    expect(result.ok).toBe(true);
  });

  it("accepts config without routines key", async () => {
    const result = await plugin.definition.onValidateConfig!({});
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// Manifest sanity checks
// ===========================================================================

describe("agent-routines manifest", () => {
  it("declares required capabilities", () => {
    expect(manifest.capabilities).toContain("jobs.schedule");
    expect(manifest.capabilities).toContain("agents.invoke");
    expect(manifest.capabilities).toContain("agents.read");
    expect(manifest.capabilities).toContain("activity.log.write");
    expect(manifest.capabilities).toContain("metrics.write");
  });

  it("declares routine-dispatcher job with 1-minute cron", () => {
    expect(manifest.jobs).toHaveLength(1);
    expect(manifest.jobs![0].jobKey).toBe("routine-dispatcher");
    expect(manifest.jobs![0].schedule).toBe("* * * * *");
  });

  it("has a valid instanceConfigSchema", () => {
    expect(manifest.instanceConfigSchema).toBeDefined();
    const schema = manifest.instanceConfigSchema as any;
    expect(schema.properties.routines.type).toBe("array");
    expect(schema.properties.routines.maxItems).toBe(20);
  });
});

// ===========================================================================
// Health check
// ===========================================================================

describe("agent-routines health", () => {
  it("returns ok status", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});
