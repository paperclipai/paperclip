import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  respond,
  respondError,
  respondCreated,
  respondNoContent,
  respondNotFound,
  respondUnauthorized,
  respondForbidden,
} from "../lib/respond.js";

describe("respond helper", () => {
  const createMockResponse = (): Partial<Response> => {
    const res: Partial<Response> = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    };
    return res;
  };

  describe("respond", () => {
    it("sends JSON with default status 200", () => {
      const res = createMockResponse();
      respond(res as Response, { foo: "bar" });

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ foo: "bar" });
    });

    it("sends JSON with custom status", () => {
      const res = createMockResponse();
      respond(res as Response, { foo: "bar" }, { status: 201 });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ foo: "bar" });
    });
  });

  describe("respondError", () => {
    it("sends error with default status 400", () => {
      const res = createMockResponse();
      respondError(res as Response, "Bad request");

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Bad request" });
    });

    it("sends error with custom status", () => {
      const res = createMockResponse();
      respondError(res as Response, "Not found", 404);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("includes details when provided", () => {
      const res = createMockResponse();
      respondError(res as Response, "Validation failed", 422, { field: "email" });

      expect(res.json).toHaveBeenCalledWith({
        error: "Validation failed",
        details: { field: "email" },
      });
    });
  });

  describe("respondCreated", () => {
    it("sends JSON with status 201", () => {
      const res = createMockResponse();
      respondCreated(res as Response, { id: "123" });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ id: "123" });
    });
  });

  describe("respondNoContent", () => {
    it("sends status 204 with no body", () => {
      const res = createMockResponse();
      respondNoContent(res as Response);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe("respondNotFound", () => {
    it("sends 404 with default message", () => {
      const res = createMockResponse();
      respondNotFound(res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "Not found" });
    });

    it("sends 404 with custom message", () => {
      const res = createMockResponse();
      respondNotFound(res as Response, "User not found");

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "User not found" });
    });
  });

  describe("respondUnauthorized", () => {
    it("sends 401 with default message", () => {
      const res = createMockResponse();
      respondUnauthorized(res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
    });

    it("sends 401 with custom message", () => {
      const res = createMockResponse();
      respondUnauthorized(res as Response, "Session expired");

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Session expired" });
    });
  });

  describe("respondForbidden", () => {
    it("sends 403 with default message", () => {
      const res = createMockResponse();
      respondForbidden(res as Response);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "Forbidden" });
    });

    it("sends 403 with custom message", () => {
      const res = createMockResponse();
      respondForbidden(res as Response, "Access denied");

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "Access denied" });
    });
  });
});

describe("respond helper — integration with Express", () => {
  function createApp() {
    const app = express();
    const router = Router();

    router.get("/ok", (_req, res) => {
      respond(res, { status: "ok" });
    });

    router.get("/custom-status", (_req, res) => {
      respond(res, { id: "x" }, { status: 201 });
    });

    router.get("/error", (_req, res) => {
      respondError(res, "Something went wrong", 422, { field: "email" });
    });

    router.get("/created", (_req, res) => {
      respondCreated(res, { id: "new-id" });
    });

    router.get("/no-content", (_req, res) => {
      respondNoContent(res);
    });

    router.get("/not-found", (_req, res) => {
      respondNotFound(res);
    });

    router.get("/unauthorized", (_req, res) => {
      respondUnauthorized(res);
    });

    router.get("/forbidden", (_req, res) => {
      respondForbidden(res);
    });

    app.use(router);
    return app;
  }

  it("respond returns 200 with body", async () => {
    const res = await request(createApp()).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("respond accepts custom status", async () => {
    const res = await request(createApp()).get("/custom-status");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "x" });
  });

  it("respondError returns error with status and details", async () => {
    const res = await request(createApp()).get("/error");
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Something went wrong", details: { field: "email" } });
  });

  it("respondCreated returns 201", async () => {
    const res = await request(createApp()).get("/created");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "new-id" });
  });

  it("respondNoContent returns 204 with no body", async () => {
    const res = await request(createApp()).get("/no-content");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("respondNotFound returns 404", async () => {
    const res = await request(createApp()).get("/not-found");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("respondUnauthorized returns 401", async () => {
    const res = await request(createApp()).get("/unauthorized");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("respondForbidden returns 403", async () => {
    const res = await request(createApp()).get("/forbidden");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });
});
