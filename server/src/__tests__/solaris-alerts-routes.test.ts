import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { solarisAlertRoutes } from "../routes/solaris-alerts.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/alert-translation.js", () => ({
  translateAlertForAllLocales: vi.fn().mockResolvedValue({ es: "Alerta traducida" }),
  SUPPORTED_LOCALES: ["es", "zh-Hans", "tl"],
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function agentActor() {
  return {
    type: "agent" as const,
    agentId: "agent-1",
    companyId: "company-1",
    runId: null,
  };
}

function createApp(db: Db, actor?: object) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (actor ?? boardActor()) as any;
    next();
  });
  app.use(solarisAlertRoutes(db));
  app.use(errorHandler);
  return app;
}

function makeSelectChain(result: unknown[]) {
  const resolved = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(() => Object.assign(resolved, chain)),
    limit: vi.fn().mockResolvedValue(result),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  return { select: vi.fn(() => chain) } as unknown as Db;
}

function makeInsertDb(returning: unknown) {
  return {
    select: vi.fn(() => {
      const r = Promise.resolve([]);
      return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([returning]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([returning]) }) }),
    }),
  } as unknown as Db;
}

// ── Org routes ───────────────────────────────────────────────────────────────

describe("GET /solaris/orgs", () => {
  it("returns 403 when actor is not board", async () => {
    const db = makeSelectChain([]);
    const app = createApp(db, agentActor());
    const res = await request(app).get("/solaris/orgs?companyId=company-1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when companyId is missing", async () => {
    const db = makeSelectChain([]);
    const app = createApp(db);
    const res = await request(app).get("/solaris/orgs");
    expect(res.status).toBe(400);
  });

  it("returns orgs list for valid board actor", async () => {
    const org = { id: "org-1", companyId: "company-1", name: "Riverside EM", preferredLanguage: "es", isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const resolved = Promise.resolve([org]);
    const chain: Record<string, unknown> = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnValue(resolved),
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    };
    const db = { select: vi.fn(() => chain) } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/orgs?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.orgs).toHaveLength(1);
    expect(res.body.orgs[0].name).toBe("Riverside EM");
  });
});

describe("POST /solaris/orgs", () => {
  it("returns 400 when name is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/orgs").send({ companyId: "company-1" });
    expect(res.status).toBe(400);
  });

  it("creates org and returns 201", async () => {
    const org = { id: "org-1", companyId: "company-1", name: "LA County OES", preferredLanguage: "es", isActive: true };
    const db = makeInsertDb(org);
    const app = createApp(db);
    const res = await request(app).post("/solaris/orgs").send({
      companyId: "company-1",
      name: "LA County OES",
      preferredLanguage: "es",
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("LA County OES");
    expect(res.body.preferredLanguage).toBe("es");
  });

  it("defaults preferredLanguage to en for unsupported language", async () => {
    const org = { id: "org-1", companyId: "company-1", name: "Test Org", preferredLanguage: "en", isActive: true };
    const db = makeInsertDb(org);
    const app = createApp(db);
    const res = await request(app).post("/solaris/orgs").send({
      companyId: "company-1",
      name: "Test Org",
      preferredLanguage: "klingon",
    });
    expect(res.status).toBe(201);
    expect(res.body.preferredLanguage).toBe("en");
  });
});

// ── Alert routes ─────────────────────────────────────────────────────────────

describe("GET /solaris/alerts", () => {
  it("returns 400 when companyId is missing", async () => {
    const db = makeSelectChain([]);
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts");
    expect(res.status).toBe(400);
  });

  it("returns alerts list", async () => {
    const alert = {
      id: "alert-1",
      companyId: "company-1",
      orgId: null,
      title: "Wildfire Warning",
      body: "Evacuation order in effect",
      severity: "critical",
      translatedBodies: null,
      dispatchStatus: "ready",
      createdAt: new Date().toISOString(),
    };
    const resolved = Promise.resolve([alert]);
    const chain: Record<string, unknown> = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnValue(resolved),
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    };
    const db = { select: vi.fn(() => chain) } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].title).toBe("Wildfire Warning");
  });
});

describe("POST /solaris/alerts", () => {
  it("returns 400 when title is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts").send({ companyId: "company-1", body: "Test" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts").send({ companyId: "company-1", title: "Test" });
    expect(res.status).toBe(400);
  });

  it("creates English alert with dispatchStatus ready and no orgId", async () => {
    const alert = {
      id: "alert-1",
      companyId: "company-1",
      orgId: null,
      title: "Test Alert",
      body: "Test body",
      severity: "info",
      translatedBodies: null,
      dispatchStatus: "ready",
    };
    const noOrgSelectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
    const db = {
      select: vi.fn(() => noOrgSelectChain),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([alert]) }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts").send({
      companyId: "company-1",
      title: "Test Alert",
      body: "Test body",
    });
    expect(res.status).toBe(201);
    expect(res.body.dispatchStatus).toBe("ready");
  });

  it("sets dispatchStatus to translating when org has non-English language", async () => {
    const org = { id: "org-1", preferredLanguage: "es" };
    const alert = {
      id: "alert-1",
      companyId: "company-1",
      orgId: "org-1",
      title: "Incendio",
      body: "Wildfire warning",
      severity: "critical",
      translatedBodies: null,
      dispatchStatus: "translating",
    };
    const orgSelectChain = { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([org]) };
    const db = {
      select: vi.fn(() => orgSelectChain),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([alert]) }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts").send({
      companyId: "company-1",
      orgId: "org-1",
      title: "Incendio",
      body: "Wildfire warning",
      severity: "critical",
    });
    expect(res.status).toBe(201);
    expect(res.body.dispatchStatus).toBe("translating");
  });
});

describe("PATCH /solaris/orgs/:orgId", () => {
  it("returns 404 when org not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/solaris/orgs/nonexistent").send({ preferredLanguage: "tl" });
    expect(res.status).toBe(404);
  });

  it("updates org language", async () => {
    const org = { id: "org-1", companyId: "company-1", name: "Test", preferredLanguage: "en", isActive: true };
    const updated = { ...org, preferredLanguage: "tl" };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([org]) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }) }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).patch("/solaris/orgs/org-1").send({ preferredLanguage: "tl" });
    expect(res.status).toBe(200);
    expect(res.body.preferredLanguage).toBe("tl");
  });
});

// ── Alert assign / notes / team members (IUN-2885) ───────────────────────────

const baseAlert = {
  id: "alert-1",
  companyId: "company-1",
  orgId: null,
  title: "Wildfire Warning",
  body: "Evacuation order",
  severity: "critical",
  translatedBodies: null,
  dispatchStatus: "ready",
  assigneeId: null,
  assigneeName: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("POST /solaris/alerts/:alertId/assign", () => {
  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/nonexistent/assign").send({ assigneeId: "u1", assigneeName: "Alice" });
    expect(res.status).toBe(404);
  });

  it("persists assignee and returns updated alert", async () => {
    const updated = { ...baseAlert, assigneeId: "u1", assigneeName: "Alice" };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }) }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/assign").send({ assigneeId: "u1", assigneeName: "Alice" });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe("u1");
    expect(res.body.assigneeName).toBe("Alice");
  });

  it("allows clearing assignee with null values", async () => {
    const updated = { ...baseAlert, assigneeId: null, assigneeName: null };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }) }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/assign").send({});
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
  });
});

describe("POST /solaris/alerts/:alertId/notes", () => {
  it("returns 400 when body is missing", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/notes").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/nonexistent/notes").send({ body: "Noted." });
    expect(res.status).toBe(404);
  });

  it("creates note and returns 201", async () => {
    const note = {
      id: "note-1",
      alertId: "alert-1",
      companyId: "company-1",
      body: "Units en route",
      authorId: "user-1",
      authorName: "Dispatch",
      createdAt: new Date().toISOString(),
    };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([note]) }) }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/notes").send({ body: "Units en route", authorName: "Dispatch" });
    expect(res.status).toBe(201);
    expect(res.body.body).toBe("Units en route");
    expect(res.body.alertId).toBe("alert-1");
  });
});

describe("GET /solaris/alerts/:alertId/notes", () => {
  it("returns notes list for an alert", async () => {
    const note = { id: "note-1", alertId: "alert-1", companyId: "company-1", body: "All clear", authorId: null, authorName: null, createdAt: new Date().toISOString() };
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // First call: fetch the alert
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) };
        }
        // Second call: fetch notes
        const resolved = Promise.resolve([note]);
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(resolved),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/alert-1/notes");
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].body).toBe("All clear");
  });
});

describe("GET /solaris/team/members", () => {
  it("returns 400 when companyId is missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/team/members");
    expect(res.status).toBe(400);
  });

  it("returns active company users", async () => {
    const members = [{ id: "u1", name: "Alice Nguyen", email: "alice@agency.gov" }];
    const resolved = Promise.resolve(members);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue(resolved),
      })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/team/members?companyId=company-1");
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].name).toBe("Alice Nguyen");
  });
});
