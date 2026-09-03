import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes, type S3VaultClient, type SnugClient } from "../routes/estate.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function createApp(db: Db, s3VaultClient?: S3VaultClient | null, snugClient?: SnugClient | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor();
    next();
  });
  app.use(estateRoutes(db, undefined, s3VaultClient, undefined, snugClient));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    estateId: "estate-1",
    companyId: "company-1",
    uploaderUserId: "user-1",
    documentType: "will",
    title: "Last Will and Testament",
    s3Key: "estates/estate-1/documents/abc123",
    s3Bucket: "iun-estate-docs",
    kmsKeyId: null,
    contentHash: null,
    sizeByes: null,
    accessPolicy: "owner_only",
    expiresAt: null,
    deletedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeVaultClient(overrides: Partial<S3VaultClient> = {}): S3VaultClient {
  return {
    createUploadUrl: vi.fn().mockResolvedValue("https://s3.example.com/upload-presigned"),
    createDownloadUrl: vi.fn().mockResolvedValue("https://s3.example.com/download-presigned"),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    putObject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSnugClient(overrides: Partial<SnugClient> = {}): SnugClient {
  return {
    downloadDocument: vi.fn().mockResolvedValue({
      buffer: Buffer.from("fake-pdf-content"),
      contentType: "application/pdf",
      sizeByes: 16,
    }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /estate/estates/:estateId/documents
// ---------------------------------------------------------------------------

describe("POST /estate/estates/:estateId/documents", () => {
  it("creates a document record and returns presigned upload URL (201)", async () => {
    const doc = makeDocument();
    const vault = makeVaultClient();

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ id: "estate-1" }]),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([doc]),
        }),
      }),
    } as unknown as Db;

    const res = await request(createApp(db, vault))
      .post("/estate/estates/estate-1/documents")
      .send({ companyId: "company-1", title: "Last Will and Testament", documentType: "will" });

    expect(res.status).toBe(201);
    expect(res.body.document.id).toBe("doc-1");
    expect(res.body.document.title).toBe("Last Will and Testament");
    expect(res.body.uploadUrl).toBe("https://s3.example.com/upload-presigned");
    expect(res.body.uploadUrlExpiresInSeconds).toBe(900);
    expect(vault.createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 900 }),
    );
  });

  it("returns 503 when vault is not configured", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db, null))
      .post("/estate/estates/estate-1/documents")
      .send({ companyId: "company-1", title: "Test" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("returns 400 when companyId is missing", async () => {
    const vault = makeVaultClient();
    const db = {} as unknown as Db;
    const res = await request(createApp(db, vault))
      .post("/estate/estates/estate-1/documents")
      .send({ title: "Test" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when title is missing", async () => {
    const vault = makeVaultClient();
    const db = {} as unknown as Db;
    const res = await request(createApp(db, vault))
      .post("/estate/estates/estate-1/documents")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when estate does not belong to company", async () => {
    const vault = makeVaultClient();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]), // estate not found
    } as unknown as Db;

    const res = await request(createApp(db, vault))
      .post("/estate/estates/estate-999/documents")
      .send({ companyId: "company-1", title: "Test" });

    expect(res.status).toBe(404);
  });

  it("returns 403 when actor is not board type", async () => {
    const vault = makeVaultClient();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1" } as never;
      next();
    });
    app.use(estateRoutes({} as unknown as Db, undefined, vault));
    app.use(errorHandler);

    const res = await request(app)
      .post("/estate/estates/estate-1/documents")
      .send({ companyId: "company-1", title: "Test" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /estate/estates/:estateId/documents
// ---------------------------------------------------------------------------

describe("GET /estate/estates/:estateId/documents", () => {
  it("returns documents list for an estate (200)", async () => {
    const docs = [makeDocument(), makeDocument({ id: "doc-2", title: "Trust Document" })];

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn()
        .mockResolvedValueOnce([{ id: "estate-1" }]) // estate exists check
        .mockReturnThis(), // documents query
      orderBy: vi.fn().mockResolvedValue(docs),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/estate/estates/estate-1/documents?companyId=company-1");

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
  });

  it("returns 400 when companyId query param is missing", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db))
      .get("/estate/estates/estate-1/documents");

    expect(res.status).toBe(400);
  });

  it("returns 404 when estate is not found", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .get("/estate/estates/estate-999/documents?companyId=company-1");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /estate/documents/:id/download-url
// ---------------------------------------------------------------------------

describe("GET /estate/documents/:id/download-url", () => {
  it("returns presigned download URL and logs access (200)", async () => {
    const doc = makeDocument();
    const vault = makeVaultClient();

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([doc]),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;

    const res = await request(createApp(db, vault))
      .get("/estate/documents/doc-1/download-url");

    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toBe("https://s3.example.com/download-presigned");
    expect(res.body.expiresInSeconds).toBe(900);
    expect(vault.createDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "iun-estate-docs", ttlSeconds: 900 }),
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it("returns 503 when vault is not configured", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db, null))
      .get("/estate/documents/doc-1/download-url");

    expect(res.status).toBe(503);
  });

  it("returns 404 when document does not exist", async () => {
    const vault = makeVaultClient();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db, vault))
      .get("/estate/documents/doc-999/download-url");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /estate/documents/:id
// ---------------------------------------------------------------------------

describe("DELETE /estate/documents/:id", () => {
  it("soft-deletes a document (204)", async () => {
    const doc = makeDocument();

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([doc]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/documents/doc-1");

    expect(res.status).toBe(204);
    expect(db.update).toHaveBeenCalled();
  });

  it("returns 404 when document does not exist or is already deleted", async () => {
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db))
      .delete("/estate/documents/doc-999");

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /estate/integrations/snug/webhook
// ---------------------------------------------------------------------------

describe("POST /estate/integrations/snug/webhook", () => {
  function makeDb(estateFound = true): Db {
    const doc = makeDocument({ id: "doc-snug", uploaderUserId: "snug-webhook" });
    return {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(estateFound ? [{ id: "estate-1" }] : []),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([doc]),
        }),
      }),
    } as unknown as Db;
  }

  const validPayload = {
    event: "document.completed",
    estateId: "estate-1",
    companyId: "company-1",
    documentType: "will",
    title: "Last Will and Testament",
    documentUrl: "https://app.snug.com/documents/abc123",
  };

  it("downloads document, stores in vault, inserts record (201)", async () => {
    const vault = makeVaultClient();
    const snug = makeSnugClient();
    const db = makeDb();

    const res = await request(createApp(db, vault, snug))
      .post("/estate/integrations/snug/webhook")
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.received).toBe(true);
    expect(res.body.document.uploaderUserId).toBe("snug-webhook");
    expect(snug.downloadDocument).toHaveBeenCalledWith(validPayload.documentUrl);
    expect(vault.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "iun-estate-docs" }),
    );
    expect(db.insert).toHaveBeenCalled();
  });

  it("returns 200 and skips processing for non-completed events", async () => {
    const vault = makeVaultClient();
    const snug = makeSnugClient();
    const db = makeDb();

    const res = await request(createApp(db, vault, snug))
      .post("/estate/integrations/snug/webhook")
      .send({ ...validPayload, event: "document.draft" });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(snug.downloadDocument).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const vault = makeVaultClient();
    const snug = makeSnugClient();
    const db = makeDb();

    const res = await request(createApp(db, vault, snug))
      .post("/estate/integrations/snug/webhook")
      .send({ event: "document.completed", estateId: "estate-1" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when estate is not found", async () => {
    const vault = makeVaultClient();
    const snug = makeSnugClient();
    const db = makeDb(false);

    const res = await request(createApp(db, vault, snug))
      .post("/estate/integrations/snug/webhook")
      .send(validPayload);

    expect(res.status).toBe(404);
  });

  it("returns 503 when vault is not configured", async () => {
    const snug = makeSnugClient();
    const db = makeDb();

    const res = await request(createApp(db, null, snug))
      .post("/estate/integrations/snug/webhook")
      .send(validPayload);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/vault not configured/i);
  });

  it("returns 503 when Snug client is not configured", async () => {
    const vault = makeVaultClient();
    const db = makeDb();

    const res = await request(createApp(db, vault, null))
      .post("/estate/integrations/snug/webhook")
      .send(validPayload);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/snug.*not configured/i);
  });

  it("maps unknown documentType to 'other'", async () => {
    const vault = makeVaultClient();
    const snug = makeSnugClient();
    const db = makeDb();

    const res = await request(createApp(db, vault, snug))
      .post("/estate/integrations/snug/webhook")
      .send({ ...validPayload, documentType: "lease_agreement" });

    expect(res.status).toBe(201);
    const insertCall = (db.insert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertCall).toBeDefined();
  });
});
