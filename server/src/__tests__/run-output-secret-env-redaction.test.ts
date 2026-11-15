import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.js";
import { secretService } from "../services/secrets.js";

describe("secret-bound environment values in a local run", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let directory: string;
  let companyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-secret-env-output-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-secret-env-output-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Secret output test", issuePrefix: "SEO",
      defaultResponsibleUserId: "secret-output-owner" });
  });

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("masks the latest resolved secret value in each run's stored log and run row and leaves plain and short values", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer" }).returning();
    const svc = secretService(db);
    const secretValue = `sk_test_synthetic_${randomUUID()}`;
    const shortValue = "pin42";
    const plainValue = "https://plain.example.test/api";
    const [secret, shortSecret] = await Promise.all([
      svc.create(companyId, { name: `stripe-${randomUUID()}`, provider: "local_encrypted", value: secretValue }),
      svc.create(companyId, { name: `pin-${randomUUID()}`, provider: "local_encrypted", value: shortValue }),
    ]);
    const env = {
      STRIPE_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      SHORT_PIN: { type: "secret_ref", secretId: shortSecret.id, version: "latest" },
      PLAIN_URL: plainValue,
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: agent!.id }, env);
    await db.update(agents).set({ adapterType: "process", adapterConfig: {
      command: process.execPath, cwd: directory,
      args: ["-e", [
        "const v=process.env.STRIPE_KEY;",
        "process.stdout.write('STRIPE_KEY='+v.slice(0,12));",
        "setTimeout(()=>{process.stdout.write(v.slice(12)+'\\n');",
        "console.log(JSON.stringify({env:{STRIPE_KEY:v}}));",
        "console.log('SHORT_PIN='+process.env.SHORT_PIN);",
        "console.log('PLAIN_URL='+process.env.PLAIN_URL);",
        "console.log('DIGEST='+require('node:crypto').createHash('sha256').update(v).digest('hex'));",
        "console.error('stderr '+v);},30);",
      ].join("")],
      env,
    } }).where(eq(agents.id, agent!.id));
    const heartbeat = heartbeatService(db);
    try {
      for (const value of [secretValue, `sk_test_rotated_${randomUUID()}`]) {
        if (value !== secretValue) await svc.rotate(secret.id, { value }, { userId: "secret-output-owner" });
        const run = await heartbeat.invoke(agent!.id, "on_demand", {}, "manual");
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
        const finished = await heartbeat.getRun(run!.id);
        expect(finished?.status, JSON.stringify(finished)).toBe("succeeded");
        const log = (await heartbeat.readLog(run!.id)).content;
        const events = await heartbeat.listEvents(run!.id);
        for (const stored of [log, JSON.stringify(finished), JSON.stringify(events)]) {
          expect(stored).not.toContain(value);
          expect(stored).not.toContain(value.slice(12));
        }
        const stdout = log.trim().split("\n").map(line => JSON.parse(line) as { stream: string; chunk: string })
          .filter(line => line.stream === "stdout").map(line => line.chunk).join("");
        expect(stdout).toContain("STRIPE_KEY=***REDACTED***\n");
        expect(stdout).toContain(JSON.stringify({ env: { STRIPE_KEY: "***REDACTED***" } }));
        expect(stdout).toContain(`SHORT_PIN=${shortValue}`);
        expect(stdout).toContain(`PLAIN_URL=${plainValue}`);
        expect(stdout).toContain(`DIGEST=${createHash("sha256").update(value).digest("hex")}`);
        expect(finished?.stderrExcerpt).toContain("stderr ***REDACTED***");
      }
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
  }, 60_000);
});
