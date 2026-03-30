import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  buildInviteOnboardingManifest,
  buildInviteOnboardingTextDocument,
} from "../routes/access.js";

function buildReq(host: string): Request {
  return {
    protocol: "http",
    header(name: string) {
      if (name.toLowerCase() === "host") return host;
      return undefined;
    },
  } as unknown as Request;
}

describe("buildInviteOnboardingTextDocument", () => {
  it("renders a generic remote-agent onboarding doc by default", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(req, "token-123", invite as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(text).toContain("Paperclip Remote Agent Onboarding");
    expect(text).toContain("/api/invites/token-123/accept");
    expect(text).toContain("/api/join-requests/{requestId}/claim-api-key");
    expect(text).toContain("/api/invites/token-123/onboarding.txt");
    expect(text).toContain("Suggested Paperclip base URLs to try");
    expect(text).toContain("http://localhost:3100");
    expect(text).toContain("host.docker.internal");
    expect(text).toContain("adapterType \"http\"");
    expect(text).toContain("Remote HTTP agents should gather");
    expect(text).toContain("timeoutMs");
    expect(text).toContain("Use the first reachable candidate for invite, claim, and skill bootstrap calls");
    expect(text).toContain("~/paperclip/paperclip-claimed-api-key.json");
    expect(text).toContain("PAPERCLIP_API_KEY");
    expect(text).not.toContain("headers.x-openclaw-token");
    expect(text).not.toContain("Gateway token unexpectedly short");
  });

  it("includes loopback diagnostics for authenticated/private onboarding", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-2",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "both",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(req, "token-456", invite as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(text).toContain("Connectivity diagnostics");
    expect(text).toContain("loopback hostname");
    expect(text).toContain("If none are reachable");
  });

  it("includes inviter message in the onboarding text when provided", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-3",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: {
        agentMessage: "Please join as our QA lead and prioritize flaky test triage first.",
      },
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(req, "token-789", invite as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(text).toContain("Message from inviter");
    expect(text).toContain("prioritize flaky test triage first");
  });

  it("keeps the legacy OpenClaw onboarding text when invite metadata requests it", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-4",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: {
        onboardingTemplate: "openclaw_gateway",
        recommendedAdapterType: "openclaw_gateway",
      },
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const text = buildInviteOnboardingTextDocument(req, "token-openclaw", invite as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(text).toContain("Paperclip OpenClaw Gateway Onboarding");
    expect(text).toContain("adapterType \"openclaw_gateway\"");
    expect(text).toContain("headers.x-openclaw-token");
    expect(text).toContain("~/.openclaw/workspace/paperclip-claimed-api-key.json");
  });
});

describe("buildInviteOnboardingManifest", () => {
  it("defaults invite onboarding manifests to generic remote-agent guidance", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-manifest-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date("2026-03-05T00:00:00.000Z"),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      updatedAt: new Date("2026-03-04T00:00:00.000Z"),
    } as const;

    const manifest = buildInviteOnboardingManifest(req, "token-manifest", invite as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(manifest.onboarding.template).toBe("remote_agent");
    expect(manifest.onboarding.recommendedAdapterType).toBe("http");
    expect(manifest.onboarding.instructions).toContain("generic remote HTTP endpoints");
    expect(manifest.onboarding.requiredFields.adapterType).toContain("generic remote HTTP or webhook endpoints");
    expect(manifest.onboarding.skill.installPath).toContain("$CODEX_HOME/skills/paperclip/SKILL.md");
  });
});
