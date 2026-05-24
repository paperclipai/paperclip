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
  it("renders a plain-text onboarding doc with expected endpoint references", () => {
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

    expect(text).toContain("Paperclip OpenClaw Gateway Onboarding");
    expect(text).toContain("Automatic setup (preferred)");
    expect(text).toContain("onboarding.autoSetup");
    expect(text).toContain("curl -fsS -X POST");
    expect(text).toContain("board/admin approves that join request");
    expect(text).toContain("/api/invites/token-123/accept");
    expect(text).toContain("/api/join-requests/{requestId}/claim-api-key");
    expect(text).toContain("/api/invites/token-123/onboarding.txt");
    expect(text).toContain("Suggested Paperclip base URLs to try");
    expect(text).toContain("http://localhost:3100");
    expect(text).toContain("host.docker.internal");
    expect(text).toContain("paperclipApiUrl");
    expect(text).toContain("adapterType \"openclaw_gateway\"");
    expect(text).toContain("headers.x-openclaw-token");
    expect(text).toContain("Do NOT use /v1/responses or /hooks/*");
    expect(text).toContain("set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl");
    expect(text).toContain("~/.openclaw/workspace/paperclip-agent-keys/<agent-name>.json");
    expect(text).toContain("~/.openclaw/workspace/paperclip-claimed-api-key.json");
    expect(text).toContain("PAPERCLIP_API_KEY");
    expect(text).toContain("saved token field");
    expect(text).toContain("Gateway token unexpectedly short");
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

  it("includes machine-readable auto-setup metadata in the onboarding manifest", () => {
    const req = buildReq("localhost:3100");
    const invite = {
      id: "invite-auto",
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

    const manifest = buildInviteOnboardingManifest(req, "token-auto", invite as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(manifest.onboarding.autoSetup).toMatchObject({
      version: 1,
      registration: {
        method: "POST",
        path: "/api/invites/token-auto/accept",
      },
      claim: {
        method: "POST",
        pathTemplate: "/api/join-requests/{requestId}/claim-api-key",
        outputPaths: {
          perAgent: "~/.openclaw/workspace/paperclip-agent-keys/<agent-name>.json",
          legacy: "~/.openclaw/workspace/paperclip-claimed-api-key.json",
        },
      },
    });
    expect(manifest.onboarding.autoSetup.registration.bodyTemplate).toMatchObject({
      requestType: "agent",
      adapterType: "openclaw_gateway",
      agentDefaultsPayload: {
        url: "${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}",
        headers: {
          "x-openclaw-token":
            "${OPENCLAW_GATEWAY_TOKEN or ~/.openclaw/openclaw.json gateway.auth.token}",
        },
      },
    });
    expect(manifest.onboarding.autoSetup.singleCommand.command).toContain(
      "/api/invites/token-auto/accept",
    );
    expect(manifest.onboarding.autoSetup.singleCommand.command).toContain(
      ".openclaw/openclaw.json",
    );
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
});
