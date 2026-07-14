import { describe, expect, it } from "vitest";
import {
  REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
  redactEnvironmentCustomImageSetupSession,
  redactEnvironmentCustomImageTemplate,
} from "./environment-custom-images.js";
import {
  environmentCustomImageSetupConnectionSummarySchema,
  environmentCustomImageSetupSessionSchema,
  environmentCustomImageTemplateSchema,
  startEnvironmentCustomImageSetupSessionSchema,
} from "./validators/environment-custom-images.js";

const environmentId = "22222222-2222-4222-8222-222222222222";
const templateId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";

describe("environment customImage validators", () => {
  it("requires environment scope on templates and setup sessions", () => {
    const template = environmentCustomImageTemplateSchema.parse({
      id: templateId,
      environmentId,
      provider: "daytona",
      templateKind: "snapshot",
      templateRef: "snapshot-ref",
      sourceTemplateRef: null,
      sourceEnvironmentConfigFingerprint: "sha256:abc",
      status: "active",
      createdByUserId: "user-1",
      createdByAgentId: null,
      capturedAt: "2026-06-25T12:00:00.000Z",
      lastUsedAt: null,
      supersededByTemplateId: null,
      metadata: { adapterType: "codex_local" },
      createdAt: "2026-06-25T12:00:00.000Z",
      updatedAt: "2026-06-25T12:00:00.000Z",
    });

    expect(template.environmentId).toBe(environmentId);

    const session = environmentCustomImageSetupSessionSchema.parse({
      id: sessionId,
      environmentId,
      templateId,
      promotedTemplateId: null,
      provider: "daytona",
      providerLeaseId: "lease-1",
      environmentLeaseId: null,
      status: "waiting_for_user",
      startedByUserId: "user-1",
      startedByAgentId: null,
      baseTemplateRef: "snapshot-ref",
      expiresAt: "2026-06-25T13:00:00.000Z",
      finishedAt: null,
      failureReason: null,
      connectionSummary: {
        type: "ssh",
        username: "sandbox",
        hostRedacted: true,
        portRedacted: true,
      },
      connectionSecretRef: "secret-ref",
      metadata: null,
      createdAt: "2026-06-25T12:00:00.000Z",
      updatedAt: "2026-06-25T12:00:00.000Z",
    });

    expect(session.environmentId).toBe(environmentId);
  });

  it("validates setup-session requests and redacted connection summaries", () => {
    expect(startEnvironmentCustomImageSetupSessionSchema.parse({ templateId })).toEqual({ templateId });
    expect(() => startEnvironmentCustomImageSetupSessionSchema.parse({ ttlSeconds: 30 })).toThrow();

    expect(
      environmentCustomImageSetupConnectionSummarySchema.parse({
        type: "ssh",
        username: "sandbox",
      }),
    ).toMatchObject({
      type: "ssh",
      username: "sandbox",
      hostRedacted: true,
      portRedacted: true,
    });

    expect(() => environmentCustomImageSetupConnectionSummarySchema.parse({
      type: "ssh",
      hostRedacted: false,
    })).toThrow();
  });
});

describe("environment customImage redaction", () => {
  it("redacts template refs and secret-like provider metadata", () => {
    const redacted = redactEnvironmentCustomImageTemplate({
      templateRef: "daytona-snapshot-secret-ref",
      sourceTemplateRef: "base-image-secret-ref",
      metadata: {
        safeLabel: "codex template",
        apiToken: "token-value",
        userMetadata: {
          safe: "kept",
        },
        nested: {
          host: "203.0.113.10",
          safe: "kept",
        },
      },
    });

    expect(redacted.templateRef).toBe(REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE);
    expect(redacted.sourceTemplateRef).toBe(REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE);
    expect(redacted.metadata).toEqual({
      safeLabel: "codex template",
      apiToken: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
      userMetadata: {
        safe: "kept",
      },
      nested: {
        host: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
        safe: "kept",
      },
    });
  });

  it("redacts setup lease and connection material while preserving redaction flags", () => {
    const redacted = redactEnvironmentCustomImageSetupSession({
      providerLeaseId: "lease-secret",
      baseTemplateRef: "snapshot-secret",
      connectionSecretRef: "secret-ref",
      connectionSummary: {
        type: "ssh",
        username: "sandbox",
        hostRedacted: true,
        portRedacted: true,
        instructions: "ssh sandbox@203.0.113.10",
      },
      metadata: {
        connectUrl: "https://internal.example.test/session",
      },
    });

    expect(redacted.providerLeaseId).toBe(REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE);
    expect(redacted.baseTemplateRef).toBe(REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE);
    expect(redacted.connectionSecretRef).toBe(REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE);
    expect(redacted.connectionSummary).toEqual({
      type: "ssh",
      username: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
      hostRedacted: true,
      portRedacted: true,
      instructions: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    });
    expect(redacted.metadata).toEqual({
      connectUrl: REDACTED_ENVIRONMENT_CUSTOM_IMAGE_VALUE,
    });
  });
});
