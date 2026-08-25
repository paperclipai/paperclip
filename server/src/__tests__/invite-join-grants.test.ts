import { describe, expect, it } from "vitest";
import {
  agentJoinGrantsFromDefaults,
  humanJoinGrantsFromDefaults,
} from "../services/invite-grants.js";
import {
  grantsForHumanRole,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";
import {
  grantExpirySchema,
  portableGrantExpirySchema,
  updateMemberPermissionsSchema,
} from "@paperclipai/shared";

describe("agentJoinGrantsFromDefaults", () => {
  it("adds tasks:assign when invite defaults do not specify agent grants", () => {
    expect(agentJoinGrantsFromDefaults(null)).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  it("preserves invite agent grants and appends tasks:assign", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "agents:create",
              scope: null,
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "agents:create",
        scope: null,
      },
      {
        permissionKey: "tasks:assign",
        scope: null,
      },
    ]);
  });

  /**
   * A join creates the grant row fresh, so there is no existing bound for the
   * "absent keeps what is there" rule to fall back on. That makes this parser
   * the only thing standing between an operator's time-boxed invite and a
   * standing grant: drop the expiry here and the invite confers forever
   * (FAI-10144).
   */
  it("carries an invite grant expiry through as a Date", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "issues:cross-write",
              scope: { projectIds: ["project-1"] },
              expiresAt: "2026-09-06T12:34:56.789Z",
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "issues:cross-write",
        scope: { projectIds: ["project-1"] },
        expiresAt: new Date("2026-09-06T12:34:56.789Z"),
      },
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("omits the field entirely when the defaults never mention an expiry", () => {
    const [grant] = agentJoinGrantsFromDefaults({
      agent: { grants: [{ permissionKey: "agents:create", scope: null }] },
    });
    // Not `expiresAt: null` — absent is what `setPrincipalGrants` reads as
    // "leave any existing bound alone", and the two must stay distinguishable.
    expect(grant).toEqual({ permissionKey: "agents:create", scope: null });
    expect("expiresAt" in grant!).toBe(false);
  });

  it("keeps an explicit null, which is how a bound is removed", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: { grants: [{ permissionKey: "tasks:assign", scope: null, expiresAt: null }] },
      }),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null, expiresAt: null }]);
  });

  /**
   * `defaultsPayload` is operator-authored JSON that no schema validates. An
   * expiry we cannot read must not degrade to "no expiry" — that is the exact
   * widening this field exists to prevent — so the grant goes instead. A
   * zone-free instant counts as unreadable: it would resolve against whichever
   * machine accepted the invite.
   */
  it.each([
    ["a zone-free instant", "2026-09-06T12:34:56"],
    ["a non-string", 1788000000000],
    ["nonsense", "two weeks"],
  ])("drops a grant whose expiry is %s", (_label, expiresAt) => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            { permissionKey: "issues:cross-write", scope: { projectIds: ["p"] }, expiresAt },
          ],
        },
      }),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
  });

  /**
   * Dropping an unreadable expiry is only fail-closed if the drop is the end of
   * it. `tasks:assign` is the one key the agent fallback re-adds when it is
   * missing from the result, so an invite asking for a *bounded* `tasks:assign`
   * with a bound nobody could parse used to come back as an *indefinite*
   * `tasks:assign` — the drop widened the very grant it was protecting.
   */
  it.each([
    ["a zone-free instant", "2026-09-06T12:34:56"],
    ["a non-string", 1788000000000],
    ["nonsense", "two weeks"],
  ])("does not mint an indefinite tasks:assign when its expiry is %s", (_label, expiresAt) => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            { permissionKey: "tasks:assign", scope: { projectId: "project-1" }, expiresAt },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("still appends tasks:assign when an unrelated grant has the unreadable expiry", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            { permissionKey: "issues:cross-write", scope: null, expiresAt: "two weeks" },
          ],
        },
      }),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
  });

  it("does not duplicate tasks:assign when invite defaults already include it", () => {
    expect(
      agentJoinGrantsFromDefaults({
        agent: {
          grants: [
            {
              permissionKey: "tasks:assign",
              scope: { projectId: "project-1" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        permissionKey: "tasks:assign",
        scope: { projectId: "project-1" },
      },
    ]);
  });
});

describe("human invite roles", () => {
  it("maps owner to the full management grant set", () => {
    expect(grantsForHumanRole("owner")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "skills:create", scope: null },
      { permissionKey: "environments:manage", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "users:manage_permissions", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("maps admin to management grants including environment management", () => {
    expect(grantsForHumanRole("admin")).toEqual([
      { permissionKey: "agents:create", scope: null },
      { permissionKey: "agents:configure", scope: null },
      { permissionKey: "skills:create", scope: null },
      { permissionKey: "environments:manage", scope: null },
      { permissionKey: "users:invite", scope: null },
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "joins:approve", scope: null },
    ]);
  });

  it("defaults legacy or missing roles to operator", () => {
    expect(normalizeHumanRole("member")).toBe("operator");
    expect(resolveHumanInviteRole(null)).toBe("operator");
  });

  it("reads the configured human invite role from defaults", () => {
    expect(
      resolveHumanInviteRole({
        human: {
          role: "viewer",
        },
      }),
    ).toBe("viewer");
  });

  it("falls back to role grants when human invite defaults omit explicit grants", () => {
    expect(humanJoinGrantsFromDefaults(null, "operator")).toEqual([
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  /**
   * The same widening as the agent path, with a wider blast radius. An invite
   * whose human grants are *all* unreadable leaves an empty list, and the
   * role-defaults fallback then hands an admin the complete indefinite
   * management set the invite was trying to bound. An empty result caused by
   * rejected entries is not the same thing as an invite that named no human
   * grants at all — only the second should reach the role defaults.
   */
  it.each([
    ["operator" as const],
    ["admin" as const],
    ["owner" as const],
  ])("does not fall back to %s role defaults when every human grant expiry is unreadable", (role) => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              { permissionKey: "users:invite", scope: null, expiresAt: "two weeks" },
              { permissionKey: "tasks:assign", scope: null, expiresAt: "2026-09-06T12:34:56" },
            ],
          },
        },
        role,
      ),
    ).toEqual([]);
  });

  it("still falls back to role defaults when the human grants list is genuinely empty", () => {
    expect(humanJoinGrantsFromDefaults({ human: { grants: [] } }, "operator")).toEqual([
      { permissionKey: "tasks:assign", scope: null },
    ]);
  });

  it("keeps the readable human grants when only some expiries are unreadable", () => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              { permissionKey: "users:invite", scope: null, expiresAt: "two weeks" },
              { permissionKey: "tasks:assign", scope: null },
            ],
          },
        },
        "admin",
      ),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null }]);
  });

  it("preserves explicit human invite grants", () => {
    expect(
      humanJoinGrantsFromDefaults(
        {
          human: {
            grants: [
              {
                permissionKey: "users:invite",
                scope: { companyId: "company-1" },
              },
            ],
          },
        },
        "operator",
      ),
    ).toEqual([
      {
        permissionKey: "users:invite",
        scope: { companyId: "company-1" },
      },
    ]);
  });
});

/**
 * One expiry contract, four surfaces. The board's member-permissions call, the
 * portable manifest, the plugin host and the invite defaults payload all write
 * the same column, so a timestamp accepted by one has to be accepted by all of
 * them. They had drifted: the board surface was `z.string().datetime()`, which
 * takes `Z` and rejects `+02:00`, while the manifest was
 * `z.string().datetime({ offset: true })`, which takes both. The same payload
 * was therefore valid in a bundle and rejected over the API.
 *
 * These assert the shared schema itself rather than each call site, because the
 * fix is that there is only one schema left to assert.
 */
describe("grant expiry contract", () => {
  const boardExpiry = (expiresAt: unknown) =>
    updateMemberPermissionsSchema.safeParse({
      grants: [{ permissionKey: "tasks:assign", scope: null, expiresAt }],
    }).success;

  it.each([
    ["a UTC Z instant", "2026-09-06T12:34:56Z"],
    ["a positive offset", "2026-09-06T14:34:56+02:00"],
    ["a negative offset", "2026-09-06T06:34:56-06:00"],
  ])("accepts %s on every surface", (_label, value) => {
    expect(grantExpirySchema.safeParse(value).success).toBe(true);
    expect(portableGrantExpirySchema.safeParse(value).success).toBe(true);
    expect(boardExpiry(value)).toBe(true);
    // The invite payload reaches the same schema through `grantsFromDefaults`.
    expect(
      agentJoinGrantsFromDefaults({
        agent: { grants: [{ permissionKey: "tasks:assign", scope: null, expiresAt: value }] },
      }),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null, expiresAt: new Date(value) }]);
  });

  it.each([
    ["a zone-free instant", "2026-09-06T12:34:56"],
    ["a bare date", "2026-09-06"],
    ["nonsense", "two weeks"],
  ])("rejects %s on every surface", (_label, value) => {
    expect(grantExpirySchema.safeParse(value).success).toBe(false);
    expect(portableGrantExpirySchema.safeParse(value).success).toBe(false);
    expect(boardExpiry(value)).toBe(false);
    expect(
      agentJoinGrantsFromDefaults({
        agent: { grants: [{ permissionKey: "tasks:assign", scope: null, expiresAt: value }] },
      }),
    ).toEqual([]);
  });

  /**
   * Null and omission are the two ways a payload declines to set a bound, and
   * they do not mean the same thing: null clears an existing expiry, absent
   * leaves it alone. Both must stay legal everywhere.
   */
  it("accepts an explicit null on every surface", () => {
    expect(portableGrantExpirySchema.safeParse(null).success).toBe(true);
    expect(boardExpiry(null)).toBe(true);
    expect(
      agentJoinGrantsFromDefaults({
        agent: { grants: [{ permissionKey: "tasks:assign", scope: null, expiresAt: null }] },
      }),
    ).toEqual([{ permissionKey: "tasks:assign", scope: null, expiresAt: null }]);
  });

  it("accepts omission on every surface, without inventing a bound", () => {
    expect(
      updateMemberPermissionsSchema.safeParse({
        grants: [{ permissionKey: "tasks:assign", scope: null }],
      }).success,
    ).toBe(true);
    const [grant] = agentJoinGrantsFromDefaults({
      agent: { grants: [{ permissionKey: "tasks:assign", scope: null }] },
    });
    expect(grant).toEqual({ permissionKey: "tasks:assign", scope: null });
    expect("expiresAt" in grant!).toBe(false);
  });
});
