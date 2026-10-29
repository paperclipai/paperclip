import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers, companies, companyMemberships, createDb, instanceUserRoles, type Db,
} from "@paperclipai/db";
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

      // The staff socket is the barrier: once it has the marker, the publish and
      // its authorization pass are complete for every subscriber, so the absence
      // of the marker on the demoted socket is a decision rather than a race.
      const after = publishMarker(companyId);
      await expect.poll(() => sawMarker(staffClient.messages, after)).toBe(true);
      expect(sawMarker(demotedClient.messages, after)).toBe(false);

      // The socket stays open and subscribed; it is the events that are denied.
      expect(demotedClient.socket.readyState).toBe(WebSocket.OPEN);

      // A second publish confirms the deny holds rather than dropping one event.
      const again = publishMarker(companyId);
      await expect.poll(() => sawMarker(staffClient.messages, again)).toBe(true);
      expect(sawMarker(demotedClient.messages, again)).toBe(false);

      // Restoring the role restores delivery, so the deny tracks the current
      // role and is not a one-way latch on the connection.
      await setRole(companyId, demoted, "operator");
      const restored = publishMarker(companyId);
      await expect.poll(() => sawMarker(demotedClient.messages, restored)).toBe(true);
    } finally {
      staffClient.socket.close();
      demotedClient.socket.close();
      server.close();
    }
  });

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
  });
});
