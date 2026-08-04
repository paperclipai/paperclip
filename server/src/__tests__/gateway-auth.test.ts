import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import {
  assertGatewayAuthStartupConfig,
  gatewayDefaultCompanyId,
  resolveGatewayAuthActor,
} from "../auth/gateway-auth.js";
import type { GatewayAuthConfig } from "../config.js";

function gatewayConfig(overrides: Partial<GatewayAuthConfig> = {}): GatewayAuthConfig {
  return {
    secret: "test-gateway-secret",
    adminRoles: ["paperclip-admin"],
    memberRoles: ["paperclip-dev"],
    defaultCompanyName: "Workforce",
    defaultCompanyId: undefined,
    headerEmail: "X-Forwarded-Email",
    headerUser: "X-Forwarded-User",
    headerGroups: "X-Forwarded-Groups",
    headerToken: "X-Paperclip-Gateway-Token",
    ...overrides,
  };
}

function mockRequest(headers: Record<string, string>): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    header(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as Request;
}

describe("gateway auth startup", () => {
  it("requires a shared secret when gateway auth is enabled", () => {
    expect(() => assertGatewayAuthStartupConfig(gatewayConfig({ secret: "" }))).toThrow(
      /PAPERCLIP_GATEWAY_AUTH_SECRET/,
    );
    expect(() => assertGatewayAuthStartupConfig(gatewayConfig())).not.toThrow();
    expect(() => assertGatewayAuthStartupConfig(null)).not.toThrow();
  });
});

describe("resolveGatewayAuthActor", () => {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when the gateway token is missing or invalid", async () => {
    const actor = await resolveGatewayAuthActor(
      db as never,
      mockRequest({
        "X-Forwarded-Email": "admin@example.com",
        "X-Forwarded-Groups": "paperclip-admin",
      }),
      gatewayConfig(),
    );
    expect(actor).toBeNull();
  });

  it("returns null when no recognized Paperclip role is present", async () => {
    const actor = await resolveGatewayAuthActor(
      db as never,
      mockRequest({
        "X-Paperclip-Gateway-Token": "test-gateway-secret",
        "X-Forwarded-Email": "user@example.com",
        "X-Forwarded-Groups": "grafana-admin",
      }),
      gatewayConfig(),
    );
    expect(actor).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("gatewayDefaultCompanyId", () => {
  it("uses a fixed id when configured", () => {
    expect(
      gatewayDefaultCompanyId({ companyName: "Workforce", fixedId: "11111111-1111-4111-8111-111111111111" }),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("derives a stable id from the company name", () => {
    const first = gatewayDefaultCompanyId({ companyName: "Workforce" });
    const second = gatewayDefaultCompanyId({ companyName: "Workforce" });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});
