import { describe, expect, it } from "vitest";
import {
  ADAPTER_AUTH_SESSION_INTERNAL_STATUSES,
  ADAPTER_AUTH_SESSION_STATUSES,
  type AdapterAuthSessionOwnerResponse,
  type AdapterAuthSessionResponse,
} from "./agent.js";
import {
  ADAPTER_AUTH_SESSION_ACTIVE_STATUSES,
  isActiveAdapterAuthSessionStatus,
  toPublicAdapterAuthSessionStatus,
} from "../adapter-auth-session.js";
import {
  adapterAuthSessionResponseSchema,
  startAdapterAuthSessionRequestSchema,
} from "../validators/adapter-auth-session.js";

// A key that must never appear on the public response. If the response type ever
// grows one of these keys, `AssertMissingKey` fails the type-check.
type AssertMissingKey<T, K extends string> = K extends keyof T ? never : true;

const sessionId = "11111111-1111-4111-8111-111111111111";
const environmentId = "22222222-2222-4222-8222-222222222222";

describe("adapter auth session contract", () => {
  it("keeps the public status union closed and neutral", () => {
    expect([...ADAPTER_AUTH_SESSION_STATUSES]).toEqual([
      "starting",
      "waiting_for_user",
      "authenticated",
      "failed",
      "timed_out",
      "cancelled",
    ]);
    // The internal states extend the public union with two server-only states.
    expect([...ADAPTER_AUTH_SESSION_INTERNAL_STATUSES]).toEqual([
      ...ADAPTER_AUTH_SESSION_STATUSES,
      "promoting",
      "cleanup_pending",
    ]);
    // No vendor or roadmap word in the public status union.
    const joined = ADAPTER_AUTH_SESSION_STATUSES.join(" ").toLowerCase();
    expect(joined).not.toContain("codex");
    expect(joined).not.toContain("device");
  });

  it("accepts a valid public response and rejects an unknown status", () => {
    const valid: AdapterAuthSessionResponse = {
      sessionId,
      environmentId,
      status: "waiting_for_user",
      expiresAt: "2026-08-11T12:00:00.000Z",
      failure: null,
    };
    expect(adapterAuthSessionResponseSchema.parse(valid)).toEqual(valid);
    expect(() => adapterAuthSessionResponseSchema.parse({ ...valid, status: "unknown" })).toThrow();
    // The internal states never validate as a public response status.
    expect(() => adapterAuthSessionResponseSchema.parse({ ...valid, status: "promoting" })).toThrow();
    expect(() => adapterAuthSessionResponseSchema.parse({ ...valid, status: "cleanup_pending" })).toThrow();
  });

  it("rejects a prompt, token, or lease field on the public response", () => {
    const base = {
      sessionId,
      environmentId,
      status: "waiting_for_user" as const,
      expiresAt: null,
      failure: null,
    };
    expect(() => adapterAuthSessionResponseSchema.parse({ ...base, prompt: { url: "x", code: "y" } })).toThrow();
    expect(() => adapterAuthSessionResponseSchema.parse({ ...base, token: "secret" })).toThrow();
    expect(() => adapterAuthSessionResponseSchema.parse({ ...base, providerLeaseId: "lease-1" })).toThrow();
    expect(() => adapterAuthSessionResponseSchema.parse({ ...base, accountId: "acct-1" })).toThrow();

    // Compile-time guard: the public response type carries none of these keys.
    const _noPrompt: AssertMissingKey<AdapterAuthSessionResponse, "prompt"> = true;
    const _noToken: AssertMissingKey<AdapterAuthSessionResponse, "token"> = true;
    const _noLease: AssertMissingKey<AdapterAuthSessionResponse, "providerLeaseId"> = true;
    const _noAccount: AssertMissingKey<AdapterAuthSessionResponse, "accountId"> = true;
    void _noPrompt;
    void _noToken;
    void _noLease;
    void _noAccount;
  });

  it("returns the prompt only through the owner read type", () => {
    const owner: AdapterAuthSessionOwnerResponse = {
      sessionId,
      environmentId,
      status: "waiting_for_user",
      expiresAt: null,
      failure: null,
      prompt: { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGHI" },
    };
    expect(owner.prompt?.code).toBe("ABCD-EFGHI");
  });

  it("maps the internal promoting state to the public waiting_for_user state", () => {
    expect(toPublicAdapterAuthSessionStatus("promoting")).toBe("waiting_for_user");
    expect(toPublicAdapterAuthSessionStatus("starting")).toBe("starting");
    expect(toPublicAdapterAuthSessionStatus("authenticated")).toBe("authenticated");
  });

  it("never projects cleanup_pending to a public status", () => {
    expect(() => toPublicAdapterAuthSessionStatus("cleanup_pending")).toThrow();
  });

  it("treats starting, waiting_for_user, and promoting as the active statuses", () => {
    expect([...ADAPTER_AUTH_SESSION_ACTIVE_STATUSES]).toEqual([
      "starting",
      "waiting_for_user",
      "promoting",
    ]);
    expect(isActiveAdapterAuthSessionStatus("starting")).toBe(true);
    expect(isActiveAdapterAuthSessionStatus("promoting")).toBe(true);
    expect(isActiveAdapterAuthSessionStatus("authenticated")).toBe(false);
    expect(isActiveAdapterAuthSessionStatus("cleanup_pending")).toBe(false);
  });

  it("validates a start request and rejects an unknown adapter", () => {
    const request = startAdapterAuthSessionRequestSchema.parse({
      environmentId,
      adapterType: "codex_local",
    });
    expect(request.environmentId).toBe(environmentId);
    expect(() => startAdapterAuthSessionRequestSchema.parse({ environmentId })).toThrow();
  });
});
