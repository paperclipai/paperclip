import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentIdentityService } from "../services/agent-identity.js";

let db: Db;
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let directory: string;
let companyId: string;
const gate = () => { let open!: () => void; const opened = new Promise<void>(resolve => { open = resolve; }); return { opened, open }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const company = (issuePrefix: string) => db.insert(companies).values({ name: issuePrefix, issuePrefix, defaultResponsibleUserId: "identity-test-owner" }).returning();
const newAgent = async () => (await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer" }).returning())[0];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "paperclip-identity-lock-"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
  database = await startEmbeddedPostgresTestDatabase("paperclip-identity-lock-");
  db = createDb(database.connectionString);
  companyId = (await company("KLO"))[0].id;
});
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("run setup reuses a key without queuing behind run claims or joining their deadlock", async () => {
  const agent = await newAgent();
  const identity = await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
  const [other] = await company("KLK");
  const lockOther = (tx: Db) => tx.select({ id: companies.id }).from(companies).where(eq(companies.id, other.id)).for("update");
  const claimLocked = gate(), workerLocked = gate(), claimContinues = gate(), workerContinues = gate();
  // A queued-run claim share-locks the agent before its issue/run locks. A
  // concurrent writer holds one of those and then updates the agent row.
  const claim = db.transaction(async tx => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("share");
    claimLocked.open(); await claimContinues.opened;
    await lockOther(tx as unknown as Db);
  });
  await claimLocked.opened;
  const worker = db.transaction(async tx => {
    await lockOther(tx as unknown as Db);
    workerLocked.open(); await workerContinues.opened;
    await tx.update(agents).set({ name: randomUUID() }).where(eq(agents.id, agent.id));
  });
  await workerLocked.opened;
  const setup = agentIdentityService(db).ensureAgentIdentity(companyId, agent.id);
  await pause(200);
  workerContinues.open();
  await pause(200);
  claimContinues.open();
  const [setupResult, ...cycle] = await Promise.allSettled([setup, claim, worker]);
  // The identity read stays out of the cycle; the claim/worker pair resolves
  // it themselves (accounting claims retry 40P01).
  expect(setupResult).toEqual({ status: "fulfilled", value: identity });
  expect(cycle.filter(result => result.status === "rejected")).toHaveLength(1);
}, 30_000);

it("first provisioning does not wait for a run claim's share lock", async () => {
  const agent = await newAgent();
  const holding = gate(), release = gate();
  const claim = db.transaction(async tx => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("share");
    holding.open(); await release.opened;
  });
  await holding.opened;
  try {
    const provisioned = await Promise.race([agentIdentityService(db).ensureAgentIdentity(companyId, agent.id),
      pause(5_000).then(() => { throw new Error("first provisioning waited for a share lock"); })]);
    expect(provisioned.keyId).toMatch(/^sha256:/);
  } finally {
    release.open();
    await claim;
  }
  expect(await agentIdentityService(db).getPublicIdentity(companyId, agent.id)).toMatchObject({ keyId: expect.stringMatching(/^sha256:/) });
}, 30_000);
