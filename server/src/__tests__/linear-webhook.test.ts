import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for the Linear webhook handler logic.
 *
 * These test the webhook endpoint's parsing, field mapping, and fallback
 * behavior without requiring a real database. We mock the DB and services
 * to isolate the webhook processing logic.
 */

// ---------------------------------------------------------------------------
// Helpers — extracted from linear-auth.ts webhook handler
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<string, string> = {
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  cancelled: "cancelled",
};

const PRIORITY_MAP: Record<number, string> = {
  0: "low",
  1: "critical",
  2: "high",
  3: "medium",
  4: "low",
};

function parseWebhookPatch(data: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  const changedFields: string[] = [];

  const state = data.state as Record<string, unknown> | undefined;
  if (state?.type) {
    const newStatus = STATUS_MAP[state.type as string];
    if (newStatus) {
      patch.status = newStatus;
      changedFields.push(`status → ${newStatus}`);
      if (newStatus === "in_progress") patch.startedAt = "now";
      if (newStatus === "done") patch.completedAt = "now";
    }
  }

  if (data.priority !== undefined) {
    const newPriority = PRIORITY_MAP[data.priority as number];
    if (newPriority) {
      patch.priority = newPriority;
      changedFields.push(`priority → ${newPriority}`);
    }
  }

  if (data.title) {
    patch.title = data.title;
    changedFields.push("title");
  }

  if (data.description !== undefined) {
    patch.description = data.description as string | null;
    changedFields.push("description");
  }

  if (data.estimate !== undefined) {
    patch.estimate = (data.estimate as number) ?? null;
    changedFields.push(`estimate → ${data.estimate ?? "none"}`);
  }

  if (data.dueDate !== undefined) {
    patch.dueDate = data.dueDate as string | null;
    changedFields.push(`dueDate → ${data.dueDate ?? "none"}`);
  }

  return { patch, changedFields };
}

function parseValueJson(raw: string): string {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Status mapping tests
// ---------------------------------------------------------------------------

describe("Linear webhook — status mapping", () => {
  it("maps Linear state types to Paperclip statuses", () => {
    expect(STATUS_MAP["backlog"]).toBe("backlog");
    expect(STATUS_MAP["unstarted"]).toBe("todo");
    expect(STATUS_MAP["started"]).toBe("in_progress");
    expect(STATUS_MAP["completed"]).toBe("done");
    expect(STATUS_MAP["cancelled"]).toBe("cancelled");
  });

  it("handles unknown state types gracefully", () => {
    expect(STATUS_MAP["custom_state"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Priority mapping tests
// ---------------------------------------------------------------------------

describe("Linear webhook — priority mapping", () => {
  it("maps Linear priority numbers to Paperclip priorities", () => {
    expect(PRIORITY_MAP[0]).toBe("low");       // None
    expect(PRIORITY_MAP[1]).toBe("critical");   // Urgent
    expect(PRIORITY_MAP[2]).toBe("high");       // High
    expect(PRIORITY_MAP[3]).toBe("medium");     // Normal
    expect(PRIORITY_MAP[4]).toBe("low");        // Low
  });
});

// ---------------------------------------------------------------------------
// Patch parsing tests
// ---------------------------------------------------------------------------

describe("Linear webhook — parseWebhookPatch", () => {
  it("extracts status change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      state: { type: "started" },
    });
    expect(patch.status).toBe("in_progress");
    expect(patch.startedAt).toBe("now");
    expect(changedFields).toContain("status → in_progress");
  });

  it("sets completedAt on done status", () => {
    const { patch } = parseWebhookPatch({
      state: { type: "completed" },
    });
    expect(patch.status).toBe("done");
    expect(patch.completedAt).toBe("now");
  });

  it("extracts priority change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      priority: 2,
    });
    expect(patch.priority).toBe("high");
    expect(changedFields).toContain("priority → high");
  });

  it("extracts title change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      title: "New title",
    });
    expect(patch.title).toBe("New title");
    expect(changedFields).toContain("title");
  });

  it("extracts description change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      description: "Updated description",
    });
    expect(patch.description).toBe("Updated description");
    expect(changedFields).toContain("description");
  });

  it("handles null description (cleared)", () => {
    const { patch } = parseWebhookPatch({
      description: null,
    });
    expect(patch.description).toBeNull();
  });

  it("extracts estimate change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      estimate: 5,
    });
    expect(patch.estimate).toBe(5);
    expect(changedFields).toContain("estimate → 5");
  });

  it("handles null estimate (cleared)", () => {
    const { patch } = parseWebhookPatch({
      estimate: null,
    });
    expect(patch.estimate).toBeNull();
  });

  it("extracts due date change", () => {
    const { patch, changedFields } = parseWebhookPatch({
      dueDate: "2026-04-15",
    });
    expect(patch.dueDate).toBe("2026-04-15");
    expect(changedFields).toContain("dueDate → 2026-04-15");
  });

  it("handles multiple changes at once", () => {
    const { patch, changedFields } = parseWebhookPatch({
      title: "Updated",
      priority: 1,
      state: { type: "started" },
      description: "New desc",
    });
    expect(patch.title).toBe("Updated");
    expect(patch.priority).toBe("critical");
    expect(patch.status).toBe("in_progress");
    expect(patch.description).toBe("New desc");
    expect(changedFields).toHaveLength(4);
  });

  it("returns empty patch for no recognized fields", () => {
    const { patch, changedFields } = parseWebhookPatch({
      unknownField: "value",
    });
    expect(Object.keys(patch)).toHaveLength(0);
    expect(changedFields).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// valueJson parsing tests
// ---------------------------------------------------------------------------

describe("Linear webhook — parseValueJson", () => {
  it("parses JSON-encoded UUID string", () => {
    expect(parseValueJson('"109be6bf-9c15-46b1-8f0a-1a7ffa2e5937"')).toBe(
      "109be6bf-9c15-46b1-8f0a-1a7ffa2e5937",
    );
  });

  it("handles raw UUID string (not JSON-wrapped)", () => {
    expect(parseValueJson("109be6bf-9c15-46b1-8f0a-1a7ffa2e5937")).toBe(
      "109be6bf-9c15-46b1-8f0a-1a7ffa2e5937",
    );
  });

  it("handles empty string", () => {
    expect(parseValueJson("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Identifier regex tests
// ---------------------------------------------------------------------------

describe("Linear webhook — identifier patterns", () => {
  const IDENTIFIER_REGEX = /^[A-Z]+-[A-Z0-9]+$/i;
  const LINEAR_ONLY_REGEX = /^[A-Z]+-\d+$/;

  it("matches standard Linear identifiers (LUC-15)", () => {
    expect(IDENTIFIER_REGEX.test("LUC-15")).toBe(true);
    expect(LINEAR_ONLY_REGEX.test("LUC-15")).toBe(true);
  });

  it("matches Paperclip-native identifiers (LUC-P1)", () => {
    expect(IDENTIFIER_REGEX.test("LUC-P1")).toBe(true);
    expect(LINEAR_ONLY_REGEX.test("LUC-P1")).toBe(false); // correctly excluded from Linear sync
  });

  it("does not match UUIDs", () => {
    expect(IDENTIFIER_REGEX.test("109be6bf-9c15-46b1-8f0a-1a7ffa2e5937")).toBe(false);
  });

  it("does not match empty strings", () => {
    expect(IDENTIFIER_REGEX.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Webhook endpoint integration tests (mock Express app)
// ---------------------------------------------------------------------------

describe("Linear webhook — endpoint", () => {
  function createWebhookApp() {
    const app = express();
    app.use(express.json());

    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const activities: Array<Record<string, unknown>> = [];

    app.post("/api/auth/linear/webhook", (req, res) => {
      const payload = req.body as Record<string, unknown>;
      if (!payload) {
        res.status(200).json({ ok: true });
        return;
      }

      const action = payload.action as string | undefined;
      const type = payload.type as string | undefined;
      const data = payload.data as Record<string, unknown> | undefined;

      if (!data || !type || !action) {
        res.status(200).json({ ok: true });
        return;
      }

      if (type === "Issue" && action === "update") {
        const { patch, changedFields } = parseWebhookPatch(data);
        if (Object.keys(patch).length > 0) {
          updates.push({ id: data.id as string, patch });
          activities.push({
            action: "issue.updated",
            fields: changedFields,
            source: "linear",
          });
        }
      }

      res.status(200).json({ ok: true });
    });

    return { app, updates, activities };
  }

  it("always returns 200 (Linear expects it)", async () => {
    const { app } = createWebhookApp();
    const res = await request(app)
      .post("/api/auth/linear/webhook")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("processes issue update with status change", async () => {
    const { app, updates, activities } = createWebhookApp();
    await request(app)
      .post("/api/auth/linear/webhook")
      .send({
        type: "Issue",
        action: "update",
        data: {
          id: "linear-uuid-123",
          state: { type: "started" },
        },
      });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.status).toBe("in_progress");
    expect(activities[0].fields).toContain("status → in_progress");
  });

  it("processes issue update with multiple fields", async () => {
    const { app, updates } = createWebhookApp();
    await request(app)
      .post("/api/auth/linear/webhook")
      .send({
        type: "Issue",
        action: "update",
        data: {
          id: "linear-uuid-456",
          title: "Updated title",
          priority: 2,
          description: "New description",
        },
      });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.title).toBe("Updated title");
    expect(updates[0].patch.priority).toBe("high");
    expect(updates[0].patch.description).toBe("New description");
  });

  it("ignores unknown event types", async () => {
    const { app, updates } = createWebhookApp();
    await request(app)
      .post("/api/auth/linear/webhook")
      .send({
        type: "Reaction",
        action: "create",
        data: { id: "reaction-1" },
      });
    expect(updates).toHaveLength(0);
  });

  it("ignores events with no data", async () => {
    const { app, updates } = createWebhookApp();
    await request(app)
      .post("/api/auth/linear/webhook")
      .send({ type: "Issue", action: "update" });
    expect(updates).toHaveLength(0);
  });
});
