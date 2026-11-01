import { reconcileDatabaseWork } from "@paperclipai/db";
import { idleWorkSnapshot } from "./task-admission.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { discordCommandSchedule } from "./chat-channels/discord/command-schedule.js";
import { registerDiscordCommandWork } from "./chat-channels/discord/command-work.js";
import { notifyDiscordCommandRegistration } from "./chat-channels/discord/command-work-notifications.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  chatActions,
  chatDiscordCommandOwners,
  chatEndpoints,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { discordPaperclipCommandDefinition } from "./chat-discord-command-registration.js";
import {
  readDiscordCommandRegistrationDeadline,
  readRegisteredDiscordCommandRegistration,
  reconcileStoredDiscordCommandRegistration,
  type StoredDiscordCommandRegistrationOptions,
} from "./chat-discord-command-registration-store.js";

const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = external
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const token = "PRIVATE-DISCORD-REGISTRATION-TOKEN";
let serial = 0n;
const appId = () =>
  String(1_400_000_000_000_000_000n + BigInt(Date.now()) + ++serial);

suite("Discord command ownership store (real PostgreSQL, no network)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary:
    Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) db = createDb(external);
    else {
      temporary = await startEmbeddedPostgresTestDatabase(
        "paperclip-discord-command-store-",
      );
      db = createDb(temporary.connectionString);
    }
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  async function scheduled(companyId: string, reconcile: (id: string) => Promise<void>, canRun = () => true) {
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select 1`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatCommandRegistration);
    const service = discordCommandSchedule(db, reconcile);
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun, canReconcile: () => true, onError: error => errors.push(error) });
    const worker = registerDiscordCommandWork(coordinator, {
      ...service,
      load: (scope, signal) => service.load(scope ?? { kind: "company", id: companyId }, signal),
    }, canRun);
    await worker.ready;
    return { service, errors };
  }
  async function sqlQuiet(milliseconds: number) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), execute = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(milliseconds);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); execute.mockRestore();
  }

  async function fixture(applicationId = appId()) {
    const companyId = randomUUID(),
      endpointId = randomUUID(),
      agentId = randomUUID();
    const application = randomUUID(),
      connection = randomUUID();
    const scope = { companyId, endpointId, applicationId, guildId: appId() };
    await db.insert(companies).values({
      id: companyId,
      name: "Registration fixture",
      issuePrefix: `D${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Discord agent",
      adapterType: "codex_local",
    });
    await db
      .insert(toolApplications)
      .values({ id: application, companyId, name: "Discord", type: "chat" });
    await db.insert(toolConnections).values({
      id: connection,
      companyId,
      applicationId: application,
      uid: randomUUID(),
      name: "Discord",
      transport: "chat_sdk",
      connectionPurpose: "channel",
      enabled: true,
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId,
      connectionId: connection,
      provider: "discord",
      publicId: randomUUID(),
      assignedAgentId: agentId,
      status: "active",
      providerAccountId: scope.guildId,
      botExternalId: applicationId,
    });
    const remote: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    let beforeResponse: ((method: string) => Promise<void>) | undefined;
    let revoked = false;
    const options: StoredDiscordCommandRegistrationOptions = {
      scope,
      runtimeFence: { generation: 1, credentialFingerprint: "a".repeat(64) },
      botToken: token,
      authorize: async (tx) => {
        const [endpoint] = await tx
          .select()
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.id, endpointId),
              eq(chatEndpoints.companyId, companyId),
            ),
          )
          .for("update");
        const [current] = await tx
          .select()
          .from(toolConnections)
          .where(eq(toolConnections.id, connection))
          .for("update");
        if (
          revoked ||
          !endpoint ||
          !["active", "verifying", "attention"].includes(endpoint.status) ||
          endpoint.botExternalId !== applicationId ||
          endpoint.providerAccountId !== scope.guildId ||
          !current?.enabled
        )
          throw new Error("PRIVATE-AUTHORIZATION-DETAIL");
      },
      fetch: vi.fn(async (_url, init) => {
        const method = init?.method ?? "GET";
        calls.push(method);
        // Exact source row locks must be released before provider I/O.
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
          await tx
            .select()
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, endpointId))
            .for("update");
        });
        if (method === "GET") {
          await beforeResponse?.(method);
          return Response.json(remote);
        }
        const definition = JSON.parse(String(init?.body));
        const command = {
          ...definition,
          id: "1555555555555555555",
          application_id: applicationId,
          version: "1555555555555555556",
        };
        remote.splice(0, remote.length, command);
        await beforeResponse?.(method);
        return Response.json(command);
      }),
    };
    const read = () =>
      db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.endpointId, endpointId),
            eq(chatActions.kind, "discord_command_registration"),
          ),
        )
        .then((rows) => rows[0]);
    const due = async () => {
      const row = await read();
      await db
        .update(chatActions)
        .set({ result: { ...row!.result, retryAt: new Date(0).toISOString() } })
        .where(eq(chatActions.id, row!.id));
    };
    return {
      scope,
      options,
      calls,
      remote,
      read,
      due,
      reconcile: () => reconcileStoredDiscordCommandRegistration(db, options),
      revoke: () => {
        revoked = true;
      },
      beforeResponse: (callback: typeof beforeResponse) => {
        beforeResponse = callback;
      },
    };
  }

  it("atomically claims one global owner before HTTP and records only exact closed receipts", async () => {
    const f = await fixture();
    const phases: string[] = [];
    f.options.onState = async (tx, state) => {
      phases.push(state.phase);
      const [owner] = await tx
        .select()
        .from(chatDiscordCommandOwners)
        .where(
          eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
        );
      expect(owner).toMatchObject({
        companyId: f.scope.companyId,
        endpointId: f.scope.endpointId,
      });
      const [action] = await tx
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, owner!.actionId));
      expect(action!.payload.registration).toEqual(state);
    };
    expect(await f.reconcile()).toMatchObject({ kind: "registered" });
    expect(phases).toEqual(["prepared", "attempted", "registered"]);
    expect(f.calls).toEqual(["GET", "POST"]);
    const read = await readRegisteredDiscordCommandRegistration(db, f.scope);
    expect(read).toMatchObject({
      phase: "registered",
      receipt: { commandId: "1555555555555555555" },
    });
    expect(
      JSON.stringify([
        await f.read(),
        await db.select().from(chatDiscordCommandOwners),
      ]),
    ).not.toContain(token);
    expect(await f.reconcile()).toEqual({ kind: "deferred" });
    f.options.force = true;
    expect(await f.reconcile()).toMatchObject({ kind: "registered" });
    expect(f.calls).toEqual(["GET", "POST", "GET"]);
  });

  it("keeps prior-copy authority unavailable until its exact owned remote definition is durably upgraded", async () => {
    const f = await fixture();
    expect(await f.reconcile()).toMatchObject({ kind: "registered" });
    const original = await f.read();
    const registration = original!.payload.registration as {
      ownerId: string;
      receipt: Record<string, unknown>;
    };
    const prior = discordPaperclipCommandDefinition(registration.ownerId);
    prior.options[2]!.description = "Close the current Paperclip task";
    const remote = f.remote[0]!;
    f.remote[0] = {
      ...prior,
      id: remote.id,
      application_id: remote.application_id,
      version: remote.version,
    };
    await db
      .update(chatActions)
      .set({
        payload: {
          registration: {
            ...registration,
            receipt: {
              ...registration.receipt,
              definitionDigest: createHash("sha256")
                .update(JSON.stringify(prior))
                .digest("hex"),
            },
          },
        },
      })
      .where(eq(chatActions.id, original!.id));
    await f.due();
    expect(
      await readRegisteredDiscordCommandRegistration(db, f.scope),
    ).toBeNull();
    f.calls.length = 0;
    expect(await f.reconcile()).toMatchObject({ kind: "registered" });
    expect(f.calls).toEqual(["GET", "PATCH"]);
    const current = await f.read();
    expect(current!.id).toBe(original!.id);
    expect(
      await readRegisteredDiscordCommandRegistration(db, f.scope),
    ).toMatchObject({
      ownerId: registration.ownerId,
      receipt: { commandId: remote.id },
    });
    expect(f.remote[0]).toMatchObject(
      discordPaperclipCommandDefinition(registration.ownerId),
    );
  });

  it("serializes concurrent initial claim and never duplicates the POST", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.reconcile(),
      f.reconcile(),
      f.reconcile(),
    ]);
    expect(results.filter((r) => r.kind === "registered")).toHaveLength(1);
    expect(f.calls.filter((method) => method === "POST")).toHaveLength(1);
    expect(
      await db
        .select()
        .from(chatDiscordCommandOwners)
        .where(
          eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
        ),
    ).toHaveLength(1);
    expect(await f.read()).toMatchObject({ status: "processed" });
  });

  it.each(["prepared", "attempted", "registered"] as const)(
    "rolls back failed %s projection without a false receipt",
    async (phase) => {
      const f = await fixture();
      f.options.onState = async (_tx, state) => {
        if (state.phase === phase) throw new Error("PRIVATE-PROJECTION-ERROR");
      };
      const result = await f.reconcile();
      expect(result.kind).toBe(
        phase === "registered" ? "unknown" : "unavailable",
      );
      expect(f.calls.filter((method) => method === "POST")).toHaveLength(
        phase === "registered" ? 1 : 0,
      );
      const row = await f.read();
      if (phase === "prepared") {
        expect(row).toBeUndefined();
        expect(
          await db
            .select()
            .from(chatDiscordCommandOwners)
            .where(
              eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
            ),
        ).toEqual([]);
      } else
        expect(row).toMatchObject({
          status: "received",
          payload: {
            registration: {
              phase: phase === "attempted" ? "prepared" : "attempted",
            },
          },
        });
      expect(
        await readRegisteredDiscordCommandRegistration(db, f.scope),
      ).toBeNull();
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
    },
  );

  it("denies revoked current authority before claiming and again between intent and HTTP", async () => {
    const first = await fixture();
    first.revoke();
    expect(await first.reconcile()).toMatchObject({ kind: "unavailable" });
    expect(await first.read()).toBeUndefined();
    expect(first.calls).toEqual([]);
    const f = await fixture();
    f.options.onState = async (_tx, state) => {
      if (state.phase === "attempted") f.revoke();
    };
    expect(await f.reconcile()).toMatchObject({ kind: "unknown" });
    expect(f.calls).toEqual(["GET"]);
    expect(await f.read()).toMatchObject({
      payload: { registration: { phase: "attempted" } },
    });
  });

  it("rejects an exact descriptor CAS conflict before provider write", async () => {
    const f = await fixture();
    f.beforeResponse(async (method) => {
      if (method !== "GET") return;
      const row = await f.read();
      await db
        .update(chatActions)
        .set({
          payload: {
            registration: {
              ...(row!.payload.registration as object),
              ownerId: "f".repeat(32),
            },
          },
        })
        .where(eq(chatActions.id, row!.id));
    });
    expect(await f.reconcile()).toMatchObject({ kind: "unavailable" });
    expect(f.calls).toEqual(["GET"]);
    expect(
      await readRegisteredDiscordCommandRegistration(db, f.scope),
    ).toBeNull();
  });

  it.each([true, false])(
    "restarts an uncertain POST using only GET (remote present=%s)",
    async (present) => {
      const f = await fixture();
      f.beforeResponse(async (method) => {
        if (method === "POST") throw new Error("PRIVATE-UNCERTAIN-WRITE");
      });
      expect(await f.reconcile()).toMatchObject({ kind: "unknown" });
      expect(await f.read()).toMatchObject({
        status: "received",
        payload: { registration: { phase: "attempted" } },
      });
      if (!present) f.remote.length = 0;
      f.beforeResponse(undefined);
      f.options.force = true;
      expect(await f.reconcile()).toEqual({ kind: "deferred" });
      await f.due();
      expect(await f.reconcile()).toMatchObject({
        kind: present ? "registered" : "unknown",
      });
      expect(f.calls).toEqual(["GET", "POST", "GET"]);
    },
  );

  it.each(["archive", "delete_company", "delete_endpoint"] as const)(
    "retains app ownership across %s and refuses a different company",
    async (mode) => {
      const old = await fixture();
      old.beforeResponse(async (method) => {
        if (method === "POST") throw new Error("unknown");
      });
      expect(await old.reconcile()).toMatchObject({ kind: "unknown" });
      const [owner] = await db
        .select()
        .from(chatDiscordCommandOwners)
        .where(
          eq(chatDiscordCommandOwners.applicationId, old.scope.applicationId),
        );
      if (mode === "archive")
        await db
          .update(chatEndpoints)
          .set({ status: "archived" })
          .where(eq(chatEndpoints.id, old.scope.endpointId));
      else if (mode === "delete_company") {
        // Respect the current endpoint -> assigned-agent RESTRICT relation while
        // removing all company-owned fixture data; the instance tombstone alone survives.
        await db
          .delete(chatEndpoints)
          .where(eq(chatEndpoints.companyId, old.scope.companyId));
        await db
          .delete(agents)
          .where(eq(agents.companyId, old.scope.companyId));
        await db.delete(companies).where(eq(companies.id, old.scope.companyId));
      } else
        await db
          .delete(chatEndpoints)
          .where(eq(chatEndpoints.id, old.scope.endpointId));
      const next = await fixture(old.scope.applicationId);
      expect(await next.reconcile()).toEqual({
        kind: "conflict",
        reason: "unowned_namespace",
      });
      expect(next.calls).toEqual([]);
      expect(await next.read()).toBeUndefined();
      const [retained] = await db
        .select()
        .from(chatDiscordCommandOwners)
        .where(
          eq(chatDiscordCommandOwners.applicationId, old.scope.applicationId),
        );
      expect(retained).toEqual(owner);
      expect(
        await readRegisteredDiscordCommandRegistration(db, next.scope),
      ).toBeNull();
    },
  );

  it("never recreates an action missing beneath its exact surviving tombstone", async () => {
    const f = await fixture();
    await f.reconcile();
    const row = await f.read();
    await db.delete(chatActions).where(eq(chatActions.id, row!.id));
    f.options.force = true;
    expect(await f.reconcile()).toEqual({
      kind: "conflict",
      reason: "unowned_namespace",
    });
    expect(f.calls).toEqual(["GET", "POST"]);
    expect(await f.read()).toBeUndefined();
  });

  it("honors the full 429 retry_after and does not persist provider prose", async () => {
    const f = await fixture();
    f.options.fetch = vi.fn(async () =>
      Response.json({ retry_after: 601.125, private: token }, { status: 429 }),
    );
    const before = Date.now();
    expect(await f.reconcile()).toMatchObject({
      kind: "unavailable",
      retryAfterSeconds: 601.125,
    });
    const row = await f.read();
    expect(Date.parse(String(row!.result!.retryAt))).toBeGreaterThanOrEqual(
      before + 601_125,
    );
    expect(JSON.stringify(row)).not.toContain(token);
    f.options.force = true;
    expect(await f.reconcile()).toEqual({ kind: "deferred" });
    expect(f.options.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not advertise a retained receipt after remote namespace conflict", async () => {
    const f = await fixture();
    await f.reconcile();
    f.remote[0] = {
      ...f.remote[0],
      ...discordPaperclipCommandDefinition("b".repeat(32)),
    };
    f.options.force = true;
    expect(await f.reconcile()).toMatchObject({ kind: "conflict" });
    expect(
      await readRegisteredDiscordCommandRegistration(db, f.scope),
    ).toBeNull();
    expect(f.calls).toEqual(["GET", "POST", "GET"]);
  });

  it("refuses registration history without its original global tombstone", async () => {
    const f = await fixture();
    await f.reconcile();
    const before = await f.read();
    await db
      .delete(chatDiscordCommandOwners)
      .where(eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId));
    f.options.force = true;
    expect(await f.reconcile()).toEqual({
      kind: "conflict",
      reason: "unowned_namespace",
    });
    expect(await f.read()).toEqual(before);
    expect(f.calls).toEqual(["GET", "POST"]);
    expect(
      await db
        .select()
        .from(chatDiscordCommandOwners)
        .where(
          eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
        ),
    ).toEqual([]);
  });

  it.each(["generation", "fingerprint", "token"] as const)(
    "validates %s before committing a namespace claim",
    async (field) => {
      const f = await fixture();
      if (field === "generation") f.options.runtimeFence.generation = -1;
      else if (field === "fingerprint")
        f.options.runtimeFence.credentialFingerprint = "invalid";
      else f.options.botToken = "invalid\r\ncredential";
      expect(await f.reconcile()).toMatchObject({ kind: "unavailable" });
      expect(f.calls).toEqual([]);
      expect(await f.read()).toBeUndefined();
      expect(
        await db
          .select()
          .from(chatDiscordCommandOwners)
          .where(
            eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
          ),
      ).toEqual([]);
    },
  );

  it("holds an unrepresentable 429 retry indefinitely rather than overflowing to an earlier retry", async () => {
    const f = await fixture();
    f.options.fetch = vi.fn(async () =>
      Response.json({ retry_after: Number.MAX_SAFE_INTEGER }, { status: 429 }),
    );
    expect(await f.reconcile()).toMatchObject({
      kind: "unavailable",
      retryAfterSeconds: Number.MAX_SAFE_INTEGER,
    });
    expect((await f.read())!.result).toMatchObject({
      retryIndefinite: true,
      retryAt: "+275760-09-13T00:00:00.000Z",
    });
    f.options.force = true;
    await f.due(); // Even a scheduler's expired date is not new authority.
    expect(await f.reconcile()).toEqual({ kind: "deferred" });
    expect(f.options.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "status", "descriptor", "outcome"] as const)(
    "reader denies changed %s instead of trusting the public command ID",
    async (field) => {
      const f = await fixture();
      await f.reconcile();
      const row = await f.read();
      if (field === "owner")
        await db
          .update(chatDiscordCommandOwners)
          .set({ actionId: randomUUID() })
          .where(
            eq(chatDiscordCommandOwners.applicationId, f.scope.applicationId),
          );
      else if (field === "status")
        await db
          .update(chatActions)
          .set({ status: "received" })
          .where(eq(chatActions.id, row!.id));
      else if (field === "descriptor")
        await db
          .update(chatActions)
          .set({
            payload: {
              registration: {
                ...(row!.payload.registration as object),
                scope: { ...f.scope, guildId: appId() },
              },
            },
          })
          .where(eq(chatActions.id, row!.id));
      else
        await db
          .update(chatActions)
          .set({ result: { ...row!.result, outcome: "unknown" } })
          .where(eq(chatActions.id, row!.id));
      expect(
        await db.transaction(async (tx) => {
          await f.options.authorize(tx);
          return readRegisteredDiscordCommandRegistration(tx, f.scope, true);
        }),
      ).toBeNull();
      expect(f.calls).toEqual(["GET", "POST"]);
    },
  );
  it("exposes saved verification and retry deadlines without contacting the provider", async () => {
    const f = await fixture();
    expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBe(0);
    expect(f.calls).toEqual([]);
    expect(await f.reconcile()).toMatchObject({ kind: "registered" });
    const row = await f.read();
    const due = Date.parse(String(row!.result!.retryAt));
    expect(due).toBeGreaterThan(Date.now() + 290_000);
    expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBe(due);
    expect(f.calls).toEqual(["GET", "POST"]);
    const retriedAt = new Date(Date.now() + 601_125).toISOString();
    await db.update(chatActions).set({ result: { ...row!.result, outcome: "unavailable", retryAt: retriedAt } })
      .where(eq(chatActions.id, row!.id));
    expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBe(Date.parse(retriedAt));
    expect(f.calls).toEqual(["GET", "POST"]);
  });
  it("parks indefinite and malformed retry records without inventing an earlier deadline", async () => {
    const f = await fixture(); await f.reconcile(); const row = (await f.read())!;
    for (const result of [
      { ...row.result, retryAt: "+275760-09-13T00:00:00.000Z", retryIndefinite: true },
      { ...row.result, retryAt: "invalid" },
      { ...row.result, schema: "unknown" },
    ]) {
      await db.update(chatActions).set({ result }).where(eq(chatActions.id, row.id));
      expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBeNull();
    }
    expect(f.calls).toEqual(["GET", "POST"]);
  });
  it("does not schedule ownership tombstones or another endpoint's registration", async () => {
    const f = await fixture(); await f.reconcile();
    await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, f.scope.endpointId));
    const other = await fixture(f.scope.applicationId);
    expect(await readDiscordCommandRegistrationDeadline(db, other.scope)).toBeNull();
    await db.delete(chatActions).where(eq(chatActions.id, (await f.read())!.id));
    expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBeNull();
    expect(await readDiscordCommandRegistrationDeadline(db, other.scope)).toBeNull();
    expect(other.calls).toEqual([]);
  });
  it("retains the stored retry deadline for an uncertain provider write", async () => {
    const f = await fixture();
    f.beforeResponse(async method => { if (method === "POST") throw new Error("lost response"); });
    expect(await f.reconcile()).toMatchObject({ kind: "unknown" });
    const row = (await f.read())!;
    expect(row.payload.registration).toMatchObject({ phase: "attempted" });
    expect(await readDiscordCommandRegistrationDeadline(db, f.scope)).toBe(Date.parse(String(row.result!.retryAt)));
    expect(f.calls).toEqual(["GET", "POST"]);
  });

  it("leaves no deadline or SQL after an empty registration inventory", async () => {
    const reconcile = vi.fn();
    const { errors } = await scheduled(randomUUID(), reconcile);
    expect(coordinator!.nextWakeAt()).toBeNull();
    await sqlQuiet(180_000);
    expect(reconcile).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });
  it("reconstructs a registered verification deadline and stays quiet until it is due", async () => {
    const f = await fixture(); await f.reconcile();
    const due = Date.parse(String((await f.read())!.result!.retryAt));
    const { errors } = await scheduled(f.scope.companyId, async () => { await f.reconcile(); });
    expect(coordinator!.nextWakeAt()).toBe(due);
    await sqlQuiet(120_000);
    expect(f.calls).toEqual(["GET", "POST"]);
    await vi.advanceTimersByTimeAsync(due - Date.now());
    await vi.waitFor(() => expect(f.calls).toEqual(["GET", "POST", "GET"]));
    await vi.waitFor(async () => expect(Date.parse(String((await f.read())!.result!.retryAt))).toBeGreaterThan(due));
    expect(errors).toEqual([]);
  });
  it("keeps indefinite holds quiet and respects disabled endpoint eligibility", async () => {
    const f = await fixture(); await f.reconcile(); const row = (await f.read())!;
    await db.update(chatActions).set({ result: { ...row.result, retryIndefinite: true } }).where(eq(chatActions.id, row.id));
    const reconcile = vi.fn();
    const { service, errors } = await scheduled(f.scope.companyId, reconcile);
    await sqlQuiet(600_000); expect(coordinator!.nextWakeAt()).toBeNull();
    await db.update(chatActions).set({ result: { ...row.result, retryAt: new Date(0).toISOString() } }).where(eq(chatActions.id, row.id));
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.scope.endpointId));
    expect(await service.check(f.scope.endpointId)).toBeNull();
    expect(reconcile).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });
  it("honors outer rollback and wakes from committed endpoint changes after drain", async () => {
    const f = await fixture();
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.scope.endpointId));
    let draining = false;
    const { errors } = await scheduled(f.scope.companyId, async () => { await f.reconcile(); }, () => !draining);
    const activate = async (tx: typeof db) => {
      await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: f.scope.endpointId });
      await tx.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.scope.endpointId));
    };
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => activate(nested as unknown as typeof db));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.calls).toEqual([]);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await vi.advanceTimersByTimeAsync(60_000);
    // A running sweep has already consumed its timer. Wait for its SQL and
    // transaction reconciliation to settle before measuring idle traffic.
    await vi.waitFor(() => {
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    });
    await sqlQuiet(60_000);
    draining = true;
    await db.transaction(async tx => activate(tx as unknown as typeof db));
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    const drained = idleWorkSnapshot();
    await sqlQuiet(90_000); expect(idleWorkSnapshot()).toEqual(drained); expect(f.calls).toEqual([]);
    draining = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(f.calls).toEqual(["GET", "POST"]));
    expect(errors).toEqual([]);
  });
  it("rechecks persisted eligibility before a due provider call", async () => {
    const f = await fixture(); await f.reconcile();
    const { service, errors } = await scheduled(f.scope.companyId, async () => { await f.reconcile(); });
    await f.due();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id,
      (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.scope.endpointId)))[0].connectionId));
    expect(await service.check(f.scope.endpointId)).toBeNull();
    expect(f.calls).toEqual(["GET", "POST"]); expect(errors).toEqual([]);
  });

  it("backs off an attempt that cannot advance its durable state", async () => {
    const f = await fixture();
    const reconcile = vi.fn(async () => {});
    const { errors } = await scheduled(f.scope.companyId, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(errors).toHaveLength(2));
    await sqlQuiet(30_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(3));
    expect(await f.read()).toBeUndefined();
  });
  it("joins an admitted provider attempt during shutdown", async () => {
    const f = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.beforeResponse(async method => { if (method === "GET") await held; });
    const starting = scheduled(f.scope.companyId, async () => { await f.reconcile(); });
    await vi.waitFor(() => expect(f.calls).toEqual(["GET"]));
    let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await stopping; const { errors } = await starting;
    expect(stopped).toBe(true);
    expect(await f.read()).toMatchObject({ status: "processed" });
    expect(coordinator!.nextWakeAt()).toBeNull(); expect(errors).toEqual([]);
  });

  it("retains a committed eligibility change while the provider attempt is in flight", async () => {
    const f = await fixture(); await f.reconcile(); await f.due();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.beforeResponse(async method => { if (method === "GET") await held; });
    const starting = scheduled(f.scope.companyId, async () => { await f.reconcile(); });
    try {
      await vi.waitFor(() => expect(f.calls).toEqual(["GET", "POST", "GET"]));
      await db.transaction(async tx => {
        await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: f.scope.endpointId });
        await tx.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.scope.endpointId));
      });
    } finally { release(); }
    const { errors } = await starting;
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await sqlQuiet(120_000);
    expect(f.calls).toEqual(["GET", "POST", "GET"]); expect(errors).toEqual([]);
  });

  it("checks a quiet company's due command in the first batch despite another company's backlog", async () => {
    await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatCommandRegistration);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const entries = Array.from({ length: 30 }, (_, index) => ({
      id: `busy-${index.toString().padStart(2, "0")}`, companyId: "busy", connectionId: "busy-connection", dueAt: 0,
    }));
    entries.push({ id: "quiet", companyId: "quiet", connectionId: "quiet-connection", dueAt: 1 });
    const check = vi.fn(async (id: string) => ({ ...entries.find(entry => entry.id === id)!, dueAt: Date.now() + 300_000 }));
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await registerDiscordCommandWork(coordinator, { load: async () => entries, check }, () => true).ready;
    expect(check).toHaveBeenCalledTimes(25);
    expect(check.mock.calls.map(call => call[0])).toContain("quiet");
    expect(errors).toEqual([]);
  });

  it("drains a large due backlog without a thirty-second delay between bounded batches", async () => {
    await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatCommandRegistration);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const entries = Array.from({ length: 300 }, (_, index) => ({
      id: `command-${index}`, companyId: `company-${index % 10}`, connectionId: `connection-${index}`, dueAt: 0,
    }));
    const check = vi.fn(async (id: string) => ({ ...entries.find(entry => entry.id === id)!, dueAt: Date.now() + 300_000 }));
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await registerDiscordCommandWork(coordinator, { load: async () => entries, check }, () => true).ready;
    expect(check).toHaveBeenCalledTimes(25);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledTimes(300);
    expect(new Set(check.mock.calls.map(([id]) => id)).size).toBe(300);
    await sqlQuiet(120_000);
    expect(check).toHaveBeenCalledTimes(300);
    expect(errors).toEqual([]);
  });

  it("drains healthy commands promptly while one entry remains in failure backoff", async () => {
    await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatCommandRegistration);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const entries = Array.from({ length: 300 }, (_, index) => ({
      id: `command-${index}`, companyId: `company-${index % 10}`, connectionId: `connection-${index}`, dueAt: 0,
    }));
    const check = vi.fn(async (id: string) => {
      if (id === "command-0") throw new Error("Unavailable credential");
      return { ...entries.find(entry => entry.id === id)!, dueAt: Date.now() + 300_000 };
    });
    const onError = vi.fn();
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    await registerDiscordCommandWork(coordinator, { load: async () => entries, check }, () => true).ready;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new Set(check.mock.calls.map(([id]) => id)).size).toBe(300);
    expect(check.mock.calls.filter(([id]) => id === "command-0")).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(check.mock.calls.filter(([id]) => id === "command-0")).toHaveLength(2);
    expect(check.mock.calls.filter(([id]) => id !== "command-0")).toHaveLength(299);
  });
  it("recovers queued scopes after an unknown hint instead of dropping the wake", async () => {
    await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatCommandRegistration);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const entry = { id: "endpoint", companyId: "company", connectionId: "connection", dueAt: 0 };
    let owed = false;
    const check = vi.fn(async () => { owed = false; return null; });
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await registerDiscordCommandWork(coordinator, { load: async () => owed ? [entry] : [], check }, () => true).ready;
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatCommandRegistration, "unknown:legacy");
      await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: entry.id });
      owed = true;
    });
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(errors).toHaveLength(1);
    }, { timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await sqlQuiet(120_000);
    expect(errors).toHaveLength(1);
  });

});
