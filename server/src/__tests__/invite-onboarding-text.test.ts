import os from "node:os";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Request } from "express";
import { buildInviteOnboardingTextDocument } from "../routes/access.js";

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
    expect(text).toContain("/api/invites/token-123/accept");
    expect(text).toContain("/api/join-requests/{requestId}/claim-api-key");
    expect(text).toContain("/api/invites/token-123/onboarding.txt");
    expect(text).toContain("/api/invites/token-123/skills/paperclip");
    expect(text).toContain("Suggested Paperclip base URLs to try");
    expect(text).toContain("http://localhost:3100");
    expect(text).toContain("host.docker.internal");
    expect(text).toContain("paperclipApiUrl");
    expect(text).toContain("adapterType \"openclaw_gateway\"");
    expect(text).toContain("headers.x-openclaw-token");
    expect(text).toContain("Do NOT use /v1/responses or /hooks/*");
    expect(text).toContain("set the first reachable candidate as agentDefaultsPayload.paperclipApiUrl");
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

  it("includes LAN candidates when the advertised host is tailnet-only", () => {
    const networkSpy = vi.spyOn(os, "networkInterfaces").mockReturnValue({
      en0: [
        {
          address: "fe80::1",
          family: "IPv6",
          internal: false,
          netmask: "ffff:ffff:ffff:ffff::",
          cidr: "fe80::1/64",
          mac: "00:00:00:00:00:00",
          scopeid: 1,
        },
        {
          address: "192.168.6.178",
          family: "IPv4",
          internal: false,
          netmask: "255.255.252.0",
          cidr: "192.168.6.178/22",
          mac: "00:00:00:00:00:00",
        },
      ],
      utun0: [
        {
          address: "203.0.113.42",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.255",
          cidr: "203.0.113.42/32",
          mac: "00:00:00:00:00:00",
        },
      ],
    });

    try {
      const req = buildReq("paperclip.example.test:3103");
      const invite = {
        id: "invite-4",
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

      const text = buildInviteOnboardingTextDocument(req, "token-999", invite as any, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "0.0.0.0",
        allowedHostnames: ["paperclip.example.test", "203.0.113.42"],
      });

      expect(text).toContain("http://192.168.6.178:3103");
      expect(text).not.toContain("http://[fe80::1]:3103");
    } finally {
      networkSpy.mockRestore();
    }
  });
});
