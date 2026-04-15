/**
 * Security tests for GHSA-68qg-g8mg-6pr7 (CVSS 10.0 RCE vulnerability)
 *
 * TDD approach: Tests are written to FAIL initially, proving vulnerabilities exist.
 * Each fix makes the corresponding tests PASS.
 *
 * Attack chain (6 steps from zero access to RCE):
 * 1. POST /api/auth/sign-up - create account (open registration)
 * 2. POST /api/auth/sign-in - sign in (no email verification)
 * 3. POST /api/cli-auth/challenges - create CLI challenge
 * 4. POST /api/cli-auth/challenges/:id/approve - self-approve (!)
 * 5. GET API key from approved challenge
 * 6. POST /api/companies/:id/import - RCE via import (fixed in main)
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// ============================================================================
// Mocks
// ============================================================================

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

// ============================================================================
// Test helpers
// ============================================================================

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes({} as Parameters<typeof accessRoutes>[0], {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

// ============================================================================
// Test Suite 1: Open Registration Default
// ============================================================================

describe("GHSA-68qg-g8mg-6pr7: open registration default", () => {
  /**
   * VULNERABILITY: config.ts:214 has `?? false` meaning signup is ALLOWED by default.
   * EXPECTED: Signup should be DISABLED by default (`?? true`).
   *
   * This test imports the config module and checks the default value.
   */
  it("authDisableSignUp defaults to true (signup disabled) when env is unset", async () => {
    // Clear any env that might affect the test
    const originalEnv = process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;
    delete process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP;

    // Reset module cache to get fresh config
    vi.resetModules();

    try {
      // Dynamically import to get fresh config state
      const { loadConfig } = await import("../config.js");
      const config = loadConfig();

      // SECURITY ASSERTION: Signup must be disabled by default
      // This test FAILS initially because config.ts:214 has `?? false`
      expect(config.authDisableSignUp).toBe(true);
    } finally {
      // Restore original env
      if (originalEnv !== undefined) {
        process.env.PAPERCLIP_AUTH_DISABLE_SIGN_UP = originalEnv;
      }
    }
  });
});

// ============================================================================
// Test Suite 2: CLI Auth Self-Approval Prevention
// ============================================================================

describe("GHSA-68qg-g8mg-6pr7: CLI auth self-approval", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * BASELINE: Anonymous users should not be able to approve challenges.
   * This test should PASS (existing check at access.ts:1692-1697).
   */
  it("requires authentication to approve CLI challenges", async () => {
    const app = createApp({ type: "none", source: "none" });

    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "pcp_cli_auth_test_token_1234567890" }); // min 16 chars

    expect(res.status).toBe(401);
  });

  /**
   * VULNERABILITY: Users can approve their own CLI challenges.
   * The challenge doesn't track who created it, and there's no check
   * to prevent self-approval at access.ts:1687-1738.
   *
   * EXPECTED: When user-1 creates a challenge, user-1 should NOT be able
   * to approve it. A different user must approve.
   *
   * This test FAILS initially because:
   * 1. Schema doesn't have `createdByUserId` column
   * 2. Service doesn't store creator
   * 3. Route doesn't check for self-approval
   */
  it("prevents users from approving their own CLI challenge", async () => {
    const userId = "user-attacker";
    const challengeId = "challenge-self-approve";

    // Mock: Challenge was created by user-attacker (same user trying to approve)
    // After fix, the challenge should include createdByUserId
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: challengeId,
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      createdByUserId: userId, // This field doesn't exist yet - part of the fix
    });

    // Mock: Attempt to approve will be blocked (after fix)
    // Currently this succeeds, which is the vulnerability
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: challengeId,
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });

    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    // Actor is the same user who created the challenge
    const app = createApp({
      type: "board",
      userId: userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post(`/api/cli-auth/challenges/${challengeId}/approve`)
      .send({ token: "pcp_cli_auth_test_token_1234567890" }); // min 16 chars

    // SECURITY ASSERTION: Self-approval must be rejected
    // This test FAILS initially (returns 200 instead of 403)
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/self.?approv/i);
    expect(mockBoardAuthService.approveCliAuthChallenge).not.toHaveBeenCalled();
  });

  /**
   * BASELINE: Different users should be able to approve challenges.
   * This test should PASS after the fix (cross-user approval is valid).
   */
  it("allows a different user to approve a CLI challenge", async () => {
    const creatorUserId = "user-requester";
    const approverUserId = "user-approver";
    const challengeId = "challenge-cross-approve";

    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: challengeId,
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      createdByUserId: creatorUserId, // Created by a different user
    });

    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: challengeId,
        boardApiKeyId: "board-key-2",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });

    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    // Actor is a DIFFERENT user than the challenge creator
    const app = createApp({
      type: "board",
      userId: approverUserId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post(`/api/cli-auth/challenges/${challengeId}/approve`)
      .send({ token: "pcp_cli_auth_test_token_1234567890" }); // min 16 chars

    // Cross-user approval should succeed
    expect(res.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      challengeId,
      "pcp_cli_auth_test_token_1234567890",
      approverUserId,
    );
  });
});

// ============================================================================
// Test Suite 3: Email Verification Configuration
// ============================================================================

describe("GHSA-68qg-g8mg-6pr7: email verification", () => {
  /**
   * Email verification is now CONFIGURABLE via PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION.
   * It defaults to false for backward compatibility (requires email sending setup).
   *
   * The config system allows operators to enable it when email is configured:
   * - Set PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION=true
   * - Or set auth.requireEmailVerification: true in paperclip.yaml
   *
   * This test verifies the configuration mechanism exists and works correctly.
   */
  it("authRequireEmailVerification is configurable and defaults to false", async () => {
    // Clear any env that might affect the test
    const originalEnv = process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION;
    delete process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION;

    vi.resetModules();

    try {
      const { loadConfig } = await import("../config.js");
      const config = loadConfig();

      // Default is false for backward compatibility (requires email setup)
      expect(config.authRequireEmailVerification).toBe(false);
    } finally {
      if (originalEnv !== undefined) {
        process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION = originalEnv;
      }
    }
  });

  it("authRequireEmailVerification can be enabled via env var", async () => {
    const originalEnv = process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION;
    process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION = "true";

    vi.resetModules();

    try {
      const { loadConfig } = await import("../config.js");
      const config = loadConfig();

      // When explicitly enabled, email verification is required
      expect(config.authRequireEmailVerification).toBe(true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION = originalEnv;
      } else {
        delete process.env.PAPERCLIP_AUTH_REQUIRE_EMAIL_VERIFICATION;
      }
    }
  });

  it("better-auth uses config value for requireEmailVerification", async () => {
    vi.resetModules();

    // Verify the auth module references config.authRequireEmailVerification
    const fs = await import("node:fs");
    const path = await import("node:path");
    const authFilePath = path.resolve(
      import.meta.dirname,
      "../auth/better-auth.ts",
    );
    const authFileContent = fs.readFileSync(authFilePath, "utf8");

    // SECURITY: Auth must use config value, not hardcoded false
    expect(authFileContent).toContain("config.authRequireEmailVerification");
    expect(authFileContent).not.toContain("requireEmailVerification: false");
  });
});

// ============================================================================
// Test Suite 4: Import Authorization (Regression Tests)
// ============================================================================

describe("GHSA-68qg-g8mg-6pr7: import authorization (regression)", () => {
  /**
   * This fix is already in place on main. These are regression tests
   * to ensure it stays fixed.
   *
   * The import endpoint at companies.ts now includes assertImportTargetAccess
   * which calls assertInstanceAdmin.
   */

  it("import endpoint exists with proper authorization check", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const companiesFilePath = path.resolve(
      import.meta.dirname,
      "../routes/companies.ts",
    );
    const companiesFileContent = fs.readFileSync(companiesFilePath, "utf8");

    // Verify the import route has authorization check
    expect(companiesFileContent).toContain("assertImportTargetAccess");
    expect(companiesFileContent).toContain("assertInstanceAdmin");
  });
});

// ============================================================================
// Test Suite 5: Attack Chain Integration
// ============================================================================

describe("GHSA-68qg-g8mg-6pr7: attack chain blocked", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * This test simulates the full attack chain and verifies each step
   * is properly blocked after all fixes are applied.
   *
   * Attack steps:
   * 1. Attacker signs up (blocked by disabled registration)
   * 2. Attacker signs in (blocked by email verification)
   * 3. Attacker creates CLI challenge (requires auth)
   * 4. Attacker self-approves (blocked by self-approval check)
   * 5. Attacker gets API key (requires valid approval)
   * 6. Attacker imports with RCE payload (blocked by instance admin check)
   */
  it("blocks the full attack chain at multiple points", async () => {
    // Step 1: Registration check
    // After fix, signup is disabled by default
    vi.resetModules();
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.authDisableSignUp).toBe(true); // Blocks step 1

    // Step 4: Self-approval check
    // After fix, users cannot approve their own challenges
    const attackerUserId = "attacker-user";

    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "attacker-challenge",
      status: "pending",
      createdByUserId: attackerUserId,
    });

    const app = createApp({
      type: "board",
      userId: attackerUserId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [],
    });

    const selfApproveRes = await request(app)
      .post("/api/cli-auth/challenges/attacker-challenge/approve")
      .send({ token: "pcp_cli_auth_attacker_token_12345" }); // min 16 chars

    expect(selfApproveRes.status).toBe(403); // Blocks step 4

    // Step 6: Import authorization check (already fixed)
    // Non-admin users cannot access import endpoint
    const fs = await import("node:fs");
    const path = await import("node:path");
    const companiesFile = fs.readFileSync(
      path.resolve(import.meta.dirname, "../routes/companies.ts"),
      "utf8",
    );
    expect(companiesFile).toContain("assertInstanceAdmin"); // Blocks step 6
  });
});
