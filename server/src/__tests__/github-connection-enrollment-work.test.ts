import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { setImmediate as yieldForIo } from "node:timers/promises";
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID, verify } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, connectionEventDeliveries, connectionGrants, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { registerGitHubConnectionEventWork } from "../services/github-connection-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { wakeConnectionEvents } from "../services/connection-event-wake.js";
import { completePaperclipCloudConnectorEnrollment, loadPaperclipCloudConnectorIdentity, startPaperclipCloudConnectorEnrollment } from "../services/paperclip-cloud-connector-enrollment.js";
import { paperclipCloudConnectorIdentityPath } from "../services/paperclip-cloud-connector-enrollment.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub enrollment on a live event worker (real PostgreSQL and signed loopback Cloud)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-live-enrollment-");
    db = createDb(temporary.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("enrolls without recreation, drains an authenticated event, forgets removed identity and re-enrolls from quiet", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-live-enrollment-"));
    const previous = { home: process.env.PAPERCLIP_HOME, instance: process.env.PAPERCLIP_INSTANCE_ID };
    process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_INSTANCE_ID = "enrollment-worker";
    let server: Server | undefined;
    let worker: ReturnType<typeof registerGitHubConnectionEventWork> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    const errors: unknown[] = [], httpErrors: unknown[] = [];
    let requests = 0, acknowledged = 0, leases = 0, enrollment: Record<string, string> | undefined;
    let origin = "", eventId = randomUUID(), grantId = "", companyId = "";
    const identities: string[] = [];
    const delivered = new Set<string>();
    let releaseReplacementAck!: () => void;
    const replacementAck = new Promise<void>(resolve => { releaseReplacementAck = resolve; });
    try {
      server = createServer(async (req, res) => {
        try {
          requests++;
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (req.url === "/v1/connector/enrollments") {
            enrollment = body;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ enrollmentId: "enrollment", verificationUrl: `${origin}/connections/enroll?id=enrollment`, expiresAt: new Date(Date.now() + 60_000).toISOString() })); return;
          }
          expect(enrollment).toBeDefined();
          const [header, payload, signature] = body.request.split(".");
          expect(verify(null, Buffer.from(`${header}.${payload}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: enrollment!.signPublicKey }, format: "jwk" }), Buffer.from(signature, "base64url"))).toBe(true);
          const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
          expect(claims.iss).toBe(enrollment!.instanceId); expect(claims.env).toBe("test"); expect(claims.aud).toBe(`${origin}${req.url}`);
          res.setHeader("content-type", "application/json");
          if (req.url === "/v1/connector/enrollment-claims") {
            res.end(JSON.stringify({ id: enrollment!.instanceId, environment: "test", origins: [enrollment!.origin] })); return;
          }
          identities.push(claims.iss);
          if (req.url === "/v1/connector/events/ack") {
            acknowledged++; delivered.add(eventId);
            if (acknowledged === 2) await replacementAck;
            res.end(JSON.stringify({ acknowledged: 1 })); return;
          }
          expect(req.url).toBe("/v1/connector/events/lease"); leases++;
          if (delivered.has(eventId)) { res.end(JSON.stringify({ events: [], eventWakeVersion: 1 })); return; }
          const ephemeral = generateKeyPairSync("x25519"), epk = ephemeral.publicKey.export({ format: "jwk" }).x!;
          const recipient = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: enrollment!.sealPublicKey }, format: "jwk" });
          const aad = Buffer.from([1, "X25519-HKDF-SHA256-A256GCM", "events", claims.iss, "test", "github", "github.code", ""].join("\n"));
          const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), Buffer.concat([Buffer.from(epk, "base64url"), Buffer.from(enrollment!.sealPublicKey, "base64url")]), aad, 32));
          const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
          const packet = { v: 1, instanceId: claims.iss, environment: "test", leaseId: "lease", events: [{ id: eventId, provider: "github", event: "installation", action: "unsuspend", installationId: "101", repositoryId: null, createdAt: new Date().toISOString(), bindingIds: [`${grantId}_101`], payload: { installationId: "101" } }] };
          const ct = Buffer.concat([cipher.update(JSON.stringify(packet)), cipher.final(), cipher.getAuthTag()]);
          res.end(JSON.stringify({ leaseId: "lease", eventWakeVersion: 1, sealed: { v: 1, alg: "X25519-HKDF-SHA256-A256GCM", purpose: "events", provider: "github", profile: "github.code", epk, iv: iv.toString("base64url"), ct: ct.toString("base64url") } }));
        } catch (error) { httpErrors.push(error); res.writeHead(500).end(); }
      });
      const listening = once(server, "listening"); server.listen(0, "127.0.0.1"); await listening;
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No loopback listener");
      origin = `http://127.0.0.1:${address.port}`;
      companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Live enrollment", issuePrefix: "GLE" });
      const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: randomUUID(), name: "GitHub", type: "mcp_http", status: "active" }).returning();
      const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, uid: randomUUID(), name: "GitHub", status: "active", enabled: true, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} }).returning();
      const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: "owner", status: "active", providerTenant: { github: { userId: "42", login: "octocat", installationIds: ["101"], installationCount: 1, repositoryCount: 0, repositorySelection: "all", installationOwnerLogins: [], webhookHealth: "unhealthy" } } }).returning();
      grantId = grant!.id;
      const env = { PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: origin, PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: "test" };
      const service = githubConnectionEventService(db, { env });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
      const selects = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
      worker = registerGitHubConnectionEventWork(db, coordinator, service, () => true);
      await worker.ready;
      async function observe(assertion: () => void) {
        const observedAt = Date.now(), until = performance.now() + 1_000;
        let failure: unknown;
        do {
          expect(Date.now()).toBe(observedAt);
          try { assertion(); return; } catch (error) { failure = error; }
          await yieldForIo();
        } while (performance.now() < until);
        throw failure;
      }
      async function drainFollowup(expectedLeases: number) {
        const observedAt = Date.now();
        while (leases < expectedLeases) {
          await observe(() => {
            expect(leases).toBeLessThanOrEqual(expectedLeases);
            expect(coordinator!.nextWakeAt() !== null || leases === expectedLeases).toBe(true);
          });
          const followup = coordinator!.nextWakeAt();
          if (followup === null) break;
          expect(followup - observedAt).toBeLessThanOrEqual(5_000);
          await vi.advanceTimersByTimeAsync(Math.max(0, followup - Date.now()) + 1);
        }
        await observe(() => expect(leases).toBe(expectedLeases));
      }
      async function quiet(stage: string) {
        await observe(() => { expect(idleWorkSnapshot().active, stage).toBe(0); expect(coordinator!.nextWakeAt(), stage).toBeNull(); });
        selects.mockClear(); transactions.mockClear(); executes.mockClear(); const before = requests;
        await vi.advanceTimersByTimeAsync(25 * 60_000);
        expect(selects).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled(); expect(requests).toBe(before);
      }
      await quiet("unenrolled startup"); expect(requests).toBe(0);
      async function enroll() {
        await startPaperclipCloudConnectorEnrollment({ origin: "https://self-hosted.example.test", env, companyId });
        const pending = loadPaperclipCloudConnectorIdentity()!;
        await completePaperclipCloudConnectorEnrollment({ enrollmentId: pending.pending!.enrollmentId, state: pending.pending!.returnState, approvalCode: "approved", env });
        return loadPaperclipCloudConnectorIdentity()!.instanceId;
      }
      const firstIdentity = await enroll();
      expect(wakeConnectionEvents(db)).toBe(true);
      await vi.advanceTimersByTimeAsync(6_000);
      await observe(() => expect(acknowledged).toBe(1));
      expect(await db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.providerDeliveryId, eventId))).toMatchObject([{ status: "processed" }]);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId)))[0]!.providerTenant!.github!.webhookHealth).toBe("healthy");
      // The applied installation update publishes one credential-change hint.
      // Join that existing minimum-spacing pass once; the broker now has no debt.
      await drainFollowup(2);
      await quiet("first event plus its one empty follow-up");
      await rm(paperclipCloudConnectorIdentityPath());
      const oldLeases = leases; expect(wakeConnectionEvents(db)).toBe(true); await vi.advanceTimersByTimeAsync(6_000);
      await quiet("removed identity"); expect(leases).toBe(oldLeases);
      eventId = randomUUID(); const secondIdentity = await enroll(); expect(secondIdentity).not.toBe(firstIdentity);
      expect(wakeConnectionEvents(db)).toBe(true); await vi.advanceTimersByTimeAsync(6_000);
      await observe(() => expect(acknowledged).toBe(2));
      expect(identities).toContain(firstIdentity); expect(identities).toContain(secondIdentity);
      expect(identities.slice(identities.indexOf(secondIdentity))).toEqual(expect.arrayContaining([secondIdentity, secondIdentity]));
      expect(identities.slice(identities.indexOf(secondIdentity)).every(id => id === secondIdentity)).toBe(true);
      expect(idleWorkSnapshot().active).toBeGreaterThan(0);
      expect(coordinator.nextWakeAt()).toBeNull();
      releaseReplacementAck();
      await drainFollowup(oldLeases + 2);
      await quiet("replacement event plus its one empty follow-up"); expect(errors).toEqual([]); expect(httpErrors).toEqual([]);
    } finally {
      releaseReplacementAck();
      await worker?.stop(); await coordinator?.stop(); vi.restoreAllMocks(); vi.useRealTimers();
      if (server) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; }
      if (previous.home === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previous.home;
      if (previous.instance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previous.instance;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
