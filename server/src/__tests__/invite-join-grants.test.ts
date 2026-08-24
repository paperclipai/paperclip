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
