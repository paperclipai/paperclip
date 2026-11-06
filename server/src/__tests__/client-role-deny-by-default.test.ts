import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  getAccessibleResource,
  hasBoardOrgAccess,
  hasCompanyAccess,
  isCompanyClientReachable,
  markCompanyClientReachable,
} from "../routes/authz.js";
import {
  filterStaffCompanyIds,
  grantsForHumanRole,
  hasActiveStaffMembership,
  hasClientMembershipFor,
  normalizeHumanRole,
  resolveHumanInviteRole,
} from "../services/company-member-roles.js";

/**
 * Security tests for the deny-by-default `client` membership role.
 *
 * A `client` is an authenticated company member whose default surface is
 * empty. These tests are the invariant behind that sentence: they fail if a
 * client can read or write any company-scoped core route, reach the org-level
 * surface, or acquire a single permission grant by default.
 */

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const UNSAFE_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;
const ALL_METHODS = [...SAFE_METHODS, ...UNSAFE_METHODS];
const STAFF_ROLES = ["owner", "admin", "operator", "viewer"] as const;

type Membership = { companyId: string; membershipRole?: string | null; status?: string };

function makeReq(input: {
  method?: string;
  actor: Express.Request["actor"];
}) {
  return { method: input.method ?? "GET", actor: input.actor } as Express.Request;
}

function boardActor(memberships: Membership[], extra: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    // auth.ts derives companyIds from every ACTIVE membership regardless of
    // role, so a client membership lands here like any other.
    companyIds: memberships.map((m) => m.companyId),
    memberships,
    ...extra,
  } as Express.Request["actor"];
}

const clientActor = () => boardActor([
  { companyId: "company-1", membershipRole: "client", status: "active" },
]);

/** Minimal `res` double that records what `getAccessibleResource` sent. */
function makeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as import("express").Response, sent };
}

describe("client principals are denied on every company-scoped core route", () => {
  it("is denied by assertCompanyAccess on every method, safe ones included", () => {
    for (const method of ALL_METHODS) {
      const req = makeReq({ method, actor: clientActor() });
      expect(
        () => assertCompanyAccess(req, "company-1"),
        `${method} must be denied for a client`,
      ).toThrowError(/Client access is limited/);
    }
  });

  it("is denied by hasCompanyAccess, so every getAccessibleResource site denies it", () => {
    expect(hasCompanyAccess(makeReq({ actor: clientActor() }), "company-1")).toBe(false);
  });

  it("gets the tenant-safe 404 from getAccessibleResource, with no existence oracle", async () => {
    const missing = makeRes();
    const existing = makeRes();

    const forMissing = await getAccessibleResource(
      makeReq({ actor: clientActor() }),
      missing.res,
      null,
      "Issue not found",
    );
    const forExisting = await getAccessibleResource(
      makeReq({ actor: clientActor() }),
      existing.res,
      { companyId: "company-1", id: "issue-1" },
      "Issue not found",
    );

    expect(forMissing).toBeNull();
    expect(forExisting).toBeNull();
    // "No such resource" and "exists, and you may not see it" are identical.
    expect(missing.sent).toEqual(existing.sent);
    expect(existing.sent.status).toBe(404);
  });

  it("gets no org-level surface, which is what ~100 assertBoardOrgAccess routes gate on", () => {
    const req = makeReq({ actor: clientActor() });
    expect(hasBoardOrgAccess(req)).toBe(false);
    expect(() => assertBoardOrgAccess(req)).toThrowError(/membership or instance admin/i);
  });

  it("cannot lend its authority to an agent run, on any method", () => {
    for (const method of ALL_METHODS) {
      const req = makeReq({
        method,
        actor: {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          source: "agent_key",
          onBehalfOfUserId: "user-1",
          onBehalfOfMemberships: [
            { companyId: "company-1", membershipRole: "client", status: "active" },
          ],
        } as Express.Request["actor"],
      });
      expect(
        () => assertCompanyAccess(req, "company-1"),
        `${method} on behalf of a client must be denied`,
      ).toThrowError(/Client access is limited/);
    }
  });

  it("is denied per company: a staff membership elsewhere does not carry over", () => {
    const actor = boardActor([
      { companyId: "company-1", membershipRole: "client", status: "active" },
      { companyId: "company-2", membershipRole: "admin", status: "active" },
    ]);
    expect(hasCompanyAccess(makeReq({ actor }), "company-1")).toBe(false);
    expect(hasCompanyAccess(makeReq({ actor }), "company-2")).toBe(true);
    // Being staff somewhere does restore the org surface -- it is not
    // company-scoped -- but company-1 stays closed.
    expect(hasBoardOrgAccess(makeReq({ actor }))).toBe(true);
    expect(() => assertCompanyAccess(makeReq({ actor }), "company-2")).not.toThrow();
  });

  it("is denied when its membership is not active, because it leaves companyIds", () => {
    // auth.ts builds companyIds from ACTIVE memberships only, so a
    // non-active client never reaches the role check -- it fails the
    // company-id check first. Assert the realistic actor shape.
    for (const status of ["pending", "suspended", "archived"]) {
      const actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        companyIds: [],
        memberships: [{ companyId: "company-1", membershipRole: "client", status }],
      } as Express.Request["actor"];
      expect(hasCompanyAccess(makeReq({ actor }), "company-1"), status).toBe(false);
      expect(() => assertCompanyAccess(makeReq({ actor }), "company-1"), status).toThrow();
    }
  });
});

describe("the client deny is opt-in-able, and only by server code", () => {
  it("denies until the request is explicitly marked client-reachable", () => {
    const req = makeReq({ actor: clientActor() });
    expect(isCompanyClientReachable(req, "company-1")).toBe(false);
    expect(hasCompanyAccess(req, "company-1")).toBe(false);

    markCompanyClientReachable(req, "company-1");

    expect(isCompanyClientReachable(req, "company-1")).toBe(true);
    expect(hasCompanyAccess(req, "company-1")).toBe(true);
    expect(() => assertCompanyAccess(req, "company-1")).not.toThrow();
  });

  it("marks one company at a time", () => {
    const actor = boardActor([
      { companyId: "company-1", membershipRole: "client", status: "active" },
      { companyId: "company-2", membershipRole: "client", status: "active" },
    ]);
    const req = makeReq({ actor });
    markCompanyClientReachable(req, "company-1");
    expect(hasCompanyAccess(req, "company-1")).toBe(true);
    expect(hasCompanyAccess(req, "company-2")).toBe(false);
  });

  it("cannot be forged from request-controlled input", () => {
    // The marker is keyed by a module-private Symbol, so no body, query or
    // header value -- all string-keyed -- can produce it.
    const req = makeReq({ actor: clientActor() });
    Object.assign(req, {
      paperclipClientReachableCompanyIds: new Set(["company-1"]),
      "Symbol(paperclipClientReachableCompanyIds)": new Set(["company-1"]),
    });
    for (const key of Object.keys(req)) {
      expect(typeof key).toBe("string");
    }
    expect(isCompanyClientReachable(req, "company-1")).toBe(false);
    expect(hasCompanyAccess(req, "company-1")).toBe(false);
  });

  it("does not leak into serialization of the request", () => {
    const req = makeReq({ actor: clientActor() });
    const before = JSON.stringify(req);
    markCompanyClientReachable(req, "company-1");
    // The marker is non-enumerable, so marking changes nothing observable in
    // request logging or any JSON view of the request.
    expect(JSON.stringify(req)).toBe(before);
    expect(Object.keys(req)).not.toContain("paperclipClientReachableCompanyIds");
  });
});

describe("the client role carries no authority", () => {
  it("has an empty default grant set", () => {
    expect(grantsForHumanRole("client")).toEqual([]);
  });

  it("has strictly fewer grants than viewer, the weakest staff role", () => {
    expect(grantsForHumanRole("viewer").length).toBeGreaterThan(0);
    expect(grantsForHumanRole("client").length).toBe(0);
  });

  it("contributes no company to a staff read scope", () => {
    const memberships: Membership[] = [
      { companyId: "company-1", membershipRole: "client", status: "active" },
      { companyId: "company-2", membershipRole: "operator", status: "active" },
    ];
    expect(filterStaffCompanyIds(["company-1", "company-2"], memberships)).toEqual(["company-2"]);
    expect(hasActiveStaffMembership([memberships[0]])).toBe(false);
    expect(hasActiveStaffMembership(memberships)).toBe(true);
  });
});

describe("role resolution fails closed", () => {
  it("recognizes client, because the role list is no longer duplicated", () => {
    // This is the regression that makes a staged rollout safe: before, the
    // server kept its own copy of the role list, so a role added to
    // @paperclipai/shared stayed "unrecognized" here and fell back to the
    // fallback role.
    expect(normalizeHumanRole("client")).toBe("client");
  });

  it("resolves an unrecognized invite role to the least privileged role, not operator", () => {
    const resolved = resolveHumanInviteRole({ human: { role: "wizard" } });
    expect(resolved).toBe("client");
    expect(grantsForHumanRole(resolved)).toEqual([]);
  });

  it("keeps the historical operator default when an invite names no role", () => {
    expect(resolveHumanInviteRole(null)).toBe("operator");
    expect(resolveHumanInviteRole({})).toBe("operator");
    expect(resolveHumanInviteRole({ human: {} })).toBe("operator");
    expect(resolveHumanInviteRole({ human: { role: null } })).toBe("operator");
  });

  it("honors an explicit client invite role", () => {
    expect(resolveHumanInviteRole({ human: { role: "client" } })).toBe("client");
  });

  it("still maps the legacy member role to operator", () => {
    expect(normalizeHumanRole("member")).toBe("operator");
  });
});

describe("staff roles are unchanged", () => {
  it("still reach company-scoped routes exactly as before", () => {
    for (const role of STAFF_ROLES) {
      const actor = boardActor([{ companyId: "company-1", membershipRole: role, status: "active" }]);
      expect(hasCompanyAccess(makeReq({ actor }), "company-1"), role).toBe(true);
      expect(hasBoardOrgAccess(makeReq({ actor })), role).toBe(true);
      for (const method of SAFE_METHODS) {
        expect(
          () => assertCompanyAccess(makeReq({ method, actor }), "company-1"),
          `${role} ${method}`,
        ).not.toThrow();
      }
    }
  });

  it("keeps viewer read-only and keeps the other three writable", () => {
    for (const method of UNSAFE_METHODS) {
      const viewer = boardActor([
        { companyId: "company-1", membershipRole: "viewer", status: "active" },
      ]);
      expect(() => assertCompanyAccess(makeReq({ method, actor: viewer }), "company-1"))
        .toThrowError(/read-only/);

      for (const role of ["owner", "admin", "operator"] as const) {
        const staff = boardActor([
          { companyId: "company-1", membershipRole: role, status: "active" },
        ]);
        expect(
          () => assertCompanyAccess(makeReq({ method, actor: staff }), "company-1"),
          `${role} ${method}`,
        ).not.toThrow();
      }
    }
  });

  it("leaves the on-box CLI and cross-company denial alone", () => {
    const local = makeReq({ actor: { type: "board", userId: "u", source: "local_implicit" } });
    expect(hasCompanyAccess(local, "company-1")).toBe(true);
    expect(() => assertCompanyAccess(local, "company-1")).not.toThrow();

    const outsider = boardActor([
      { companyId: "company-2", membershipRole: "admin", status: "active" },
    ]);
    expect(() => assertCompanyAccess(makeReq({ actor: outsider }), "company-1"))
      .toThrowError(/does not have access to this company/);
  });

  it("classifies an actor with no membership data exactly as before", () => {
    // Deny-by-default subtracts the client role; it must not start denying
    // actors whose roles we cannot read.
    const actor = { type: "board", userId: "u", source: "session", companyIds: ["company-1"] } as
      Express.Request["actor"];
    expect(hasCompanyAccess(makeReq({ actor }), "company-1")).toBe(true);
    expect(hasBoardOrgAccess(makeReq({ actor }))).toBe(true);
  });
});

/**
 * The deny above lives in three shared helpers, which is what makes it
 * reviewable: ~600 company-scoped call sites inherit it, and a route added
 * tomorrow inherits it too.
 *
 * The risk is a route that decides company scope *without* those helpers --
 * a hand-rolled `companyIds.includes(...)`. Each such site has to repeat the
 * deny, and this sweep is what stops a new one from appearing unnoticed: it
 * reads the source tree and fails on any company-scope decision outside
 * `routes/authz.ts` that does not consult the membership role.
 */
describe("no company-scope decision bypasses the role check", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverSrc = join(here, "..");

  /**
   * Any module that reads an actor's `companyIds` is making, or feeding, a
   * company-scope decision. Detecting the *read* rather than a particular
   * comparison shape keeps the sweep from being defeated by assigning
   * `companyIds` to a local first, which is how the real code is written:
   *
   *     const allowedCompanies = req.actor.companyIds ?? [];
   *     if (!allowedCompanies.includes(companyId)) throw forbidden(...)
   */
  const READS_ACTOR_COMPANY_IDS = /\b\w*(?:[Aa]ctor|access)\??\.companyIds\b/;

  /**
   * Modules that read an actor's company scope and repeat the client deny.
   * Pins the sweep to reality: if one of these stops being detected, the
   * detector has drifted and this test says so instead of quietly passing.
   */
  const KNOWN_COMPANY_SCOPE_SITES = [
    "realtime/live-events-ws.ts",
    "routes/cases.ts",
    "routes/companies.ts",
    "routes/environments.ts",
    "routes/issues.ts",
    "routes/plugins.ts",
    "services/case-handoffs.ts",
    "services/decisions.ts",
    "services/skill-access.ts",
  ] as const;

  /**
   * Company-scope reads that are deliberately role-blind, with the reason.
   * Most build or carry an actor and return no company data at all. The two
   * session-bootstrap entries are the exception and are called out below:
   * they return the same company rows as `GET /companies`, which is itself
   * deliberately role-blind because a client has to see the company it
   * belongs to in order to reach a portal inside it.
   */
  const ROLE_BLIND_BY_DESIGN: Record<string, string> = {
    // Builds the actor in the first place.
    "middleware/auth.ts": "derives companyIds from memberships",
    // Request body, not an actor scope.
    "routes/access.ts": "reads companyIds from the request body",
    // GET /get-session picks a first-paint projection from the caller's own
    // scope. It duplicates GET /companies?scope=accessible plus the caller's
    // own board access, so it is role-blind for the same reason that list is.
    "routes/auth.ts": "session bootstrap projection of the caller's own scope",
    // Builds that projection: filters the company list to the caller's own
    // companyIds and returns only the caller's own access row. See the
    // payload note under this object.
    "services/board-bootstrap.ts": "projects the caller's own scope for first paint",
    // Chooses which company a session is scoped to at login.
    "services/board-auth.ts": "session company selection",
    // Identity continuity for a handoff; returns no company data.
    "services/case-handoff-authority.ts": "handoff identity continuity check",
    // Builds a downstream actor from an already-authorized request.
    "services/plugin-host-services.ts": "constructs an actor for an authorized plugin call",
    // Mints the actor for a consented MCP grant.
    "services/public-mcp/oauth.ts": "constructs the actor for a consented grant",
    // Wires the resolver; the deny is applied in live-events-ws.ts.
    "index.ts": "passes the cloud actor through to the websocket upgrade",
  };

  /**
   * Payload note, recorded because it narrows what "role-blind is fine here"
   * means. A company row from `companyService.list()` is wider than the
   * company's identity: besides id, name, description and logo it carries
   * `budgetMonthlyCents`, `spentMonthlyCents`, `interactionResolverGovernance`
   * and `defaultResponsibleUserId`. Every active member already receives that
   * row from `GET /companies` on master, `viewer` included, so this is not a
   * client-specific hole and not a regression from this change -- but a
   * principal with zero grants arguably should see the name and nothing more.
   * Narrowing the row for a client principal is a deliberate follow-up rather
   * than part of this change, because it alters a response shape every staff
   * role reads.
   */

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        found.push(...(await sourceFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
    }
    return found;
  }

  async function companyScopeReaders() {
    const files = await sourceFiles(serverSrc);
    const readers = new Map<string, string>();
    for (const file of files) {
      const rel = relative(serverSrc, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      if (READS_ACTOR_COMPANY_IDS.test(source)) readers.set(rel, source);
    }
    return readers;
  }

  it("every company-scope decision outside authz.ts also consults the membership role", async () => {
    const readers = await companyScopeReaders();
    const offenders: string[] = [];

    for (const [rel, source] of readers) {
      if (rel === "routes/authz.ts") continue;
      if (rel in ROLE_BLIND_BY_DESIGN) continue;
      if (!source.includes("company-member-roles.js")) offenders.push(rel);
    }

    expect(offenders.sort(), [
      "These modules scope by company id without consulting the membership role,",
      "so a `client` principal would pass them. Either route the decision through",
      "routes/authz.ts, repeat the deny with a company-member-roles helper, or",
      "add it to ROLE_BLIND_BY_DESIGN with a reason.",
    ].join(" ")).toEqual([]);
  });

  it("still detects the company-scope sites it is meant to cover", async () => {
    const readers = await companyScopeReaders();
    for (const known of KNOWN_COMPANY_SCOPE_SITES) {
      expect([...readers.keys()], `${known} should still be detected by the sweep`)
        .toContain(known);
    }
  });

  it("recognizes the real-world shape of a hand-rolled scope check", () => {
    // The detector has to survive the local-variable form, which is what
    // defeated an earlier version of this sweep.
    expect(READS_ACTOR_COMPANY_IDS.test(
      "const allowedCompanies = req.actor.companyIds ?? [];",
    )).toBe(true);
    expect(READS_ACTOR_COMPANY_IDS.test("return (req.actor.companyIds ?? []).includes(id);"))
      .toBe(true);
    expect(READS_ACTOR_COMPANY_IDS.test("new Set(req.actor.companyIds ?? [])")).toBe(true);
    expect(READS_ACTOR_COMPANY_IDS.test("actor.companyIds?.includes(companyId)")).toBe(true);
    expect(READS_ACTOR_COMPANY_IDS.test("access.companyIds.includes(row.companyId)")).toBe(true);
    // Any identifier that names an actor, not just the literal `actor`.
    expect(READS_ACTOR_COMPANY_IDS.test("cloudActor.companyIds.includes(companyId)")).toBe(true);
    expect(READS_ACTOR_COMPANY_IDS.test("const companyIds = [];")).toBe(false);
    expect(READS_ACTOR_COMPANY_IDS.test("input.companyIds ?? []")).toBe(false);
  });
});

/**
 * A second, larger class of authority check, found by review of this change.
 *
 * The sweep above detects modules that read an actor's `companyIds`. It does
 * not detect a module that reads `membership_role` from the database and then
 * tests it against `viewer`, in any of these shapes:
 *
 *     membership.membershipRole !== "viewer"                      // "has authority"
 *     ne(companyMemberships.membershipRole, "viewer")              // the same, in SQL
 *     sql`${m.membershipRole} is distinct from 'viewer'`           // the same, raw
 *
 * All three shapes treat *any* non-`viewer` role as a staff member, so a role
 * that is merely added to the role list satisfies them. 36 of the modules below
 * never call a company-scope helper, so no route gate runs before them;
 * external pipelines reach them (chat, MCP, OAuth callbacks, the token broker,
 * git credentials).
 *
 * These sites are NOT yet converted. Converting them is held on one upstream
 * decision, because the two candidate shapes differ for the `member` role:
 * `services/access.ts` stores `"member"` as its default `membershipRole`, so
 * an allow-list of `owner | admin | operator` would deny memberships that
 * already exist, while excluding only the new role would not.
 *
 * So this is a ratchet, not a green light. It pins the inventory: a *new*
 * viewer-shaped authority check fails this test, and a converted one has to be
 * removed from the list. It stops the gap from growing while the decision is
 * open, and it keeps the gap visible in the test suite rather than in a
 * comment thread.
 *
 * The detector matches source text, so it cannot tell an authority decision
 * apart from any other predicate that names `viewer`. Both are pinned, in two
 * separate lists, so that the authority inventory stays an honest count of the
 * gap while a new file in either shape still fails the build.
 */
describe("the viewer-shaped authority check is a known, pinned gap", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverSrc = join(here, "..");

  /**
   * Every shape of "this member is not a viewer, so it has authority".
   *
   * The quote class matters. Drizzle's helpers are written with the repo's
   * double quotes, but a raw `sql` fragment is Postgres, so its literal is
   * single-quoted -- which is how `services/voice/voice-session-store.ts`
   * stayed invisible to an earlier, double-quote-only version of this
   * detector while being a real authority check.
   *
   * A `switch` over the role is deliberately *not* a shape here. It is the one
   * form that cannot admit a new role silently: `grantsForHumanRole` switches
   * on the shared union with no `default`, so TypeScript rejects the switch
   * until the new role has its own branch. "has an empty default grant set"
   * above asserts that branch exists, and a grep of `server/src` finds no
   * other switch over a membership role, with or without a `default`. The
   * hazard this ratchet guards is the silent kind.
   */
  const QUOTED_VIEWER = String.raw`["']viewer["']`;
  const TESTS_ROLE_AGAINST_VIEWER = new RegExp(
    [
      // membership.membershipRole !== "viewer"   (and the === deny direction)
      String.raw`(?:!==|===)\s*${QUOTED_VIEWER}`,
      // ne(companyMemberships.membershipRole, "viewer")
      String.raw`ne\(\s*[\w.]*membershipRole\s*,\s*${QUOTED_VIEWER}\s*\)`,
      // sql`${companyMemberships.membershipRole} is distinct from 'viewer'`
      String.raw`membershipRole\}?\s*(?:is(?:\s+not)?\s+distinct\s+from|<>|!=|=)\s*${QUOTED_VIEWER}`,
    ].join("|"),
  );

  /**
   * Every module that currently decides authority this way. Ordered, so a diff
   * to this list is readable. `routes/authz.ts` is included because it is the
   * designated home of the deny and still uses the shape for `viewer` itself.
   */
  const VIEWER_SHAPED_AUTHORITY_SITES = [
    "modules/external-agents/native-broker.ts",
    "routes/agent-profile-avatar.ts",
    "routes/ai-connections.ts",
    "routes/authz.ts",
    "routes/costs.ts",
    "routes/dot-runner.ts",
    "routes/issues.ts",
    "routes/muse.ts",
    // Arrived in master after this branch opened. `canChangeResponsibleUser`
    // mirrors assertCompanyAccess's write restriction on a GET route, so its
    // `=== "viewer"` reads every other role as able to write. Gated subset:
    // the only caller is GET /routines/:id, behind `getAccessibleResource`,
    // which this change makes 404 for a client -- and the predicate ends in
    // `access.canUser(..., "tasks:assign")`, which a client fails anyway on
    // an empty grant set.
    "routes/routines.ts",
    "routes/tool-access.ts",
    "routes/tool-gateway.ts",
    "services/authorization.ts",
    "services/browser-use.ts",
    "services/case-handoff-authority.ts",
    "services/chat-channels/discord/root-threads.ts",
    "services/chat-channels/inbound/authorization.ts",
    "services/chat-channels/microsoft-teams/file-transfer-authority.ts",
    "services/chat-channels/slack/setup-services.ts",
    "services/chat-channels/slack/task-authority.ts",
    "services/chat-channels/slack/task-start-resolution.ts",
    "services/chat-channels/slack/task-start.ts",
    "services/chat-github-access.ts",
    "services/chat-github-events.ts",
    "services/chat-github-management.ts",
    "services/chat-github-registration.ts",
    "services/chat-github-wizard.ts",
    "services/connection-intent-delivery.ts",
    "services/connection-intents.ts",
    "services/connectors/slack/test-message.ts",
    "services/email-channels.ts",
    "services/external-bot-authority.ts",
    "services/git-credentials.ts",
    "services/muse-identity.ts",
    "services/native-runtime/chat-attachment-reuse.ts",
    // Arrived after this branch opened, which is what the ratchet is for. Its
    // `authorize` re-checks the resolver at consumption time and reads
    // `membershipRole === "viewer"` to deny, so every other role passes. It is
    // in the gated subset rather than the externally-reached one: the only
    // route that enqueues the work, POST /heartbeat-runs/:runId/runtime-
    // requests/:requestId/resolve, calls getAccessibleResource first, so the
    // deny in authz.ts already denies a client before this runs.
    "services/native-runtime/native-runtime-response-delivery.ts",
    "services/plugin-host-services.ts",
    "services/project-git-authorization.ts",
    "services/public-mcp/capabilities.ts",
    "services/public-mcp/file-transfers.ts",
    "services/public-mcp/oauth.ts",
    "services/satisfied-connection-intents.ts",
    "services/slack-board-authority.ts",
    "services/tool-access/oauth/cloud-callback.ts",
    "services/tool-access/oauth/direct-callback.ts",
    "services/tool-access/oauth/vercel-callback.ts",
    "services/tool-access/token-broker/admission.ts",
    "services/tool-access.ts",
    "services/tool-gateway.ts",
    // Found by widening the detector to the raw-SQL shape, not by a new
    // commit: `authorizeCaller` is the company-membership gate for a voice
    // session and its predicate is `is distinct from 'viewer'`, so a client
    // passes it. Gated subset: every board voice route resolves its company
    // through `assertCompanyAccess`, so the deny in authz.ts runs first. The
    // one route that skips it on purpose, POST /voice-sessions/:id/end,
    // instead requires `session.callerId === caller.id` -- and a client
    // cannot own a session, because starting one is behind the gate.
    "services/voice/voice-session-store.ts",
  ] as const;

  /**
   * Files that name `viewer` in a predicate that does not decide authority, so
   * they are not part of the gap the deny has to close. They are still pinned,
   * because the detector cannot tell the two apart from the source text alone
   * and the sweep has to stay a ratchet: a new file is a build failure either
   * way, and triage then decides which list it belongs in.
   */
  const VIEWER_SHAPED_NOTICE_SITES = [
    // Both gate a `notifyChatRunMilestones(tx, { companyId })` call when a
    // membership becomes active or is restored. The predicate chooses whether
    // to send a company notice, not what a principal may reach, and the notice
    // is company-scoped with no principal in it. A `client` membership does
    // trip these notices, which is untidy but grants nothing; left alone here
    // because it is behavior in code this PR does not otherwise touch.
    "middleware/auth.ts",
    "services/access.ts",
  ] as const;

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const found: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        found.push(...(await sourceFiles(full)));
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
    }
    return found;
  }

  it("no module outside the pinned inventory tests a role against `viewer`", async () => {
    const files = await sourceFiles(serverSrc);
    const found: string[] = [];
    for (const file of files) {
      const rel = relative(serverSrc, file).split("\\").join("/");
      if (TESTS_ROLE_AGAINST_VIEWER.test(readFileSync(file, "utf8"))) found.push(rel);
    }

    const pinned = new Set<string>([
      ...VIEWER_SHAPED_AUTHORITY_SITES,
      ...VIEWER_SHAPED_NOTICE_SITES,
    ]);
    const added = found.filter((rel) => !pinned.has(rel)).sort();
    const removed = [...pinned].filter((rel) => !found.includes(rel)).sort();

    expect(added, [
      "These modules name `viewer` in a role predicate and are not pinned. If",
      "the predicate decides authority, that shape treats every non-viewer role",
      "as staff, so a `client` passes it -- deny the client role here, or add",
      "the file to VIEWER_SHAPED_AUTHORITY_SITES with a reason. If it decides",
      "something else, add it to VIEWER_SHAPED_NOTICE_SITES with a reason.",
    ].join(" ")).toEqual([]);

    expect(removed, [
      "These modules no longer name `viewer` in a role predicate. For an",
      "authority site that is the goal -- remove it from the inventory so the",
      "gap shrinks and cannot silently regrow.",
    ].join(" ")).toEqual([]);
  });

  it("recognizes every real shape of the viewer-shaped check", () => {
    // Taken verbatim from the modules in the inventory above.
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "membership.membershipRole !== \"viewer\" &&",
    )).toBe(true);
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "eq(companyMemberships.status, \"active\"), ne(companyMemberships.membershipRole, \"viewer\"),",
    )).toBe(true);
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "membership?.status === \"active\" && membership.membershipRole !== \"viewer\"",
    )).toBe(true);
    // The read-only direction is the same hazard: it catches `viewer` by name
    // and therefore lets every other role, including a client, write.
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "if (membership.membershipRole === \"viewer\") throw forbidden(\"read-only\");",
    )).toBe(true);
    // The raw-SQL shape, verbatim from services/voice/voice-session-store.ts.
    // Single-quoted, because the fragment is Postgres and not TypeScript.
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "sql`${companyMemberships.membershipRole} is distinct from 'viewer'`",
    )).toBe(true);
    // Neighbouring raw-SQL spellings of the same decision.
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "sql`${companyMemberships.membershipRole} <> 'viewer'`",
    )).toBe(true);
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "sql`${companyMemberships.membershipRole} = 'viewer'`",
    )).toBe(true);
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "sql`${m.membershipRole} is not distinct from 'viewer'`",
    )).toBe(true);
    // A single-quoted literal in either helper shape counts too, so the
    // detector does not depend on the formatter's quote style holding.
    expect(TESTS_ROLE_AGAINST_VIEWER.test("membership.membershipRole !== 'viewer'")).toBe(true);
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "ne(companyMemberships.membershipRole, 'viewer')",
    )).toBe(true);
    // Not a role decision.
    expect(TESTS_ROLE_AGAINST_VIEWER.test("const label = \"viewer\";")).toBe(false);
    expect(TESTS_ROLE_AGAINST_VIEWER.test("const label = 'viewer';")).toBe(false);
    expect(TESTS_ROLE_AGAINST_VIEWER.test("role === \"client\"")).toBe(false);
    // A role column compared against some other role is a different question
    // and must not be swept in here, or the inventory stops meaning anything.
    expect(TESTS_ROLE_AGAINST_VIEWER.test(
      "eq(companyMemberships.membershipRole, \"owner\")",
    )).toBe(false);
  });
});

/**
 * A third class of hazard, found by auditing the two sweeps above.
 *
 * Both sweeps look at *consumers*: sweep 1 at modules that read an actor's
 * `companyIds`, sweep 2 at modules that compare a role against `viewer`.
 * Neither looks at the *producer*. The deny reads `actor.memberships`, and
 * `isClientMembership` fails open when that data is missing or has no
 * `membershipRole` -- so an actor source that forgets it disables the deny for
 * every route that source can reach, with both sweeps green.
 *
 * That is not hypothetical. The per-event gate in `live-events-ws.ts` leaked
 * exactly this way: it re-read the membership but selected only the id and
 * status, never the role.
 *
 * So the producer side needs its own pin: the set of actor sources, split by
 * whether a source can carry a company membership, and a static check that
 * each membership-bearing source really does select the role column.
 */
describe("the board actor sources classify a client membership", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverSrc = join(here, "..");

  /**
   * Sources whose actor can hold a company membership. Each must populate
   * `actor.memberships` including `membershipRole`, or the deny fails open.
   * The value is the module that builds that actor.
   */
  const MEMBERSHIP_BEARING_SOURCES: Record<string, string> = {
    session: "middleware/auth.ts",
    board_key: "middleware/auth.ts",
    cloud_tenant: "middleware/auth.ts",
    mcp_oauth: "services/public-mcp/oauth.ts",
  };

  /**
   * The modules that read `membership_role` out of the database and hand it to
   * an actor. The four sources above all draw from one of these: `session` and
   * `cloud_tenant` from `loadActiveUserCompanyMemberships` in `auth.ts`,
   * `board_key` and `mcp_oauth` from `resolveBoardAccess` in `board-auth.ts`.
   */
  const ROLE_SUPPLYING_MODULES = [
    "middleware/auth.ts",
    "services/board-auth.ts",
  ] as const;

  /** Sources that are never a company member, with the reason. */
  const NON_MEMBER_SOURCES: Record<string, string> = {
    local_implicit: "on-box CLI; excluded in isClientMembership before the look",
    cloud_control: "Cloud control plane assertion; instance admin, user paperclip-cloud",
    agent_key: "agent actor, not a human membership",
    agent_jwt: "agent actor, not a human membership",
    none: "unauthenticated",
  };

  function declaredSources(): string[] {
    const source = readFileSync(join(serverSrc, "types/express.d.ts"), "utf8");
    const line = source.split("\n").find((text) => /\bsource\?:/.test(text));
    expect(line, "types/express.d.ts should declare the actor source union").toBeTruthy();
    return [...(line as string).matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  }

  it("classifies every declared actor source", () => {
    const unclassified = declaredSources().filter(
      (name) => !(name in MEMBERSHIP_BEARING_SOURCES) && !(name in NON_MEMBER_SOURCES),
    );

    expect(unclassified, [
      "A new actor source was added. Decide whether its actor can hold a company",
      "membership. If it can, populate `memberships` including `membershipRole`",
      "where the actor is built and list it in MEMBERSHIP_BEARING_SOURCES;",
      "if it cannot, list it in NON_MEMBER_SOURCES with the reason.",
    ].join(" ")).toEqual([]);
  });

  it("does not pin a source that no longer exists", () => {
    const declared = new Set(declaredSources());
    const stale = [
      ...Object.keys(MEMBERSHIP_BEARING_SOURCES),
      ...Object.keys(NON_MEMBER_SOURCES),
    ].filter((name) => !declared.has(name));

    expect(stale, "these pinned sources are gone from the union").toEqual([]);
  });

  /**
   * What this asserts, and what it does not: it checks that every module which
   * supplies membership data selects the role column, and that every actor
   * source is classified. It does *not* prove which supplier feeds which
   * source -- a regex cannot follow that, and pretending otherwise would be
   * worse than saying so. A human classified the four above; the source-union
   * pin is what forces that classification to be redone when a source arrives.
   */
  it("selects the membership role in every module that supplies it", () => {
    const missing = ROLE_SUPPLYING_MODULES.filter((module) => {
      const text = readFileSync(join(serverSrc, module), "utf8");
      // The role has to come out of the database, not be defaulted in code.
      return !/membershipRole:\s*companyMemberships\.membershipRole/.test(text);
    });

    expect(missing, [
      "These modules hand membership data to an actor without selecting",
      "`membershipRole`. A membership row without a role reads as staff, so the",
      "client deny silently stops applying for every source they feed.",
    ].join(" ")).toEqual([]);
  });

  it("builds each membership-bearing actor from a role-supplying module", () => {
    const unsourced: string[] = [];
    for (const [sourceName, module] of Object.entries(MEMBERSHIP_BEARING_SOURCES)) {
      const text = readFileSync(join(serverSrc, module), "utf8");
      const suppliesItself = /membershipRole:\s*companyMemberships\.membershipRole/.test(text);
      // board-auth is reached as a service, so match the call rather than an import path.
      const drawsFromSupplier = /resolveBoardAccess\s*\(/.test(text);
      if (!suppliesItself && !drawsFromSupplier) unsourced.push(`${sourceName} (${module})`);
    }

    expect(unsourced, [
      "These modules build a membership-bearing actor without either selecting",
      "the role themselves or drawing it from a role-supplying module.",
    ].join(" ")).toEqual([]);
  });

  /**
   * The fail-open branches, asserted rather than left to be discovered. Both
   * are deliberate -- they keep the four staff roles behaving exactly as they
   * do today -- but they are the reason the pins above have to exist.
   */
  it("treats unclassifiable membership data as staff, not as a client", () => {
    expect(hasClientMembershipFor(undefined, "company-1")).toBe(false);
    expect(hasClientMembershipFor([], "company-1")).toBe(false);
    // A row selected without the role column: the live-events-ws shape.
    expect(hasClientMembershipFor(
      [{ companyId: "company-1", status: "active" }],
      "company-1",
    )).toBe(false);
    // And the case that must still be caught.
    expect(hasClientMembershipFor(
      [{ companyId: "company-1", membershipRole: "client", status: "active" }],
      "company-1",
    )).toBe(true);
  });
});
