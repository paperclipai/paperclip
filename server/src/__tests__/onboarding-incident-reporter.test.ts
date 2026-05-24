import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issueLabels, issues, labels } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { onboardingIncidentReporter } from "../middleware/onboarding-incident-reporter.js";
import {
  AUTO_FILED_ONBOARDING_5XX_LABEL_NAME,
  AUTO_FILED_ONBOARDING_5XX_ORIGIN_KIND,
  onboardingIncidentsService,
} from "../services/onboarding-incidents.js";
import { HttpError } from "../errors.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres onboarding incident tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type RecordSettlement = {
  incidentId: string;
  ok: boolean;
  error?: unknown;
  outcome?: { filed: string; issueId?: string };
};

interface IncidentBarrier {
  onSettled(value: RecordSettlement): void;
  wait(): Promise<RecordSettlement>;
}

interface AppHandle {
  app: express.Express;
  incidentDir: string;
  cleanup: () => Promise<void>;
  waitForNextIncident(): Promise<RecordSettlement>;
}

function buildIncidentBarrier(): IncidentBarrier {
  const queue: RecordSettlement[] = [];
  const waiters: Array<(value: RecordSettlement) => void> = [];
  return {
    onSettled(value) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queue.push(value);
    },
    wait() {
      const next = queue.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function buildApp(
  db: Db,
  incidentDir: string,
  opts: {
    actor?: express.Request["actor"];
    barrier?: IncidentBarrier;
  } = {},
): express.Express {
  const incidents = onboardingIncidentsService(db, { incidentDir });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = opts.actor
      ?? ({
        type: "board",
        userId: "user-1",
        userName: "Test Board User",
        userEmail: null,
        isInstanceAdmin: true,
        source: "session",
      } as express.Request["actor"]);
    next();
  });
  app.use(
    onboardingIncidentReporter({
      incidents,
      onRecordSettled: opts.barrier?.onSettled,
    }),
  );

  app.post("/api/companies", (_req, _res, next) => {
    next(new HttpError(500, "Internal server error"));
  });
  app.post("/api/companies/:companyId/projects", (_req, _res, next) => {
    next(new HttpError(500, "Internal server error"));
  });
  app.post("/api/probe-non-onboarding", (_req, _res, next) => {
    next(new HttpError(500, "Internal server error"));
  });

  app.use(errorHandler);
  return app;
}

async function withTempIncidentDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-incidents-"));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function newAppHandle(
  db: Db,
  opts: { actor?: express.Request["actor"] } = {},
): Promise<AppHandle> {
  return (async () => {
    const tmp = await withTempIncidentDir();
    const barrier = buildIncidentBarrier();
    const app = buildApp(db, tmp.dir, { ...opts, barrier });
    return {
      app,
      incidentDir: tmp.dir,
      cleanup: tmp.cleanup,
      waitForNextIncident: () => barrier.wait(),
    };
  })();
}

async function insertCompany(db: Db, name = "Acme Inc") {
  const [row] = await db
    .insert(companies)
    .values({ name, issuePrefix: name.slice(0, 3).toUpperCase() })
    .returning();
  return row;
}

describeEmbeddedPostgres("onboarding-incident-reporter middleware + service", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let handle: AppHandle;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-onboarding-incident-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    handle = await newAppHandle(db);
  });

  afterEach(async () => {
    await handle.cleanup();
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("files an auto-issue on an onboarding 5xx when a company exists in the URL", async () => {
    const company = await insertCompany(db);

    const response = await request(handle.app)
      .post(`/api/companies/${company.id}/projects`)
      .set("X-Paperclip-Onboarding", "1")
      .set("Authorization", "Bearer secret-token")
      .send({ name: "First project", password: "do-not-store" });

    expect(response.status).toBe(500);
    expect(response.body.incidentId).toMatch(/^[0-9a-f-]{36}$/);

    const settled = await handle.waitForNextIncident();
    if (settled.error) throw settled.error;
    expect(settled.ok).toBe(true);
    expect(settled.outcome?.filed).toBe("issue");

    const filed = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(filed).toHaveLength(1);
    expect(filed[0].title).toContain("Onboarding 5xx");
    expect(filed[0].originKind).toBe(AUTO_FILED_ONBOARDING_5XX_ORIGIN_KIND);
    expect(filed[0].priority).toBe("high");
    expect(filed[0].status).toBe("backlog");
    expect(filed[0].description ?? "").not.toContain("do-not-store");
    expect(filed[0].description ?? "").not.toContain("secret-token");
    expect(filed[0].description ?? "").toContain("[redacted]");

    const labelRows = await db
      .select()
      .from(labels)
      .where(eq(labels.companyId, company.id));
    expect(labelRows.map((l) => l.name)).toContain(AUTO_FILED_ONBOARDING_5XX_LABEL_NAME);
  });

  it("dedups within 24h and posts a counter comment instead of a second issue", async () => {
    const company = await insertCompany(db, "Beta Co");

    await request(handle.app)
      .post(`/api/companies/${company.id}/projects`)
      .set("X-Paperclip-Onboarding", "1")
      .send({ name: "First" });
    {
      const settled = await handle.waitForNextIncident();
      if (settled.error) throw settled.error;
    }

    await request(handle.app)
      .post(`/api/companies/${company.id}/projects`)
      .set("X-Paperclip-Onboarding", "1")
      .send({ name: "First" });
    {
      const settled = await handle.waitForNextIncident();
      if (settled.error) throw settled.error;
    }

    const filed = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(filed).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, filed[0].id));
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments.some((c) => c.body?.includes("Repeat hit"))).toBe(true);
  });

  it("defers to disk when the request had no companyId in the URL", async () => {
    const response = await request(handle.app)
      .post("/api/companies")
      .send({ name: "pdeo" });

    expect(response.status).toBe(500);
    expect(response.body.incidentId).toMatch(/^[0-9a-f-]{36}$/);

    const settled = await handle.waitForNextIncident();
    if (settled.error) throw settled.error;

    const dirEntries = await fs.readdir(handle.incidentDir);
    const incidents = dirEntries.filter((e) => e.endsWith(".json"));
    expect(incidents).toHaveLength(1);
    const raw = await fs.readFile(path.join(handle.incidentDir, incidents[0]), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.routePattern).toBe("/api/companies");
    expect(parsed.createdByUserId).toBe("user-1");
    expect(parsed.error.message).toBe("Internal server error");
  });

  it("ingests pending incidents for the same creator on next POST /api/companies", async () => {
    await request(handle.app).post("/api/companies").send({ name: "pdeo" });
    {
      const settled = await handle.waitForNextIncident();
      if (settled.error) throw settled.error;
    }
    const beforeIngest = await fs.readdir(handle.incidentDir);
    expect(beforeIngest.filter((e) => e.endsWith(".json"))).toHaveLength(1);

    const incidents = onboardingIncidentsService(db, { incidentDir: handle.incidentDir });
    const company = await insertCompany(db, "Pdeo Two");
    const result = await incidents.ingestPendingIncidents(company.id, {
      creatorUserId: "user-1",
      actorSource: "session",
    });
    expect(result.ingestedCount).toBe(1);
    expect(result.skippedCount).toBe(0);

    const filed = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(filed).toHaveLength(1);
    expect(filed[0].description ?? "").toContain("ingested on first successful company creation");

    const afterIngest = await fs.readdir(handle.incidentDir);
    expect(afterIngest.filter((e) => e.endsWith(".json"))).toHaveLength(0);
  });

  it("does NOT ingest incidents that belong to a different user", async () => {
    await handle.cleanup();
    handle = await newAppHandle(db, {
      actor: {
        type: "board",
        userId: "user-other",
        userName: "Other",
        userEmail: null,
        isInstanceAdmin: true,
        source: "session",
      } as express.Request["actor"],
    });

    await request(handle.app).post("/api/companies").send({ name: "pdeo" });
    {
      const settled = await handle.waitForNextIncident();
      if (settled.error) throw settled.error;
    }

    const incidents = onboardingIncidentsService(db, { incidentDir: handle.incidentDir });
    const company = await insertCompany(db, "Different User");
    const result = await incidents.ingestPendingIncidents(company.id, {
      creatorUserId: "user-1",
      actorSource: "session",
    });
    expect(result.ingestedCount).toBe(0);
    expect(result.skippedCount).toBe(1);

    const filed = await db.select().from(issues).where(eq(issues.companyId, company.id));
    expect(filed).toHaveLength(0);

    const remaining = await fs.readdir(handle.incidentDir);
    expect(remaining.filter((e) => e.endsWith(".json"))).toHaveLength(1);
  });

  it("does not record non-onboarding 5xx responses", async () => {
    const response = await request(handle.app)
      .post("/api/probe-non-onboarding")
      .send({});
    expect(response.status).toBe(500);
    expect(response.body.incidentId).toBeUndefined();

    // Give any (incorrect) recorder enough time to fire — it must not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const entries = await fs.readdir(handle.incidentDir).catch(() => []);
    expect(entries.filter((e) => e.endsWith(".json"))).toHaveLength(0);
    const issueRows = await db.select().from(issues);
    expect(issueRows).toHaveLength(0);
  });
});
