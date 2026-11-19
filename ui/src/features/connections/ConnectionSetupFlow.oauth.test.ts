// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ToolApplication, ToolConnection } from "@paperclipai/shared";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import {
  isConnectionDefinitionUnavailable,
  isVercelConnectUnavailable,
  isMissingOAuthStateMessage,
  oauthFailureMessage,
  readConnectionIntentGitHubRecovery,
  readConnectionIntentOAuthFailureCode,
  readConnectionIntentOAuthOutcome,
  retainedResumeMatches,
  retainedReconnectMatches,
  requestedConnectionSetupResolution,
  requestedConnectionEntry,
} from "./ConnectionSetupFlow";

const origin = "https://paperclip.test";
const interactionId = "interaction-123";

function event(data: unknown, eventOrigin = origin) {
  return { origin: eventOrigin, data };
}

describe("connection intent OAuth window messages", () => {
  it.each(["connected", "declined", "failed"] as const)(
    "accepts a matching %s outcome",
    (outcome) => {
      expect(
        readConnectionIntentOAuthOutcome(
          event({
            type: "paperclip.connection-intent.oauth",
            interactionId,
            outcome,
          }),
          origin,
          interactionId,
        ),
      ).toBe(outcome);
    },
  );

  it.each([
    [
      "foreign origin",
      event(
        {
          type: "paperclip.connection-intent.oauth",
          interactionId,
          outcome: "connected",
        },
        "https://attacker.test",
      ),
    ],
    [
      "wrong interaction",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId: "other",
        outcome: "connected",
      }),
    ],
    [
      "wrong message type",
      event({ type: "other", interactionId, outcome: "connected" }),
    ],
    [
      "unknown outcome",
      event({
        type: "paperclip.connection-intent.oauth",
        interactionId,
        outcome: "authorized",
      }),
    ],
    ["non-object payload", event("connected")],
  ])("ignores a %s message", (_label, candidate) => {
    expect(
      readConnectionIntentOAuthOutcome(candidate, origin, interactionId),
    ).toBeNull();
  });
});

describe("retained reconnect definition lookup", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;

  it("restores a hidden provider only for its exact retained application", () => {
    const githubApplication = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;

    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: connection,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [githubApplication],
    })?.slug).toBe("github");
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [],
      reconnectConnection: connection,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [githubApplication],
    })).toBeNull();
  });

  it("ends unavailable retained reconnects instead of leaving them loading", () => {
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("reconnect_unavailable");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: null,
      hasRequestedEntry: false,
      supportedMethodCount: 0,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("fallback");
    expect(requestedConnectionSetupResolution({
      reconnectConnectionId: "connection-1",
      hasRequestedEntry: true,
      supportedMethodCount: 1,
      unsupportedOAuth: false,
      vercelUnavailable: false,
      definitionUnavailable: false,
    })).toBe("ready");
  });

  it("does not expose a hidden provider without an exact reconnect target", () => {
    expect(requestedConnectionEntry({
      requestedAppKey: "github",
      galleryApps: [],
      reconnectConnection: null,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [],
    })).toBeNull();
    const visibleNotion = getConnectableAppDefinition("notion")!;
    expect(requestedConnectionEntry({
      requestedAppKey: "notion",
      galleryApps: [visibleNotion],
      reconnectConnection: null,
      resumeConnection: null,
      resumeApplication: null,
      completedResumeConnectionId: null,
      applications: [],
    })).toBe(visibleNotion);
  });

  it.each([
    ["draft", true],
    ["active", true],
    ["disabled", false],
    ["archived", false],
  ] as const)("allows retained resume status %s only when appropriate", (status, expected) => {
    const resumeConnection = {
      id: "connection-1",
      companyId: "company-1",
      applicationId: "app-clickup",
      status,
      config: { sourceTemplateKey: "clickup" },
    } as unknown as ToolConnection;
    const resumeApplication = {
      id: "app-clickup",
      companyId: "company-1",
      metadata: { sourceTemplateKey: "clickup" },
    } as unknown as ToolApplication;

    expect(retainedResumeMatches({
      requestedAppKey: "clickup",
      resumeConnection,
      resumeApplication,
      completedResumeConnectionId: "connection-1",
    })).toBe(expected);
  });

  it("resumes an older Copilot draft saved under the GitHub application through GitHub Copilot", () => {
    const github = {
      id: "app-github",
      companyId: "company-1",
      applicationKey: "app-gallery:github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;
    const copilotDraft = {
      id: "connection-1",
      companyId: "company-1",
      applicationId: "app-github",
      status: "draft",
      connectionPurpose: "ai",
      config: { sourceTemplateKey: "github", ai: { provider: "github", method: "api_key" } },
    } as unknown as ToolConnection;
    const githubDraft = {
      id: "connection-2",
      companyId: "company-1",
      applicationId: "app-github",
      status: "draft",
      config: { sourceTemplateKey: "github" },
    } as unknown as ToolConnection;
    const resume = (requestedAppKey: string, resumeConnection: ToolConnection) => retainedResumeMatches({
      requestedAppKey,
      resumeConnection,
      resumeApplication: github,
      completedResumeConnectionId: null,
    });

    expect(resume("github-copilot", copilotDraft)).toBe(true);
    expect(resume("github", copilotDraft)).toBe(false);
    expect(resume("github-copilot", githubDraft)).toBe(false);
    expect(resume("github", githubDraft)).toBe(true);
  });

  it("does not apply fresh-setup availability to an exact retained reconnect", () => {
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: true,
    })).toBe(false);
    expect(isVercelConnectUnavailable({
      credentialSource: "vercel_connect",
      available: false,
      retainedReconnectMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: true,
    })).toBe(false);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: "connection-1",
      reconnectSourceMatches: false,
    })).toBe(true);
    expect(isConnectionDefinitionUnavailable({
      available: false,
      reconnectConnectionId: undefined,
      reconnectSourceMatches: true,
    })).toBe(true);
  });
});

describe("retained reconnect target matching", () => {
  const connection = { applicationId: "app-1" } as ToolConnection;
  const application = { id: "app-1", applicationKey: "custom-mcp" } as ToolApplication;

  it("accepts a generic reconnect only for its exact retained application", () => {
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: undefined,
      byo: true,
      applicationId: "app-other",
      reconnectConnection: connection,
      reconnectApplication: application,
    })).toBe(false);
  });

  it("keeps curated reconnects bound to their provider", () => {
    const curated = {
      id: "app-1",
      applicationKey: "github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;
    expect(retainedReconnectMatches({
      requestedAppKey: "github",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: "notion",
      byo: false,
      applicationId: "app-1",
      reconnectConnection: connection,
      reconnectApplication: curated,
    })).toBe(false);
  });

  it("reconnects older Copilot accounts saved under the GitHub application through GitHub Copilot", () => {
    const github = {
      id: "app-1",
      applicationKey: "app-gallery:github",
      metadata: { sourceTemplateKey: "github" },
    } as unknown as ToolApplication;
    const copilot = {
      applicationId: "app-1",
      connectionPurpose: "ai",
      config: { sourceTemplateKey: "github", ai: { provider: "github", method: "api_key" } },
    } as unknown as ToolConnection;
    expect(retainedReconnectMatches({
      requestedAppKey: "github-copilot",
      byo: false,
      applicationId: undefined,
      reconnectConnection: copilot,
      reconnectApplication: github,
    })).toBe(true);
    expect(retainedReconnectMatches({
      requestedAppKey: "github-copilot",
      byo: false,
      applicationId: undefined,
      reconnectConnection: connection,
      reconnectApplication: github,
    })).toBe(false);
  });
});

describe("connection intent OAuth failure reasons", () => {
  it("explains an expired sign-in instead of a generic failure", () => {
    const code = readConnectionIntentOAuthFailureCode({
      type: "paperclip.connection-intent.oauth",
      interactionId,
      outcome: "failed",
      code: "oauth_state_expired",
    });
    expect(code).toBe("oauth_state_expired");
    expect(oauthFailureMessage(code)).toMatch(/took too long/);
  });

  it("explains a sign-in finished in another Paperclip session", () => {
    expect(oauthFailureMessage("oauth_session_mismatch")).toMatch(/different Paperclip session/);
  });

  it("ignores malformed codes and never shows a raw code", () => {
    expect(readConnectionIntentOAuthFailureCode({ code: "<script>" })).toBeNull();
    expect(readConnectionIntentOAuthFailureCode(null)).toBeNull();
    const fallback = oauthFailureMessage("oauth_callback_http_500");
    expect(fallback).toBe("Authorization did not complete. Try again when you’re ready.");
    expect(fallback).not.toContain("oauth_");
  });
});

describe("missing sign-in state messages", () => {
  const missing = { type: "paperclip.connection-intent.oauth", outcome: "failed", code: "oauth_state_missing" };
  const activePopup = {} as Window;
  const oldPopup = {} as Window;
  const from = (data: unknown, source: Window | null, eventOrigin = origin) => ({ origin: eventOrigin, data, source });

  it("accepts a missing-state failure from this setup's active sign-in window", () => {
    expect(isMissingOAuthStateMessage(from(missing, activePopup), origin, activePopup)).toBe(true);
  });

  it("ignores a missing-state failure from an old sign-in window", () => {
    expect(isMissingOAuthStateMessage(from(missing, oldPopup), origin, activePopup)).toBe(false);
    expect(isMissingOAuthStateMessage(from(missing, oldPopup), origin, null)).toBe(false);
  });

  it("rejects other origins, other codes, and messages bound to an interaction", () => {
    expect(isMissingOAuthStateMessage(from(missing, activePopup, "https://evil.test"), origin, activePopup)).toBe(false);
    expect(isMissingOAuthStateMessage(from({ ...missing, code: "oauth_state_expired" }, activePopup), origin, activePopup)).toBe(false);
    expect(isMissingOAuthStateMessage(from({ ...missing, interactionId }, activePopup), origin, activePopup)).toBe(false);
  });
});

describe("GitHub installation recovery from the sign-in window", () => {
  it("offers the install and manage links GitHub returned", () => {
    expect(readConnectionIntentGitHubRecovery({
      outcome: "failed",
      code: "github_installation_required",
      recovery: {
        installationUrl: "https://github.com/apps/paperclip-for-github/installations/new",
        managementUrl: "https://github.com/settings/installations",
      },
    })).toEqual({
      installationUrl: "https://github.com/apps/paperclip-for-github/installations/new",
      managementUrl: "https://github.com/settings/installations",
    });
    expect(oauthFailureMessage("github_installation_required")).toMatch(/Paperclip for GitHub app isn’t installed/);
  });

  it("drops links that are not on github.com or belong to another failure", () => {
    expect(readConnectionIntentGitHubRecovery({
      code: "github_installation_required",
      recovery: { installationUrl: "https://evil.test/install", managementUrl: "javascript:alert(1)" },
    })).toBeNull();
    expect(readConnectionIntentGitHubRecovery({
      code: "oauth_state_expired",
      recovery: { installationUrl: "https://github.com/apps/paperclip-for-github/installations/new" },
    })).toBeNull();
  });
});
