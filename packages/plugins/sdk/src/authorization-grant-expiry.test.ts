import { describe, expect, it } from "vitest";

import { createTestHarness } from "./testing.js";
import type {
  PaperclipPluginManifestV1,
  PluginAuthorizationClient,
  PluginAuthorizationDecisionResult,
} from "./types.js";

/**
 * The public plugin surface for grant expiry, on both halves.
 *
 * The compile half lives in `src/` rather than `tests/` on purpose: the SDK's
 * `tsconfig.json` includes `src` only, so this is the directory where
 * `tsc --noEmit` — the thing that actually enforces a type contract — will see
 * it. A type test under `tests/` runs and asserts nothing.
 *
 * The contract is worth pinning because `expiresAt` reached the wire before it
 * reached the types: the RPC protocol carried it and the host wrote it, while
 * `PluginAuthorizationClient.grants.set` and the decision result still
 * described a grant that could not be time-boxed. A plugin author reading the
 * published types saw the pre-expiry world, and passing the field was a
 * compile error against a host that would have honoured it (FAI-10152 round 4).
 */
describe("plugin authorization grant expiry (FAI-10144)", () => {
  const manifest = {
    id: "paperclip.test-grant-expiry",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Grant Expiry",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["authorization.grants.read", "authorization.grants.write"],
    entrypoints: { worker: "./worker.js" },
  } satisfies PaperclipPluginManifestV1;

  const COMPANY = "company-1";
  const AGENT = "agent-1";
  const KEY = "issues:cross-write";

  type SetInput = Parameters<PluginAuthorizationClient["grants"]["set"]>[0];
  type SetGrant = SetInput["grants"][number];

  it("types a bounded grant, an unbounded one, and an omitted bound", () => {
    // Each of these is a compile assertion. Drop `expiresAt` from the public
    // type and the first two stop compiling; make it required and the third
    // does. Nothing here needs to run — it needs to typecheck.
    const bounded = {
      permissionKey: KEY,
      scope: { projectId: "p" },
      expiresAt: "2026-09-06T00:00:00.000Z",
    } satisfies SetGrant;
    const unbounded = {
      permissionKey: KEY,
      scope: { projectId: "p" },
      expiresAt: null,
    } satisfies SetGrant;
    const omitted = { permissionKey: KEY, scope: { projectId: "p" } } satisfies SetGrant;

    expect([bounded, unbounded, omitted]).toHaveLength(3);
  });

  it("types the bound on the grant a decision rested on", () => {
    const decision = {
      allowed: true,
      action: "issues:cross-write",
      explanation: "Allowed by explicit grant issues:cross-write.",
      reason: "allow_explicit_grant",
      grant: {
        principalType: "agent",
        principalId: AGENT,
        permissionKey: KEY,
        scope: { projectId: "p" },
        expiresAt: "2026-09-06T00:00:00.000Z",
      },
    } satisfies PluginAuthorizationDecisionResult;

    expect(decision.grant?.expiresAt).toBe("2026-09-06T00:00:00.000Z");
  });

  /**
   * The harness has to refuse exactly what the host refuses. `grants.set` on
   * the real host runs the expiry through `grantExpirySchema`, which demands an
   * instant that names its own offset; the fake used to hand the string to
   * `new Date`, which resolves a zone-free string against whatever machine runs
   * the test and turns an unparseable one into an `Invalid Date` it stores
   * without complaint. Either way a plugin's tests would go green on a call the
   * host rejects.
   */
  const rejected: Array<[string, string]> = [
    ["zone-free", "2026-09-06T00:00:00"],
    ["date-only", "2026-09-06"],
    ["not a date", "two weeks"],
  ];

  it.each(rejected)("refuses a %s expiry the host would refuse", async (_label, expiresAt) => {
    const harness = createTestHarness({ manifest });

    await expect(
      harness.ctx.authorization.grants.set({
        companyId: COMPANY,
        principalType: "agent",
        principalId: AGENT,
        grants: [{ permissionKey: KEY, scope: { projectId: "p" }, expiresAt }],
      }),
    ).rejects.toThrow(/timezone offset/);
  });

  const accepted: Array<[string, string]> = [
    ["UTC", "2026-09-06T00:00:00.000Z"],
    ["offset", "2026-09-06T02:00:00.000+02:00"],
  ];

  it.each(accepted)("stores a %s expiry", async (_label, expiresAt) => {
    const harness = createTestHarness({ manifest });

    const [grant] = await harness.ctx.authorization.grants.set({
      companyId: COMPANY,
      principalType: "agent",
      principalId: AGENT,
      grants: [{ permissionKey: KEY, scope: { projectId: "p" }, expiresAt }],
    });

    // Both name the same instant, which is the point of demanding an offset.
    expect(grant!.expiresAt).toEqual(new Date("2026-09-06T00:00:00.000Z"));
  });

  /**
   * The rule the whole field rests on: a replacement that does not mention
   * `expiresAt` keeps the bound, and only an explicit null removes it. A plugin
   * written before this field existed round-trips the grant list without it,
   * and if the fake let that clear the bound, plugin authors would be testing
   * against a host that widens authority on every write.
   */
  it("keeps a bound through a replacement that omits it, and clears it on an explicit null", async () => {
    const harness = createTestHarness({ manifest });
    const expiresAt = "2026-09-06T00:00:00.000Z";

    await harness.ctx.authorization.grants.set({
      companyId: COMPANY,
      principalType: "agent",
      principalId: AGENT,
      grants: [{ permissionKey: KEY, scope: { projectId: "p" }, expiresAt }],
    });

    const [afterOmission] = await harness.ctx.authorization.grants.set({
      companyId: COMPANY,
      principalType: "agent",
      principalId: AGENT,
      grants: [{ permissionKey: KEY, scope: { projectId: "p2" } }],
    });
    expect(afterOmission!.scope).toEqual({ projectId: "p2" });
    expect(afterOmission!.expiresAt).toEqual(new Date(expiresAt));

    const [afterNull] = await harness.ctx.authorization.grants.set({
      companyId: COMPANY,
      principalType: "agent",
      principalId: AGENT,
      grants: [{ permissionKey: KEY, scope: { projectId: "p2" }, expiresAt: null }],
    });
    expect(afterNull!.expiresAt).toBeNull();
  });
});
