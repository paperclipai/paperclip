import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  projects,
  rt2StoreAuditTrails,
  rt2StoreListings,
  rt2StoreReviewerCommunications,
  rt2StoreReviewerMessages,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2StoreOperationsRoutes } from "../routes/rt2-store-operations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres RT2 Phase 76 store operations tests on this host: " +
      (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("rt2 phase 76 store operations", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase76-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2StoreReviewerMessages);
    await db.delete(rt2StoreReviewerCommunications);
    await db.delete(rt2StoreAuditTrails);
    await db.delete(rt2StoreListings);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.stop();
    }
  });

  async function insertCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, plan: "free", mode: "test" })
      .returning();
    return company.id;
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", rt2StoreOperationsRoutes(db));
    app.use(errorHandler);
    return app;
  }

  describe("store listings (STORE-01)", () => {
    it("POST creates a store listing with draft status", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          storeType: "app_store",
          appName: "Test App",
          appDescription: "A test application",
          category: "productivity",
          tags: ["ai", "automation"],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.listingStatus).toBe("draft");
      expect(res.body.data.storeType).toBe("app_store");
      expect(res.body.data.appName).toBe("Test App");
    });

    it("GET lists store listings", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      // Create a listing first
      await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "google_play", appName: "Play App" });

      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("GET /listings/:listingId returns single listing", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "metastore", appName: "Meta App" });

      const listingId = createRes.body.data.id;
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/listings/" + listingId)
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.appName).toBe("Meta App");
    });

    it("PATCH updates store listing metadata", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Original Name" });

      const listingId = createRes.body.data.id;
      const res = await request(app)
        .patch("/api/companies/" + cid + "/rt2/store/listings/" + listingId)
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ appName: "Updated Name", category: "utilities" });

      expect(res.status).toBe(200);
      expect(res.body.data.appName).toBe("Updated Name");
      expect(res.body.data.category).toBe("utilities");
    });

    it("POST /submit transitions listing to pending_review", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Submit Test" });

      const listingId = createRes.body.data.id;
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/submit")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.listingStatus).toBe("pending_review");
      expect(res.body.data.submittedAt).toBeDefined();
    });

    it("POST /review-status updates review status from reviewer", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const createRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Review Test" });

      const listingId = createRes.body.data.id;
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/review-status")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          listingStatus: "approved",
          latestReviewerComment: "Great app, approved!",
          currentReviewStatus: "resolved",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.listingStatus).toBe("approved");
      expect(res.body.data.latestReviewerComment).toBe("Great app, approved!");
      expect(res.body.data.approvedAt).toBeDefined();
    });
  });

  describe("reviewer communications (STORE-02)", () => {
    it("POST /communications creates a communication thread", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const listingRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Comm Test" });

      const listingId = listingRes.body.data.id;
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/communications")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({
          threadSubject: "Review question about app metadata",
          initialMessage: "Hi, I have a question about the app description requirements.",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.threadSubject).toBe("Review question about app metadata");
      expect(res.body.data.threadStatus).toBe("open");
    });

    it("GET /communications lists threads for a listing", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const listingRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "List Test" });

      const listingId = listingRes.body.data.id;
      await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/communications")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ threadSubject: "Thread 1", initialMessage: "Message 1" });

      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/communications")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("GET /communications/:id/messages returns thread messages", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const listingRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Msg Test" });

      const listingId = listingRes.body.data.id;
      const commRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/communications")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ threadSubject: "Message Thread", initialMessage: "Initial message" });

      const commId = commRes.body.data.id;
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/communications/" + commId + "/messages")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].messageContent).toBe("Initial message");
    });

    it("POST /communications/:id/resolve closes the thread", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const listingRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Resolve Test" });

      const listingId = listingRes.body.data.id;
      const commRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings/" + listingId + "/communications")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ threadSubject: "To Resolve", initialMessage: "Please resolve this" });

      const commId = commRes.body.data.id;
      const res = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/communications/" + commId + "/resolve")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.threadStatus).toBe("resolved");
    });
  });

  describe("store audit trails (STORE-02)", () => {
    it("GET /audit-trails returns audit trail entries", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      // Create a listing to generate audit trail
      await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Audit Test" });

      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/audit-trails")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].action).toBe("listing_created");
    });

    it("GET /audit-trails?storeListingId filters by listing", async () => {
      const cid = await insertCompany("Store Test Co");
      const app = buildApp();
      const listingRes = await request(app)
        .post("/api/companies/" + cid + "/rt2/store/listings")
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin")
        .send({ storeType: "app_store", appName: "Filter Test" });

      const listingId = listingRes.body.data.id;
      const res = await request(app)
        .get("/api/companies/" + cid + "/rt2/store/audit-trails?storeListingId=" + listingId)
        .set("x-actor-type", "user")
        .set("x-actor-id", "admin");

      expect(res.status).toBe(200);
      expect(res.body.data.every((t: { storeListingId: string }) => t.storeListingId === listingId)).toBe(true);
    });
  });
});
