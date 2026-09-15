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

// Minimal insert stub — logActivity calls insert().values() without .returning()
function insertStub() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
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

// ── Alert assign / handoff / notes / team members ─────────────────────────────

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
      ...insertStub(),
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
      ...insertStub(),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/assign").send({});
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
  });
});

describe("POST /solaris/alerts/:alertId/handoff", () => {
  it("returns 400 when note is missing", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/handoff").send({ assigneeId: "u2", assigneeName: "Bob" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/nonexistent/handoff")
      .send({ assigneeId: "u2", assigneeName: "Bob", note: "Handing off" });
    expect(res.status).toBe(404);
  });

  it("reassigns alert and creates handoff note", async () => {
    const updated = { ...baseAlert, assigneeId: "u2", assigneeName: "Bob" };
    const handoffNote = {
      id: "note-2",
      alertId: "alert-1",
      companyId: "company-1",
      body: "[HANDOFF] Taking over shift",
      authorId: "user-1",
      authorName: "Alice",
      createdAt: new Date().toISOString(),
    };
    let insertCallCount = 0;
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }) }),
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockResolvedValue(insertCallCount++ === 0 ? [handoffNote] : [{}]),
        })),
      })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/handoff")
      .send({ assigneeId: "u2", assigneeName: "Bob", note: "Taking over shift", actorName: "Alice" });
    expect(res.status).toBe(200);
    expect(res.body.alert.assigneeId).toBe("u2");
    expect(res.body.note.body).toBe("[HANDOFF] Taking over shift");
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
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) };
        }
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

// ── Chat ─────────────────────────────────────────────────────────────────────

describe("POST /solaris/alerts/:alertId/chat", () => {
  it("returns 400 when body is missing", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/alert-1/chat").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).post("/solaris/alerts/nonexistent/chat").send({ body: "Hello" });
    expect(res.status).toBe(404);
  });

  it("creates chat message and returns 201", async () => {
    const message = {
      id: "msg-1",
      alertId: "alert-1",
      companyId: "company-1",
      body: "Unit 4 is 5 minutes out",
      authorId: "user-1",
      authorName: "Dispatch",
      createdAt: new Date().toISOString(),
    };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([message]) }) }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/chat")
      .send({ body: "Unit 4 is 5 minutes out", authorName: "Dispatch" });
    expect(res.status).toBe(201);
    expect(res.body.body).toBe("Unit 4 is 5 minutes out");
    expect(res.body.alertId).toBe("alert-1");
  });
});

describe("GET /solaris/alerts/:alertId/chat", () => {
  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/nonexistent/chat");
    expect(res.status).toBe(404);
  });

  it("returns messages list for an alert", async () => {
    const message = {
      id: "msg-1",
      alertId: "alert-1",
      companyId: "company-1",
      body: "Situation under control",
      authorId: null,
      authorName: null,
      createdAt: new Date().toISOString(),
    };
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) };
        }
        const resolved = Promise.resolve([message]);
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnValue(resolved),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/alert-1/chat");
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toBe("Situation under control");
    expect(res.body).toHaveProperty("nextBefore");
  });
});

// ── Activity log ──────────────────────────────────────────────────────────────

describe("GET /solaris/alerts/:alertId/activity", () => {
  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/nonexistent/activity");
    expect(res.status).toBe(404);
  });

  it("returns activity log for an alert in chronological order", async () => {
    const event = {
      id: "evt-1",
      alertId: "alert-1",
      companyId: "company-1",
      eventType: "alert.created",
      actorId: "user-1",
      actorName: null,
      metadata: { severity: "critical" },
      createdAt: new Date().toISOString(),
    };
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) };
        }
        const resolved = Promise.resolve([event]);
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnValue(resolved),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/alert-1/activity");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe("alert.created");
  });
});

// ── Team members ──────────────────────────────────────────────────────────────

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

// ── Responder status ──────────────────────────────────────────────────────────

describe("POST /solaris/alerts/:alertId/responder-status", () => {
  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/nonexistent/responder-status")
      .send({ status: "acknowledged" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid status value", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/responder-status")
      .send({ status: "invalid_status" });
    expect(res.status).toBe(400);
  });

  it("creates a responder status update and publishes live event", async () => {
    const statusUpdate = {
      id: "rsu-1",
      alertId: "alert-1",
      companyId: "company-1",
      status: "acknowledged",
      responderId: "user-1",
      responderName: "Alice",
      note: null,
      eta: null,
      lat: null,
      lng: null,
      createdAt: new Date().toISOString(),
    };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([statusUpdate]),
        }),
      }),
    } as unknown as Db;
    const { publishLiveEvent } = await import("../services/live-events.js");
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/responder-status")
      .send({ status: "acknowledged", responderName: "Alice" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("acknowledged");
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "solaris.alert.responder_status" }),
    );
  });

  it("stores eta and location when provided", async () => {
    const statusUpdate = {
      id: "rsu-2",
      alertId: "alert-1",
      companyId: "company-1",
      status: "en_route",
      responderId: "user-1",
      responderName: "Bob",
      note: null,
      eta: "10 min",
      lat: 34.052,
      lng: -118.243,
      createdAt: new Date().toISOString(),
    };
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([statusUpdate]),
    });
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/responder-status")
      .send({ status: "en_route", responderName: "Bob", eta: "10 min", lat: 34.052, lng: -118.243 });
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eta: "10 min", lat: 34.052, lng: -118.243 }),
    );
  });

  it("ignores non-finite lat/lng values", async () => {
    const statusUpdate = {
      id: "rsu-3",
      alertId: "alert-1",
      companyId: "company-1",
      status: "on_scene",
      responderId: "user-1",
      responderName: null,
      note: null,
      eta: null,
      lat: null,
      lng: null,
      createdAt: new Date().toISOString(),
    };
    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([statusUpdate]),
    });
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) })),
      insert: vi.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/alerts/alert-1/responder-status")
      .send({ status: "on_scene", lat: "not-a-number", lng: Infinity });
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lat: null, lng: null }),
    );
  });
});

describe("GET /solaris/alerts/:alertId/responder-status", () => {
  it("returns 404 when alert not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/nonexistent/responder-status");
    expect(res.status).toBe(404);
  });

  it("returns status history and latestStatus", async () => {
    const updates = [
      { id: "r1", alertId: "alert-1", companyId: "company-1", status: "acknowledged", responderId: "u1", responderName: "Alice", note: null, createdAt: new Date().toISOString() },
      { id: "r2", alertId: "alert-1", companyId: "company-1", status: "en_route", responderId: "u1", responderName: "Alice", note: null, createdAt: new Date().toISOString() },
    ];
    let selectCallCount = 0;
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([baseAlert]) };
        }
        const resolved = Promise.resolve(updates);
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnValue(resolved),
        };
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).get("/solaris/alerts/alert-1/responder-status");
    expect(res.status).toBe(200);
    expect(res.body.updates).toHaveLength(2);
    expect(res.body.latestStatus).toBe("en_route");
  });
});

// ── Web push subscriptions ────────────────────────────────────────────────────

describe("POST /solaris/push/subscribe", () => {
  it("returns 400 when required fields are missing", async () => {
    const db = {} as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/push/subscribe?companyId=company-1")
      .send({ endpoint: "https://push.example.com/123" });
    expect(res.status).toBe(400);
  });

  it("creates a new subscription when none exists", async () => {
    const sub = {
      id: "sub-1",
      companyId: "company-1",
      responderId: "u1",
      endpoint: "https://push.example.com/123",
      p256dh: "key123",
      auth: "auth123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([sub]) }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/push/subscribe?companyId=company-1")
      .send({ responderId: "u1", endpoint: sub.endpoint, p256dh: "key123", auth: "auth123" });
    expect(res.status).toBe(201);
    expect(res.body.endpoint).toBe(sub.endpoint);
  });

  it("updates an existing subscription", async () => {
    const existing = {
      id: "sub-1",
      companyId: "company-1",
      responderId: "u1",
      endpoint: "https://push.example.com/123",
      p256dh: "oldkey",
      auth: "oldauth",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const updated = { ...existing, p256dh: "newkey", auth: "newauth" };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([existing]) })),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updated]) }),
        }),
      }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app)
      .post("/solaris/push/subscribe?companyId=company-1")
      .send({ responderId: "u1", endpoint: existing.endpoint, p256dh: "newkey", auth: "newauth" });
    expect(res.status).toBe(200);
    expect(res.body.p256dh).toBe("newkey");
  });
});

describe("DELETE /solaris/push/subscribe/:subscriptionId", () => {
  it("returns 404 when subscription not found", async () => {
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) })),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).delete("/solaris/push/subscribe/nonexistent");
    expect(res.status).toBe(404);
  });

  it("deletes subscription and returns 204", async () => {
    const sub = {
      id: "sub-1",
      companyId: "company-1",
      responderId: "u1",
      endpoint: "https://push.example.com/123",
      p256dh: "key",
      auth: "auth",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const db = {
      select: vi.fn(() => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([sub]) })),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as unknown as Db;
    const app = createApp(db);
    const res = await request(app).delete("/solaris/push/subscribe/sub-1");
    expect(res.status).toBe(204);
  });
});
