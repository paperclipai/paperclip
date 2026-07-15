import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentFirstHeartbeat,
  trackAgentTaskCompleted,
  trackInteractionResolved,
  trackInstallCompleted,
  trackSkillCreated,
  trackSkillForked,
  trackSkillShareLinkCopied,
  trackSkillTestRun,
  trackSkillVersionSaved,
} from "@paperclipai/shared/telemetry";
import type { EventDimensionsMap, TelemetryClient } from "@paperclipai/shared/telemetry";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
  } as unknown as TelemetryClient;
}

function runtimeValue<T>(value: string): T {
  return value as T;
}

type MockedTrack = ReturnType<typeof vi.fn>;

const FORBIDDEN_TELEMETRY_KEYS = new Set([
  "agentConfigSnapshot",
  "agent_config_snapshot",
  "categories",
  "content",
  "error",
  "file_content",
  "file_path",
  "fork_from_slug",
  "fork_from_name",
  "harnessIssueDescription",
  "harness_issue_description",
  "href",
  "inputSnapshot",
  "input_snapshot",
  "name",
  "outputSnapshot",
  "output_snapshot",
  "path",
  "publicShareToken",
  "public_share_token",
  "share_token",
  "slug",
  "sourceLocator",
  "sourceRef",
  "source_locator",
  "source_ref",
  "tagline",
  "templateBody",
  "templateName",
  "template_body",
  "template_name",
  "token",
  "url",
]);

const FORBIDDEN_TELEMETRY_VALUES = new Set([
  "Secret Skill",
  "secret-skill",
  "keep this private",
  "https://paperclip.example/skills/secret-skill?token=secret-token",
  "secret-token",
  "do not leak input",
  "do not leak output",
  "private harness issue",
  "private template body",
]);

function lastTrackCall(client: TelemetryClient): [string, Record<string, unknown>] {
  const calls = ((client.track as unknown as MockedTrack).mock.calls ?? []) as [string, Record<string, unknown>][];
  const call = calls.at(-1);
  expect(call).toBeDefined();
  return call!;
}

function expectPrimitiveDimensions(payload: Record<string, unknown>): void {
  for (const value of Object.values(payload)) {
    expect(["string", "number", "boolean"]).toContain(typeof value);
  }
}

function expectNoForbiddenTelemetryMaterial(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    expect(FORBIDDEN_TELEMETRY_KEYS.has(key)).toBe(false);
  }
  for (const value of Object.values(payload)) {
    if (typeof value === "string") {
      expect(FORBIDDEN_TELEMETRY_VALUES.has(value)).toBe(false);
    }
  }
}

describe("shared telemetry agent events", () => {
  it("includes agent_id for agent.created", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentRole: "engineer",
      agentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "engineer",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("passes an unrecognized agent role through for backend normalization", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentRole: runtimeValue<EventDimensionsMap["agent.created"]["agent_role"]>("coder"),
      agentId: "44444444-4444-4444-8444-444444444444",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_role: "coder",
      agent_id: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("includes agent_id for agent.first_heartbeat", () => {
    const client = createClient();

    trackAgentFirstHeartbeat(client, {
      agentRole: "engineer",
      agentId: "22222222-2222-4222-8222-222222222222",
    });

    expect(client.track).toHaveBeenCalledWith("agent.first_heartbeat", {
      agent_role: "engineer",
      agent_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("includes agent_id for agent.task_completed", () => {
    const client = createClient();

    trackAgentTaskCompleted(client, {
      agentRole: "qa",
      agentId: "33333333-3333-4333-8333-333333333333",
      adapterType: "codex_local",
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_role: "qa",
      agent_id: "33333333-3333-4333-8333-333333333333",
      adapter_type: "codex_local",
    });
  });

  it("keeps non-agent event dimensions unchanged", () => {
    const client = createClient();

    trackInstallCompleted(client, { adapterType: "codex_local" });

    expect(client.track).toHaveBeenCalledWith("install.completed", {
      adapter_type: "codex_local",
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "install.completed",
      expect.objectContaining({ agent_id: expect.any(String) }),
    );
  });

  it("passes interaction.resolved enum dimensions through for backend normalization", () => {
    const client = createClient();

    trackInteractionResolved(client, {
      interactionKind: runtimeValue<EventDimensionsMap["interaction.resolved"]["interaction_kind"]>(
        "single_confirmation",
      ),
      status: "accepted",
      resolvedByKind: runtimeValue<EventDimensionsMap["interaction.resolved"]["resolved_by_kind"]>("operator"),
      resolutionReason: "accepted",
      createdByKind: "agent",
      creatorAgentRole: runtimeValue<EventDimensionsMap["interaction.resolved"]["creator_agent_role"]>("coder"),
      continuationPolicy: runtimeValue<EventDimensionsMap["interaction.resolved"]["continuation_policy"]>(
        "wake_everyone",
      ),
      targetType: "issue_document",
      optionCount: 2,
      selectedOptionCount: 1,
      skippedTaskCount: 3,
    });

    expect(client.track).toHaveBeenCalledWith("interaction.resolved", {
      interaction_kind: "single_confirmation",
      status: "accepted",
      resolved_by_kind: "operator",
      resolution_reason: "accepted",
      created_by_kind: "agent",
      creator_agent_role: "coder",
      continuation_policy: "wake_everyone",
      target_type: "issue_document",
      option_count: 2,
      selected_option_count: 1,
      skipped_task_count: 3,
    });
  });
});

describe("shared Skill telemetry proposals", () => {
  it("emits primitive skill.created dimensions and omits user-authored identity", () => {
    const client = createClient();
    const dims = {
      skill_id: "11111111-1111-4111-8111-111111111111",
      creation_source: "blank",
      sharing_scope: "company",
      category_count: 2,
      file_count: 3,
      name: "Secret Skill",
      slug: "secret-skill",
      tagline: "keep this private",
      categories: ["customer-name"],
    } as Parameters<typeof trackSkillCreated>[1] & Record<string, unknown>;

    trackSkillCreated(client, dims);

    const [eventName, payload] = lastTrackCall(client);
    expect(eventName).toBe("skill.created");
    expect(payload).toEqual({
      skill_id: "11111111-1111-4111-8111-111111111111",
      creation_source: "blank",
      sharing_scope: "company",
      category_count: 2,
      file_count: 3,
    });
    expectPrimitiveDimensions(payload);
    expectNoForbiddenTelemetryMaterial(payload);
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
  });

  it("emits primitive skill.version_saved dimensions without file path or content", () => {
    const client = createClient();
    const dims = {
      skill_id: "22222222-2222-4222-8222-222222222222",
      revision_number: 4,
      file_type: "markdown",
      file_path: "customers/acme/SKILL.md",
      file_content: "keep this private",
      path: "customers/acme/SKILL.md",
      content: "keep this private",
      name: "Secret Skill",
    } as Parameters<typeof trackSkillVersionSaved>[1] & Record<string, unknown>;

    trackSkillVersionSaved(client, dims);

    const [eventName, payload] = lastTrackCall(client);
    expect(eventName).toBe("skill.version_saved");
    expect(payload).toEqual({
      skill_id: "22222222-2222-4222-8222-222222222222",
      revision_number: 4,
      file_type: "markdown",
    });
    expectPrimitiveDimensions(payload);
    expectNoForbiddenTelemetryMaterial(payload);
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
  });

  it("emits primitive skill.test_run dimensions without snapshots, prompts, or errors", () => {
    const client = createClient();
    const dims = {
      skill_id: "33333333-3333-4333-8333-333333333333",
      status: "queued",
      run_source: "run",
      ad_hoc: true,
      template_used: false,
      inputSnapshot: "do not leak input",
      outputSnapshot: "do not leak output",
      harnessIssueDescription: "private harness issue",
      agentConfigSnapshot: "keep this private",
      error: "keep this private",
      templateName: "Secret template",
      templateBody: "private template body",
    } as Parameters<typeof trackSkillTestRun>[1] & Record<string, unknown>;

    trackSkillTestRun(client, dims);

    const [eventName, payload] = lastTrackCall(client);
    expect(eventName).toBe("skill.test_run");
    expect(payload).toEqual({
      skill_id: "33333333-3333-4333-8333-333333333333",
      status: "queued",
      run_source: "run",
      ad_hoc: true,
      template_used: false,
    });
    expectPrimitiveDimensions(payload);
    expectNoForbiddenTelemetryMaterial(payload);
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
  });

  it("emits primitive skill.forked dimensions and passes opaque IDs through raw", () => {
    const client = createClient();
    const dims = {
      skill_id: "44444444-4444-4444-8444-444444444444",
      fork_from_skill_id: "55555555-5555-4555-8555-555555555555",
      source_type: "github",
      sharing_scope: "private",
      reassign_agent_count: 1,
      name: "Secret Skill",
      slug: "secret-skill",
      fork_from_name: "Secret Source",
      fork_from_slug: "secret-source",
    } as Parameters<typeof trackSkillForked>[1] & Record<string, unknown>;

    trackSkillForked(client, dims);

    const [eventName, payload] = lastTrackCall(client);
    expect(eventName).toBe("skill.forked");
    expect(payload).toEqual({
      skill_id: "44444444-4444-4444-8444-444444444444",
      fork_from_skill_id: "55555555-5555-4555-8555-555555555555",
      source_type: "github",
      sharing_scope: "private",
      reassign_agent_count: 1,
    });
    expectPrimitiveDimensions(payload);
    expectNoForbiddenTelemetryMaterial(payload);
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
  });

  it("emits only sharing_scope for the deliberately rejectable share-link proposal", () => {
    const client = createClient();
    const dims = {
      sharing_scope: "public_link",
      skill_id: "66666666-6666-4666-8666-666666666666",
      href: "https://paperclip.example/skills/secret-skill?token=secret-token",
      url: "https://paperclip.example/skills/secret-skill?token=secret-token",
      public_share_token: "secret-token",
      token: "secret-token",
    } as Parameters<typeof trackSkillShareLinkCopied>[1] & Record<string, unknown>;

    trackSkillShareLinkCopied(client, dims);

    const [eventName, payload] = lastTrackCall(client);
    expect(eventName).toBe("skill.share_link");
    expect(payload).toEqual({ sharing_scope: "public_link" });
    expect(Object.keys(payload)).toEqual(["sharing_scope"]);
    expectPrimitiveDimensions(payload);
    expectNoForbiddenTelemetryMaterial(payload);
    expect(client.hashPrivateRef).not.toHaveBeenCalled();
  });
});
