import { describe, test, expect } from "bun:test";
import { classifyMessage, type MessageIntent } from "../src/message-classifier.js";

describe("message classifier", () => {
  describe("content capture signals", () => {
    test("explicit capture intent → content_capture", () => {
      const r = classifyMessage("capture this to the vault inbox");
      expect(r.intent).toBe("content_capture");
    });

    test("save-to-inbox phrasing → content_capture", () => {
      const r = classifyMessage("add this article to the inbox for later");
      expect(r.intent).toBe("content_capture");
    });

    test("capture phrasing with follow-on task stays task", () => {
      const r = classifyMessage("capture this article and summarize it");
      expect(r.intent).toBe("task");
    });
  });

  // --- Conversational cases ---

  describe("conversational signals", () => {
    test("greetings → conversational", () => {
      for (const text of ["hi", "hey", "hello", "yo", "sup", "morning"]) {
        const r = classifyMessage(text);
        expect(r.intent).toBe("conversational");
        expect(r.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    test("acknowledgments → conversational", () => {
      for (const text of ["thanks", "thx", "ok", "okay", "got it", "sounds good", "cool", "nice"]) {
        const r = classifyMessage(text);
        expect(r.intent).toBe("conversational");
      }
    });

    test("yes/no → conversational", () => {
      for (const text of ["yes", "no", "yep", "nope", "yeah", "nah", "sure"]) {
        const r = classifyMessage(text);
        expect(r.intent).toBe("conversational");
      }
    });

    test("very short non-question → conversational", () => {
      const r = classifyMessage("done");
      expect(r.intent).toBe("conversational");
    });

    test("time/date question → conversational", () => {
      const r = classifyMessage("what time is it?");
      expect(r.intent).toBe("conversational");
    });

    test("status check → conversational", () => {
      const r = classifyMessage("you there?");
      expect(r.intent).toBe("conversational");
    });

    test("chitchat → conversational", () => {
      const r = classifyMessage("how's it going?");
      expect(r.intent).toBe("conversational");
    });

    test("empty message → conversational", () => {
      const r = classifyMessage("");
      expect(r.intent).toBe("conversational");
      expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    });
  });

  // --- Task cases ---

  describe("task signals", () => {
    test("refactor → task", () => {
      const r = classifyMessage("refactor the auth module");
      expect(r.intent).toBe("task");
    });

    test("implement → task", () => {
      const r = classifyMessage("implement user registration flow");
      expect(r.intent).toBe("task");
    });

    test("debug → task", () => {
      const r = classifyMessage("debug the payment gateway timeout");
      expect(r.intent).toBe("task");
    });

    test("investigate → task", () => {
      const r = classifyMessage("investigate the memory leak in worker-process");
      expect(r.intent).toBe("task");
    });

    test("code file reference → task", () => {
      const r = classifyMessage("check v2/paperclip-shim.ts for the bug");
      expect(r.intent).toBe("task");
    });

    test("multi-step language → task", () => {
      const r = classifyMessage("create the API endpoint and then also update the frontend");
      expect(r.intent).toBe("task");
    });

    test("delegation language → task", () => {
      const r = classifyMessage("ask Q to look at the HubSpot integration");
      expect(r.intent).toBe("task");
    });

    test("long message (>200 chars) → task", () => {
      const r = classifyMessage("x".repeat(201));
      expect(r.intent).toBe("task");
      expect(r.reason).toContain("long message");
    });
  });

  // --- Ephemeral cases (needs tools, not board clutter) ---

  describe("ephemeral signals", () => {
    test("question about emails → ephemeral", () => {
      const r = classifyMessage("do I have any unread emails?");
      expect(r.intent).toBe("ephemeral");
    });

    test("question about calendar → ephemeral", () => {
      const r = classifyMessage("what's on my calendar today?");
      expect(r.intent).toBe("ephemeral");
    });

    test("question about github → ephemeral", () => {
      const r = classifyMessage("any new PRs on the repo?");
      expect(r.intent).toBe("ephemeral");
    });

    test("imperative with tool need → ephemeral", () => {
      const r = classifyMessage("check my inbox for anything from Blake");
      expect(r.intent).toBe("ephemeral");
    });

    test("generic question needing context → ephemeral", () => {
      const r = classifyMessage("what's the latest on the Alpaca migration and our hubspot deal pipeline?");
      expect(r.intent).toBe("ephemeral");
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    test("undefined text → conversational", () => {
      const r = classifyMessage(undefined);
      expect(r.intent).toBe("conversational");
    });

    test("whitespace-only → conversational", () => {
      const r = classifyMessage("   ");
      expect(r.intent).toBe("conversational");
    });

    test("task verb overrides short length", () => {
      const r = classifyMessage("fix the bug");
      expect(r.intent).toBe("task");
    });

    test("short question without tool signals → conversational", () => {
      const r = classifyMessage("why is the sky blue?");
      expect(r.intent).toBe("conversational");
    });

    test("unclassified ambiguous → task (safe default)", () => {
      // Something that doesn't match any pattern
      const r = classifyMessage("the thing about the stuff with the other thing needs attention");
      expect(r.intent).toBe("task");
      expect(r.confidence).toBeLessThan(0.5);
    });
  });
});

describe("local LLM shortcut", () => {
  test("answerConversational returns response from LM Studio", async () => {
    // 30s timeout because LM Studio can be slow on first inference
    const { answerConversational } = await import("../src/local-llm.js");
    const result = await answerConversational("What time is it?", {
      baseUrl: "http://localhost:1234",
      model: "qwen/qwen3-14b",
      maxTokens: 100,
      timeoutMs: 30_000,
    });
    // If LM Studio is running, we get a real response.
    // If not, we get a fallback signal. Both are valid test outcomes.
    if (result.ok) {
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.model).toBeTruthy();
    } else {
      expect((result as any).fallbackToIssue).toBe(true);
    }
  }, 30_000);

  test("isLmStudioAvailable detects local server", async () => {
    const { isLmStudioAvailable } = await import("../src/local-llm.js");
    const available = await isLmStudioAvailable();
    // This test just verifies the function runs without error.
    // Actual result depends on whether LM Studio is running.
    expect(typeof available).toBe("boolean");
  });
});
