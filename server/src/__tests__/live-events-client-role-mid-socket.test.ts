import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, instanceUserRoles, type Db,
} from "@paperclipai/db";
import { hashToken } from "../lib/agent-records.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";

/**
 * The company live event stream authorizes at two separate moments: once when
 * the socket upgrades, and again for every event it delivers. The per-event
 * re-read exists precisely because a membership can change while a socket
 * stays open, so it has to read the membership role and not only the status.
 * A role check that runs only at connect time leaves a demoted member's stream
 * alive for as long as they hold the socket, which is unbounded.
 *
 * These tests drive the real websocket server against a real database and
 * change the role underneath a live socket. They fail if the per-event gate
 * stops reading the role.
 *
 * On proving a negative. Asserting that a socket did *not* receive an event
 * needs some barrier, or the assertion only proves the test looked too early.
 * This file has had two wrong answers to that, so the reasoning is recorded
 * here in full. Please read it before you change the shape of these tests.
 *
 * What is **not** a barrier is another socket. Each connection gets its own
 * delivery object and its own fire-and-forget `drain()` loop, each awaiting its
 * own database reads. A staff socket receiving an event says nothing about
 * where the demoted socket's loop has got to.
 *
 * Same-socket ordering *is* a real property:
 *
 *   - `publishLiveEvent` emits on a synchronous `EventEmitter`, and each
 *     subscriber's listener calls `delivery.enqueue` synchronously, so one
 *     socket's queue receives events in publish order.
 *   - `drain()` in `live-event-delivery.ts` is serial per socket: it holds a
 *     `draining` guard, pulls with `queued.shift()`, and awaits `authorize`
 *     for one item before it takes the next.
 *
 * But it cannot be used the way an earlier version of this file used it. That
 * version restored the role and waited for the demoted socket to deliver a
 * *later* event, then asserted the earlier events were absent. Same-socket
 * ordering does prove those earlier events were already authorized. It does not
 * prove what the role was when they were authorized. `authorize` reads the role
 * at the moment it runs, so if the socket's loop reaches them after the role is
 * restored, it delivers them — which is correct behavior, and the assertion
 * fails on a working deny. That is a random failure, and it is the reason the
 * role is no longer restored before the negative assertion.
 *
 * There is no in-band barrier available while the member is a client, because
 * the deny drops *every* event for that socket and `live-event-delivery.ts`
 * emits nothing on a drop: `authorize` returns null and the item is discarded
 * silently. So the negative below is bounded by two things together:
 *
 *   1. a staff witness socket that confirms each publication really did fan out
 *      (so the demoted socket's queue has certainly received it), and
 *   2. a short settle window after that, which is generous next to the single
 *      indexed membership read that `authorize` performs.
 *
 * This is weaker than an ordering proof and it is deliberately the weaker of
 * two bad options: it can only ever fail to catch a deny that is broken *and*
 * slower than the settle window, whereas the ordering version failed at random
 * on a deny that worked. The role is restored only *after* the negative has
 * been asserted, purely to check that the deny is not a latch. That last step
 * makes no negative assertion, so nothing races with it.
 */
describe("live events re-read the membership role while the socket stays open", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("live-events-client-mid-socket-");
    db = createDb(temporary.connectionString);
  }, 120_000);

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seedCompany(prefix: string, principals: Array<{ id: string; role: string }>) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `Mid socket ${prefix}`, issuePrefix: prefix });
    await db.insert(authUsers).values(principals.map(({ id }) => ({
      id, name: "Fixture member", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(companyMemberships).values(principals.map(({ id, role }) => ({
      companyId, principalType: "user" as const, principalId: id, membershipRole: role, status: "active" as const,
    })));
    return companyId;
  }

  async function setRole(companyId: string, principalId: string, membershipRole: string) {
    await db.update(companyMemberships).set({ membershipRole }).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, principalId),
    ));
    // Assert the write landed. Without this the "still receives" expectations
    // below could pass for the wrong reason — a demotion that never happened.
    const [row] = await db.select({ membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
      .from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, principalId),
      ));
    expect(row).toMatchObject({ membershipRole, status: "active" });
  }

  function connect(port: number, companyId: string, fixtureUser: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws`, {
      headers: { "x-fixture-user": fixtureUser },
    });
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    return { socket, messages };
  }

  /** Publishes one uniquely identifiable company event and returns its marker. */
  function publishMarker(companyId: string) {
    const agentId = randomUUID();
    publishLiveEvent({ companyId, type: "agent.status", payload: { agentId, status: "idle" } });
    return agentId;
  }

  function sawMarker(messages: Array<{ payload: Record<string, unknown> }>, agentId: string) {
    return messages.some(message => message.payload.agentId === agentId);
  }

  /**
   * The settle window described at the top of this file. It runs only after a
   * witness socket has confirmed the publication fanned out, so all that is
   * left for the denied socket is one indexed membership read inside
   * `authorize`. A second is far longer than that read, and the cost of the
   * window is bounded: it is paid twice in this file.
   */
  const SETTLE_MS = 1_000;
  const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  /**
   * Budget for one `expect.poll` barrier, and for a whole case.
   *
   * `vitest.config.ts` sets `testTimeout: 15000`, but a case here can hold up to
   * five of these barriers plus the settle window, so the sum of a case's own
   * waits exceeds the default budget. Every barrier returns in milliseconds on a
   * healthy runner, which is why that went unnoticed; on a loaded one the case
   * would expire before reaching its assertions, which reports a timeout instead
   * of the authorization result the case exists to report. Each case therefore
   * names a timeout above its own worst case, so a slow runner can only ever
   * make a case slow, never red. Raising this is preferable to shortening a
   * barrier: the witness barrier is what makes the negative assertions sound.
   */
  const WAIT_MS = 10_000;
  const CASE_TIMEOUT_MS = 90_000;

  it("stops delivering to a staff member who is changed to client mid-stream", async () => {
    const staff = randomUUID(), demoted = randomUUID();
    const companyId = await seedCompany("MIDSOCKA", [
      { id: staff, role: "operator" },
      { id: demoted, role: "operator" },
    ]);

    const server = createServer();
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      // The cloud path carries the membership list from the upgrade headers, so
      // a stale connect-time snapshot is exactly what the per-event re-read has
      // to defeat. It is handed `operator` and never told about the demotion.
      resolveCloudActor: async (req: IncomingMessage) => {
        const userId = String(req.headers["x-fixture-user"] ?? "");
        if (!userId) return null;
        return { userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: "operator", status: "active" }] };
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const staffClient = connect(port, companyId, staff);
    const demotedClient = connect(port, companyId, demoted);
    try {
      await Promise.all([once(staffClient.socket, "open"), once(demotedClient.socket, "open")]);

      // Both receive while both are staff. This establishes that the demoted
      // socket is genuinely subscribed, so a later silence means a deny and not
      // a socket that never worked.
      const before = publishMarker(companyId);
      await expect.poll(() => sawMarker(staffClient.messages, before)).toBe(true);
      await expect.poll(() => sawMarker(demotedClient.messages, before)).toBe(true);

      await setRole(companyId, demoted, "client");

      // Publish twice while the member is a client, and confirm each
      // publication on the staff socket. That establishes the events really did
      // fan out, so the demoted socket's queue has received them.
      const after = publishMarker(companyId);
      await expect.poll(() => sawMarker(staffClient.messages, after), { timeout: WAIT_MS }).toBe(true);
      const again = publishMarker(companyId);
      await expect.poll(() => sawMarker(staffClient.messages, again), { timeout: WAIT_MS }).toBe(true);

      // Assert the denials while the member is still a client. The role is not
      // restored first, on purpose -- see the note at the top of this file.
      // Two denials, so a deny that dropped only the first event still fails.
      await settle();
      expect(sawMarker(demotedClient.messages, after)).toBe(false);
      expect(sawMarker(demotedClient.messages, again)).toBe(false);
      expect(demotedClient.socket.readyState).toBe(WebSocket.OPEN);

      // Only now restore the role, to show the deny tracks the current role
      // instead of latching the connection shut. This step asserts a positive,
      // so nothing here can race.
      await setRole(companyId, demoted, "operator");
      const restored = publishMarker(companyId);
      await expect.poll(() => sawMarker(demotedClient.messages, restored), { timeout: WAIT_MS }).toBe(true);
    } finally {
      staffClient.socket.close();
      demotedClient.socket.close();
      server.close();
    }
  }, CASE_TIMEOUT_MS);

  /**
   * This case guards against over-denying rather than under-denying, so unlike
   * the one above it passes whether or not the per-event role check is present.
   * It fails only if the check starts denying an instance admin. That is the
   * whole point of it, but it is worth stating: it is not a second proof that
   * the deny exists.
   */
  it("keeps delivering to an instance admin who holds a client membership", async () => {
    const admin = randomUUID();
    const companyId = await seedCompany("MIDSOCKB", [{ id: admin, role: "operator" }]);
    await db.insert(instanceUserRoles).values({ userId: admin, role: "instance_admin" });

    const server = createServer();
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      // The session path, not the cloud path: the instance-admin override is
      // only consulted when the actor source is not `cloud_tenant`.
      resolveSessionFromHeaders: async headers => {
        const userId = headers.get("x-fixture-user");
        return userId ? ({ user: { id: userId } } as never) : null;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const adminClient = connect(port, companyId, admin);
    try {
      await once(adminClient.socket, "open");
      const before = publishMarker(companyId);
      await expect.poll(() => sawMarker(adminClient.messages, before)).toBe(true);

      await setRole(companyId, admin, "client");

      const after = publishMarker(companyId);
      await expect.poll(() => sawMarker(adminClient.messages, after)).toBe(true);
    } finally {
      adminClient.socket.close();
      server.close();
    }
  }, CASE_TIMEOUT_MS);

  /**
   * An agent key is a separate principal class: the socket's key branch
   * authorizes the *agent*, and on `master` it reads no human membership role at
   * all — `viewer` is not checked there either. For the staff roles that is
   * consistent, because each of them carries company access anyway. It is not
   * consistent with a deny-by-default `client`, because it leaves one way to
   * hold a company event stream as a client: mint an unscoped key while staff,
   * then be changed to `client` and keep using the key as a bearer token.
   *
   * This case bounds its negative the same way as the first one, and for the
   * same reason -- see the note at the top of this file.
   */
  it("stops delivering to an agent key whose responsible user is changed to client", async () => {
    const responsible = randomUUID(), witness = randomUUID();
    const companyId = await seedCompany("MIDSOCKC", [
      { id: responsible, role: "operator" },
      { id: witness, role: "operator" },
    ]);

    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", role: "engineer" });
    // Unscoped (`scopeConfig: null`) on purpose: the upgrade path refuses a
    // scoped key outright, so a scoped one would pass this test without the
    // role check ever being reached.
    const token = `pcp_${randomUUID().replace(/-/g, "")}`;
    await db.insert(agentApiKeys).values({
      id: randomUUID(), agentId, companyId, name: "Fixture key",
      keyHash: hashToken(token), responsibleUserId: responsible, scopeConfig: null,
    });

    const server = createServer();
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      // Only the witness board socket uses this; the key socket carries a token
      // and never reaches the session path.
      resolveSessionFromHeaders: async headers => {
        const userId = headers.get("x-fixture-user");
        return userId ? ({ user: { id: userId } } as never) : null;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws?token=${token}`,
    );
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    // A staff socket that stays staff throughout. It is *not* a barrier for the
    // key socket -- see the note at the top of this file -- it is only how the
    // test confirms each publication really fanned out, so the key socket's
    // queue has certainly received it before the settle window starts.
    const witnessClient = connect(port, companyId, witness);
    try {
      await Promise.all([once(socket, "open"), once(witnessClient.socket, "open")]);

      // Receives while the responsible user is staff, which proves the key
      // socket is genuinely subscribed before anything is denied.
      const before = publishMarker(companyId);
      await expect.poll(() => sawMarker(messages, before)).toBe(true);

      await setRole(companyId, responsible, "client");
      const denied = publishMarker(companyId);
      await expect.poll(() => sawMarker(witnessClient.messages, denied), { timeout: WAIT_MS }).toBe(true);
      const deniedAgain = publishMarker(companyId);
      await expect.poll(() => sawMarker(witnessClient.messages, deniedAgain), { timeout: WAIT_MS }).toBe(true);

      // Assert the denials while the responsible user is still a client, before
      // the role is restored -- see the note at the top of this file.
      await settle();
      expect(sawMarker(messages, denied)).toBe(false);
      expect(sawMarker(messages, deniedAgain)).toBe(false);
      expect(socket.readyState).toBe(WebSocket.OPEN);

      // Restore the role to show the key's stream resumes, so the deny is not a
      // latch. A positive assertion, so nothing here can race.
      await setRole(companyId, responsible, "operator");
      const restored = publishMarker(companyId);
      await expect.poll(() => sawMarker(messages, restored), { timeout: WAIT_MS }).toBe(true);
    } finally {
      socket.close();
      witnessClient.socket.close();
      server.close();
    }
  }, CASE_TIMEOUT_MS);

  /**
   * Guards the narrowing above: a key with no responsible user has no human
   * role to read, so it must keep behaving exactly as it does on `master`.
   * Without this, "deny when the responsible user is a client" could quietly
   * become "deny every key whose responsible user row is missing".
   */
  it("keeps delivering to an agent key that names no responsible user", async () => {
    const companyId = await seedCompany("MIDSOCKD", [{ id: randomUUID(), role: "operator" }]);

    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Unattributed agent", role: "engineer" });
    const token = `pcp_${randomUUID().replace(/-/g, "")}`;
    await db.insert(agentApiKeys).values({
      id: randomUUID(), agentId, companyId, name: "Unattributed key",
      keyHash: hashToken(token), responsibleUserId: null, scopeConfig: null,
    });

    const server = createServer();
    setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws?token=${token}`,
    );
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    try {
      await once(socket, "open");
      const marker = publishMarker(companyId);
      await expect.poll(() => sawMarker(messages, marker)).toBe(true);
    } finally {
      socket.close();
      server.close();
    }
  }, CASE_TIMEOUT_MS);
});
