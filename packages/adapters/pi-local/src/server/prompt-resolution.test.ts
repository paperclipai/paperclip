import { describe, expect, it } from "vitest";
import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "@paperclipai/adapter-utils/server-utils";
import {
  buildSystemPromptExtension,
  detectExplicitPromptTemplate,
  shouldRenderDefaultHeartbeatPrompt,
} from "./prompt-resolution.js";

describe("detectExplicitPromptTemplate", () => {
  it("returns null when undefined", () => {
    expect(detectExplicitPromptTemplate(undefined)).toBeNull();
  });

  it("returns null when not a string", () => {
    expect(detectExplicitPromptTemplate(42)).toBeNull();
    expect(detectExplicitPromptTemplate({})).toBeNull();
    expect(detectExplicitPromptTemplate(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectExplicitPromptTemplate("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(detectExplicitPromptTemplate("   \n\t  ")).toBeNull();
  });

  it("returns the value verbatim for non-empty strings", () => {
    expect(detectExplicitPromptTemplate("be brief")).toBe("be brief");
  });

  it("preserves leading/trailing whitespace when content is non-blank", () => {
    expect(detectExplicitPromptTemplate("  hi  ")).toBe("  hi  ");
  });
});

describe("buildSystemPromptExtension", () => {
  const AGENTS_MD = "Agent rules: be helpful.";
  const INSTRUCTIONS_PATH = "/repo/AGENTS.md";
  const INSTRUCTIONS_DIR = "/repo/";

  it("AGENTS.md loaded + no explicit template → AGENTS.md + path directive only (no DEFAULT_PAPERCLIP appended)", () => {
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: INSTRUCTIONS_PATH,
      instructionsFileDir: INSTRUCTIONS_DIR,
      instructionsContents: AGENTS_MD,
      instructionsReadFailed: false,
      explicitPromptTemplate: null,
    });
    expect(out).toContain(AGENTS_MD);
    expect(out).toContain("loaded from /repo/AGENTS.md");
    expect(out).not.toContain(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  });

  it("AGENTS.md loaded + explicit template → AGENTS.md + path directive + explicit template appended", () => {
    const explicit = "Always answer in haiku.";
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: INSTRUCTIONS_PATH,
      instructionsFileDir: INSTRUCTIONS_DIR,
      instructionsContents: AGENTS_MD,
      instructionsReadFailed: false,
      explicitPromptTemplate: explicit,
      fallbackPromptTemplate: explicit,
    });
    expect(out).toContain(AGENTS_MD);
    expect(out).toContain(explicit);
    expect(out).not.toContain(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  });

  it("AGENTS.md not configured → returns fallback template (today's behavior)", () => {
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: "",
      instructionsFileDir: "",
      instructionsContents: null,
      instructionsReadFailed: false,
      explicitPromptTemplate: null,
    });
    expect(out).toBe(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  });

  it("AGENTS.md read failed → returns fallback template (today's behavior)", () => {
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: INSTRUCTIONS_PATH,
      instructionsFileDir: INSTRUCTIONS_DIR,
      instructionsContents: null,
      instructionsReadFailed: true,
      explicitPromptTemplate: null,
    });
    expect(out).toBe(DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  });

  it("AGENTS.md not configured + explicit template → returns explicit template", () => {
    const explicit = "Custom system rules.";
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: "",
      instructionsFileDir: "",
      instructionsContents: null,
      instructionsReadFailed: false,
      explicitPromptTemplate: explicit,
    });
    expect(out).toBe(explicit);
  });

  it("AGENTS.md read failed + explicit template → still returns fallback (matches existing behavior on read failure)", () => {
    const explicit = "Custom system rules.";
    const out = buildSystemPromptExtension({
      resolvedInstructionsFilePath: INSTRUCTIONS_PATH,
      instructionsFileDir: INSTRUCTIONS_DIR,
      instructionsContents: null,
      instructionsReadFailed: true,
      explicitPromptTemplate: explicit,
      // fallback would be the explicit value when caller passes promptTemplate
      fallbackPromptTemplate: explicit,
    });
    expect(out).toBe(explicit);
  });
});

describe("shouldRenderDefaultHeartbeatPrompt", () => {
  it("AGENTS.md loaded + unset → suppresses heartbeat (false)", () => {
    expect(
      shouldRenderDefaultHeartbeatPrompt({
        resolvedInstructionsFilePath: "/repo/AGENTS.md",
        instructionsReadFailed: false,
        explicitPromptTemplate: null,
      }),
    ).toBe(false);
  });

  it("AGENTS.md loaded + explicit template → renders heartbeat (true)", () => {
    expect(
      shouldRenderDefaultHeartbeatPrompt({
        resolvedInstructionsFilePath: "/repo/AGENTS.md",
        instructionsReadFailed: false,
        explicitPromptTemplate: "custom",
      }),
    ).toBe(true);
  });

  it("AGENTS.md not configured → renders heartbeat (true) — regression for legacy agents", () => {
    expect(
      shouldRenderDefaultHeartbeatPrompt({
        resolvedInstructionsFilePath: "",
        instructionsReadFailed: false,
        explicitPromptTemplate: null,
      }),
    ).toBe(true);
  });

  it("AGENTS.md read failed → renders heartbeat (true) — regression on fallback path", () => {
    expect(
      shouldRenderDefaultHeartbeatPrompt({
        resolvedInstructionsFilePath: "/repo/AGENTS.md",
        instructionsReadFailed: true,
        explicitPromptTemplate: null,
      }),
    ).toBe(true);
  });

  it("treats whitespace-only template as 'unset' via detectExplicitPromptTemplate (regression)", () => {
    // Caller passes the result of detectExplicitPromptTemplate; whitespace is null.
    expect(detectExplicitPromptTemplate("   ")).toBeNull();
    expect(
      shouldRenderDefaultHeartbeatPrompt({
        resolvedInstructionsFilePath: "/repo/AGENTS.md",
        instructionsReadFailed: false,
        explicitPromptTemplate: detectExplicitPromptTemplate("   "),
      }),
    ).toBe(false);
  });
});
