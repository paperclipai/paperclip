import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectHermesRuntimeModelDefaults,
  ensureHermesRuntimeIdentity,
  deriveHermesProfileSlug,
} from "../adapters/hermes-runtime-identity.js";

describe("Hermes runtime identity", () => {
  it("derives a safe stable profile slug", () => {
    expect(deriveHermesProfileSlug({
      companyName: "Acme, Inc.",
      agentName: "Head of Sales",
      existingSlug: null,
    })).toBe("acme-inc-head-of-sales");
  });

  it("reuses an existing managed profile slug", () => {
    expect(deriveHermesProfileSlug({
      companyName: "Renamed Company",
      agentName: "Renamed Agent",
      existingSlug: "acme-inc-head-of-sales",
    })).toBe("acme-inc-head-of-sales");
  });

  it("adds a stable hash suffix when names exceed the slug length limit", () => {
    const slug = deriveHermesProfileSlug({
      companyName: "A Very Long Company Name ".repeat(8),
      agentName: "A Very Long Agent Name ".repeat(8),
      existingSlug: null,
    });

    expect(slug.length).toBeLessThanOrEqual(96);
    expect(slug).toMatch(/-[a-f0-9]{8}$/);
  });

  it("creates a profile home and patches adapter env plus metadata", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));
    const result = await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: { env: { EXISTING: "1" } },
      metadata: null,
      instanceRoot,
      now: "2026-05-18T00:00:00.000Z",
    });

    const identity = result.metadata?.runtimeIdentity as Record<string, unknown>;
    expect(identity.profileSlug).toBe("acme-reviewer");
    expect(identity.adapter).toBe("hermes_local");
    expect(result.adapterConfig.env).toMatchObject({
      EXISTING: "1",
      HERMES_HOME: path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer"),
    });
    await expect(stat(path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer"))).resolves.toBeTruthy();
    await expect(readFile(path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer", "config.yaml"), "utf8"))
      .resolves.toContain("dashboard:");
  });

  it("seeds a new profile from base Hermes model config without copying env secrets", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));
    const baseHermesHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-base-"));
    await writeFile(
      path.join(baseHermesHome, "config.yaml"),
      [
        "model:",
        "  provider: openrouter",
        "  default: anthropic/claude-sonnet-4",
        "",
        "dashboard:",
        "  show_token_analytics: false",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(baseHermesHome, ".env"), "ANTHROPIC_API_KEY=secret\n");

    await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: null,
      instanceRoot,
      baseHermesHome,
      env: {},
      now: "2026-05-18T00:00:00.000Z",
    });

    const profileHome = path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer");
    await expect(readFile(path.join(profileHome, "config.yaml"), "utf8")).resolves.toBe([
      "model:",
      "  provider: \"openrouter\"",
      "  default: \"anthropic/claude-sonnet-4\"",
      "",
      "dashboard:",
      "  show_token_analytics: true",
      "",
    ].join("\n"));
    await expect(stat(path.join(profileHome, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("parses quoted Hermes config defaults without treating # as a comment", async () => {
    const baseHermesHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-base-"));
    const configPath = path.join(baseHermesHome, "config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: \"openrouter:chat\" # real comment",
        "  default: \"anthropic/claude-sonnet-4 # primary\"",
        "",
      ].join("\n"),
    );

    await expect(detectHermesRuntimeModelDefaults({
      baseHermesHome,
      env: {},
    })).resolves.toEqual({
      model: "anthropic/claude-sonnet-4 # primary",
      provider: "openrouter:chat",
      source: configPath,
    });
  });

  it("seeds a new profile from Hermes model environment defaults", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));

    await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: null,
      instanceRoot,
      env: {
        HERMES_MODEL: "openai/gpt-5.2",
        HERMES_PROVIDER: "openai",
      },
      now: "2026-05-18T00:00:00.000Z",
    });

    await expect(
      readFile(
        path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer", "config.yaml"),
        "utf8",
      ),
    ).resolves.toBe([
      "model:",
      "  provider: \"openai\"",
      "  default: \"openai/gpt-5.2\"",
      "",
      "dashboard:",
      "  show_token_analytics: true",
      "",
    ].join("\n"));
  });

  it("quotes generated YAML model defaults", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));

    await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: null,
      instanceRoot,
      env: {
        HERMES_MODEL: "openai/gpt-5.2 # primary",
        HERMES_PROVIDER: "openai:compatible",
      },
      now: "2026-05-18T00:00:00.000Z",
    });

    await expect(
      readFile(
        path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer", "config.yaml"),
        "utf8",
      ),
    ).resolves.toContain([
      "model:",
      "  provider: \"openai:compatible\"",
      "  default: \"openai/gpt-5.2 # primary\"",
    ].join("\n"));
  });

  it("treats malformed adapter env as empty before patching Hermes home", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));
    const result = await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: { env: "not-an-object" },
      metadata: null,
      instanceRoot,
      now: "2026-05-18T00:00:00.000Z",
    });

    expect(result.adapterConfig.env).toEqual({
      HERMES_HOME: path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer"),
    });
  });

  it("is idempotent across repeated identity reconciliation", async () => {
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-profile-"));
    const first = await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Acme",
      agentId: "agent-1",
      agentName: "Reviewer",
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: null,
      instanceRoot,
      now: "2026-05-18T00:00:00.000Z",
    });
    const configPath = path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer", "config.yaml");
    await writeFile(configPath, "custom: true\n");

    const second = await ensureHermesRuntimeIdentity({
      companyId: "company-1",
      companyName: "Renamed Acme",
      agentId: "agent-1",
      agentName: "Renamed Reviewer",
      adapterType: "hermes_local",
      adapterConfig: first.adapterConfig,
      metadata: first.metadata,
      instanceRoot,
      now: "2026-05-19T00:00:00.000Z",
    });

    expect(second.metadata?.runtimeIdentity).toMatchObject({
      profileSlug: "acme-reviewer",
      hermesHome: path.join(instanceRoot, "runtimes", "hermes", "profiles", "acme-reviewer"),
      createdAt: "2026-05-18T00:00:00.000Z",
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe("custom: true\n");
  });
});
