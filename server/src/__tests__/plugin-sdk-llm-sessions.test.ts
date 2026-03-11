/**
 * Tests for ctx.llm capability gating in the SDK test harness.
 *
 * Covers:
 * - All ctx.llm methods are blocked when the required capability is missing
 * - All ctx.llm methods succeed when the required capability is present
 * - Correct capability names are enforced for each method group
 *
 * @see PLUGIN_SPEC.md §15.x — LLM Sessions
 */

import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1, PluginCapability } from "@paperclipai/plugin-sdk";

function manifest(capabilities: PluginCapability[]): PaperclipPluginManifestV1 {
  return {
    id: "test.llm-sessions",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "LLM Sessions Test Plugin",
    description: "Used in llm sessions test suite",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "worker.js" },
  };
}

describe("ctx.llm capability gating", () => {
  describe("providers.list", () => {
    it("blocks without llm.providers.list", async () => {
      const h = createTestHarness({ manifest: manifest([]) });
      await expect(h.ctx.llm.providers.list()).rejects.toThrow(
        /missing required capability.*llm\.providers\.list/i,
      );
    });

    it("allows with llm.providers.list", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.providers.list"]) });
      await expect(h.ctx.llm.providers.list()).resolves.toEqual([]);
    });
  });

  describe("providers.models.list", () => {
    it("blocks without llm.providers.list", async () => {
      const h = createTestHarness({ manifest: manifest([]) });
      await expect(h.ctx.llm.providers.models.list("claude_local")).rejects.toThrow(
        /missing required capability.*llm\.providers\.list/i,
      );
    });

    it("allows with llm.providers.list", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.providers.list"]) });
      await expect(h.ctx.llm.providers.models.list("claude_local")).resolves.toEqual([]);
    });
  });

  describe("sessions.create", () => {
    it("blocks without llm.sessions.create", async () => {
      const h = createTestHarness({ manifest: manifest([]) });
      await expect(
        h.ctx.llm.sessions.create({
          companyId: "c1",
          adapterType: "claude_local",
          model: "claude-opus-4-6",
        }),
      ).rejects.toThrow(/missing required capability.*llm\.sessions\.create/i);
    });

    it("allows with llm.sessions.create and returns session object", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.sessions.create"]) });
      const session = await h.ctx.llm.sessions.create({
        companyId: "c1",
        adapterType: "claude_local",
        model: "claude-opus-4-6",
        systemPrompt: "You are helpful.",
      });
      expect(session.companyId).toBe("c1");
      expect(session.adapterType).toBe("claude_local");
      expect(session.model).toBe("claude-opus-4-6");
      expect(session.status).toBe("active");
      expect(typeof session.sessionId).toBe("string");
      expect(typeof session.createdAt).toBe("string");
    });
  });

  describe("sessions.resume", () => {
    it("blocks without llm.sessions.create", async () => {
      const h = createTestHarness({ manifest: manifest([]) });
      await expect(
        h.ctx.llm.sessions.resume("session-1", "c1"),
      ).rejects.toThrow(/missing required capability.*llm\.sessions\.create/i);
    });

    it("allows with llm.sessions.create", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.sessions.create"]) });
      // Test harness stub returns a session with the provided IDs
      const session = await h.ctx.llm.sessions.resume("session-1", "c1");
      expect(session.sessionId).toBe("session-1");
      expect(session.companyId).toBe("c1");
      expect(session.status).toBe("active");
    });
  });

  describe("sessions.send", () => {
    it("blocks without llm.sessions.send", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.sessions.create"]) });
      await expect(
        h.ctx.llm.sessions.send("session-1", "c1", { message: "Hello" }),
      ).rejects.toThrow(/missing required capability.*llm\.sessions\.send/i);
    });

    it("allows with llm.sessions.send and returns content", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.sessions.send"]) });
      const result = await h.ctx.llm.sessions.send("session-1", "c1", {
        message: "Hello",
      });
      expect(result).toHaveProperty("content");
      expect(typeof result.content).toBe("string");
    });
  });

  describe("sessions.close", () => {
    it("blocks without llm.sessions.close", async () => {
      const h = createTestHarness({ manifest: manifest([]) });
      await expect(
        h.ctx.llm.sessions.close("session-1", "c1"),
      ).rejects.toThrow(/missing required capability.*llm\.sessions\.close/i);
    });

    it("allows with llm.sessions.close", async () => {
      const h = createTestHarness({ manifest: manifest(["llm.sessions.close"]) });
      await expect(h.ctx.llm.sessions.close("session-1", "c1")).resolves.toBeUndefined();
    });
  });
});
