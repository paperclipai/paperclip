import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import {
  createDb,
  agents,
  companies,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { customerSuccessRoutes } from "../routes/customer-success.js";
import { agentIdentityService } from "../services/agent-identity.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { execute } from "../adapters/process/execute.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { StorageService } from "../storage/types.js";

// Coordinated qualification against the sibling Cloud build, never a customer
// stack or hosted provider. Default unit runs have no cross-repository dependency.
const cloudDist = process.env.PAPERCLIP_INSPECTION_CLOUD_DIST;
describe.skipIf(!cloudDist)("customer-success managed agent / Cloud / tenant qualification", () => {
  it("uses the existing managed-runtime identity, active JWT, PostgreSQL broker, HTTP permits, and audited tenant reads", async () => {
    const load = (module: string) => import(pathToFileURL(resolve(cloudDist!, module)).href);
    const [
      { CustomerSuccessInspection },
      { InspectionSigner },
      { PostgresInspectionStore },
      { inspectionRoute },
      { InMemoryCloudHarnessRegistry },
      { CloudStackSleepController },
      pg,
    ] = await Promise.all([
      load("customer-success/service.js"),
      load("customer-success/crypto.js"),
      load("customer-success/store.js"),
      load("customer-success/routes.js"),
      load("provisioner/memory.js"),
      load("sleep/controller.js"),
      load("../node_modules/pg/lib/index.js"),
    ]);
    const home = await startEmbeddedPostgresTestDatabase("inspection-home-");
    const tenant = await startEmbeddedPostgresTestDatabase("inspection-customer-");
    const directory = await mkdtemp(join(tmpdir(), "inspection-journey-"));
    const servers: ReturnType<typeof createServer>[] = [];
    const serverErrors: string[] = [];
    const pool = new pg.default.Pool({
      connectionString: home.connectionString,
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    try {
      vi.stubEnv("PAPERCLIP_HOME", directory);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "qualification-home");
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-qualification-jwt");
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
      vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_AUTHORITY_ENABLED", "true");
      vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_ENABLED", "true");
      vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "qualification-stack");
      const homeDb = createDb(home.connectionString);
      const tenantDb = createDb(tenant.connectionString);
      const [homeCompany] = await homeDb
        .insert(companies)
        .values({ name: "Internal", issuePrefix: "INT" })
        .returning();
      const [agent] = await homeDb
        .insert(agents)
        .values({
          companyId: homeCompany.id,
          name: "Success qualification",
          adapterType: "process",
        })
        .returning();
      const identity = await agentIdentityService(homeDb).ensureAgentIdentity(
        homeCompany.id,
        agent.id,
      );
      const [run] = await homeDb
        .insert(heartbeatRuns)
        .values({
          companyId: homeCompany.id,
          agentId: agent.id,
          status: "running",
          startedAt: new Date(),
        })
        .returning();
      const [customer] = await tenantDb
        .insert(companies)
        .values({ name: "Synthetic customer", issuePrefix: "SYN" })
        .returning();
      const [project] = await tenantDb
        .insert(projects)
        .values({ companyId: customer.id, name: "Qualification project" })
        .returning();
      const [workspace] = await tenantDb
        .insert(projectWorkspaces)
        .values({
          companyId: customer.id,
          projectId: project.id,
          name: "Qualification files",
          cwd: directory,
        })
        .returning();
      const filePath = join(directory, "result.bin");
      await writeFile(filePath, Buffer.from([0, 1, 2, 3, 4, 5]));
      const fileBefore = await stat(filePath);
      const [task] = await tenantDb
        .insert(issues)
        .values({ companyId: customer.id, projectId: project.id, title: "First successful task" })
        .returning();
      const storage = { provider: "local_disk" } as StorageService;
      const start = async (handler: Parameters<typeof createServer>[0]) => {
        const server = createServer(handler);
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      };
      const homeApp = express();
      homeApp.use(express.json());
      homeApp.use("/api/customer-success/v1", customerSuccessRoutes(homeDb, storage));
      homeApp.use(errorHandler);
      const sourceOrigin = await start(homeApp);
      const tenantApp = express();
      tenantApp.use(express.json());
      tenantApp.use("/api/customer-success/v1", customerSuccessRoutes(tenantDb, storage));
      tenantApp.use(errorHandler);
      const tenantOrigin = await start(tenantApp);
      await pool.query("CREATE SCHEMA cloud_harness");
      await pool.query(
        await readFile(
          resolve(cloudDist!, "../migrations/0058_customer_success_inspection.sql"),
          "utf8",
        ),
      );
      const registry = new InMemoryCloudHarnessRegistry();
      let transactionReads = 0;
      const registryForClient = (client: any) => ({
        getStack: async (id: string) => {
          await client.query("SELECT 1");
          transactionReads++;
          return registry.getStack(id);
        },
        getAccount: async (id: string) => {
          await client.query("SELECT 1");
          transactionReads++;
          return registry.getCustomerSuccessAccount(id);
        },
        listStackIds: async () => registry.listCustomerSuccessStackIds(),
      });
      const store = new PostgresInspectionStore(pool, registryForClient);
      const now = new Date();
      registry.accountGroups.set("fixture-account", {
        id: "fixture-account",
        kind: "customer",
        billingStatus: "unconfigured",
      });
      registry.stacks.set("qualification-stack", {
        id: "qualification-stack",
        accountGroupId: "fixture-account",
        displayName: "Synthetic customer",
        primaryHost: "fixture.example.test",
        kind: "customer_production",
        lifecycleState: "sleeping",
        sleepState: "sleeping",
        sleepReason: "idle",
        version: 1,
        updatedAt: now,
        rolloutMetadata: { track: "stable" },
        providerRefs: [
          {
            provider: "railway",
            resourceType: "service_domain:web",
            externalId: "fixture",
            metadata: { upstreamOrigin: tenantOrigin },
          },
        ],
        createdAt: now,
      });
      const signer = new InspectionSigner(
        "qualification",
        generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }),
      );
      vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_INSPECTION_JWKS", signer.publicJwks);
      // Use the production wake controller with a disposable local provider.
      // The tenant HTTP process is already listening; no hosted stack is woken.
      const sleep = new CloudStackSleepController({
        registry,
        provider: {
          name: "fake",
          wakeStack: async (
            _id: string,
            context: { stack: Record<string, unknown>; providerRefs: unknown[] },
          ) => ({
            stack: { ...context.stack, lifecycleState: "active", sleepState: "awake" },
            resources: context.providerRefs,
            secretRefs: { providerAdminCredentials: {} },
            operations: [],
          }),
          inspectStack: async () => ({
            stackId: "qualification-stack",
            lifecycleState: "active",
            sleepState: "awake",
            resources: registry.stacks.get("qualification-stack").providerRefs,
          }),
        },
      });
      const broker = new CustomerSuccessInspection({
        store,
        registry,
        signer,
        allowLoopback: true,
        wakeStack: async (stackId: string) => {
          await sleep.wakeStack({ stackId });
        },
      });
      const cloudOrigin = await start(async (req, res) => {
        try {
          const handled = await inspectionRoute({
            req,
            res,
            url: new URL(req.url!, "http://localhost"),
            service: broker,
            authenticateHuman: async () => {
              throw new Error("Qualification never uses human access");
            },
            readJson: async (request: AsyncIterable<Buffer>, max: number) => {
              const parts: Buffer[] = [];
              let bytes = 0;
              for await (const part of request) {
                bytes += part.length;
                if (bytes > max) throw new Error("Too large");
                parts.push(part);
              }
              return JSON.parse(Buffer.concat(parts).toString());
            },
          });
          if (!handled) {
            res.statusCode = 404;
            res.end();
          }
        } catch (error) {
          serverErrors.push(String(error));
          res.statusCode = 503;
          res.end("{}");
        }
      });
      vi.stubEnv("PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN", cloudOrigin);
      await broker.configure("qualification-operator", {
        binding: {
          sourceOrigin,
          instanceId: "qualification-home",
          companyId: homeCompany.id,
          agentId: agent.id,
          keyId: identity.keyId,
          publicKeyPem: identity.publicKeyPem,
        },
      });
      await broker.configure("qualification-operator", { enabled: true });
      const program = `
        const {inspectionAgentClient}=await import(${JSON.stringify(pathToFileURL(resolve(cloudDist!, "customer-success/client.js")).href)});
        const call=inspectionAgentClient();
        const discovery=await call('discover',{});
        const grant=await call('grant',{stackId:'qualification-stack'});
        const tasks=await call('read',{stackId:'qualification-stack',grantToken:grant.token,query:{operation:'list',resource:'tasks',companyId:${JSON.stringify(customer.id)}}});
        const file=await call('read',{stackId:'qualification-stack',grantToken:grant.token,query:{operation:'files.download',companyId:${JSON.stringify(customer.id)},resourceId:${JSON.stringify(task.id)},context:{projectId:${JSON.stringify(project.id)},workspaceId:${JSON.stringify(workspace.id)}},path:'result.bin',range:{start:2,end:5}}});
        console.log(JSON.stringify({stackCount:discovery.items.length,titles:tasks.items.map(t=>t.title),fileBytes:[...Buffer.from(file.content,'base64')]}));
      `;
      const programFile = join(directory, "qualify.mjs");
      await writeFile(programFile, program);
      const output: string[] = [];
      const result = await execute({
        runId: run.id,
        agent,
        agentIdentity: identity,
        authToken: createLocalAgentJwt(agent.id, homeCompany.id, "process", run.id)!,
        config: {
          command: process.execPath,
          args: [programFile],
          cwd: directory,
          env: { PAPERCLIP_CUSTOMER_SUCCESS_CLOUD_ORIGIN: cloudOrigin },
        },
        context: {},
        runtime: { sessionId: null, sessionParams: null, taskKey: null },
        onLog: async (_stream, chunk) => {
          output.push(chunk);
        },
        onMeta: async () => {},
      });
      expect(result.exitCode, [...output, ...serverErrors].join("\n")).toBe(0);
      expect(output.join("")).toContain("First successful task");
      expect(output.join("")).toContain('"fileBytes":[2,3,4,5]');
      expect((await stat(filePath)).mtimeMs).toBe(fileBefore.mtimeMs);
      expect(await readFile(filePath)).toEqual(Buffer.from([0, 1, 2, 3, 4, 5]));
      const audit = await pool.query(
        "SELECT event FROM cloud_harness.customer_success_audit ORDER BY occurred_at",
      );
      expect(audit.rows.map((r: { event: string }) => r.event)).toContain("permit.consumed");
      expect(audit.rows.map((r: { event: string }) => r.event)).toContain("read.completed");
      expect(audit.rows.map((r: { event: string }) => r.event)).toContain("stack.woken");
      expect(await tenantDb.select().from(issues)).toEqual([task]);
      // The production SQL reader scopes before pagination and hides mixed
      // approval cohorts and global policy records from tenant approvers.
      await store.transaction(async (tx: any) => {
        const localId = randomUUID();
        const mixedId = randomUUID();
        const foreignId = randomUUID();
        for (const [id, detail, stackId] of [
          [localId, { stackIds: ["qualification-stack"] }, undefined],
          [mixedId, { stackIds: ["qualification-stack", "foreign-stack"] }, undefined],
          [foreignId, {}, "foreign-stack"],
        ])
          await tx.audit({ id, at: tx.now, event: "scope.fixture", detail, stackId });
        const scoped = await tx.audits(0, 100, ["qualification-stack"]);
        expect(scoped.some((event: any) => event.id === localId)).toBe(true);
        expect(scoped.some((event: any) => event.id === mixedId || event.id === foreignId)).toBe(
          false,
        );
        expect(scoped.some((event: any) => event.event === "policy.changed")).toBe(false);
        expect(await tx.audits(0, 100, [])).toEqual([]);
        const last = await tx.audits(scoped.length - 1, 100, ["qualification-stack"]);
        expect(last).toHaveLength(1);
      });
      // Two independent pool connections prove consumption is durable, not a
      // process-local Set: exactly one replica can consume a signed challenge.
      const token = createLocalAgentJwt(agent.id, homeCompany.id, "process", run.id)!;
      const c = await broker.challenge(token, "discover", {});
      const { sign } = await import("node:crypto");
      const sig = sign(null, Buffer.from(c.bytes), identity.privateKeyPem).toString("base64url");
      const replica = new CustomerSuccessInspection({
        store: new PostgresInspectionStore(pool, registryForClient),
        registry,
        signer,
        allowLoopback: true,
      });
      const competing = await Promise.allSettled([
        broker.execute(token, c.challengeId, sig),
        replica.execute(token, c.challengeId, sig),
      ]);
      expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const grants = await Promise.all(
        Array.from({ length: 4 }, () =>
          broker.challenge(token, "grant", { stackId: "qualification-stack" }),
        ),
      );
      const concurrentGrants = await Promise.all(
        grants.map((proof) =>
          broker.execute(
            token,
            proof.challengeId,
            sign(null, Buffer.from(proof.bytes), identity.privateKeyPem).toString("base64url"),
          ),
        ),
      );
      expect(concurrentGrants).toHaveLength(4);
      expect(transactionReads).toBeGreaterThan(0);
      // Prove append-only enforcement with a runtime role, even if someone
      // accidentally grants it UPDATE/DELETE privileges on the audit table.
      const client = await pool.connect();
      const runtimeRole = `inspection_runtime_${randomUUID().replaceAll("-", "")}`;
      try {
        await client.query(`CREATE ROLE ${runtimeRole}`);
        await client.query(`GRANT USAGE ON SCHEMA cloud_harness TO ${runtimeRole}`);
        await client.query(
          `GRANT SELECT, UPDATE, DELETE ON cloud_harness.customer_success_audit TO ${runtimeRole}`,
        );
        await client.query(`SET ROLE ${runtimeRole}`);
        await expect(
          client.query("UPDATE cloud_harness.customer_success_audit SET event = 'rewritten'"),
        ).rejects.toThrow("append-only");
        await expect(
          client.query("DELETE FROM cloud_harness.customer_success_audit"),
        ).rejects.toThrow("append-only");
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
      const { applyInspectionRetention } = await load("customer-success/retention.js");
      await expect(applyInspectionRetention(pool, 364)).rejects.toThrow("at least one year");
      await pool.query(
        "INSERT INTO cloud_harness.customer_success_audit VALUES ($1,clock_timestamp() - interval '366 days','old.fixture','{}')",
        [randomUUID()],
      );
      expect((await applyInspectionRetention(pool)).auditDeleted).toBe(1);
      expect(
        (await pool.query("SELECT count(*) FROM cloud_harness.customer_success_audit")).rows[0]
          .count,
      ).not.toBe("0");
    } finally {
      for (const server of servers.reverse())
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await tenant.cleanup();
      await home.cleanup();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
