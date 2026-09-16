import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { HttpError, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import { chatChannelRoutes } from "./chat-channels.js";

const token = "synthetic-identity-preview-token-for-route-test";
const preview = {
  companyId: "company-a",
  companyName: "Private company",
  companyPrefix: "PVT",
  endpointId: "endpoint-a",
  provider: "slack" as const,
  providerAccountLabel: "Private workspace",
  botLabel: "Private bot",
  externalLabel: "Private person",
  externalDetail: "@private-person",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function fixture(
  actor: Request["actor"] = {
    type: "board",
    source: "session",
    userId: "viewer",
    companyIds: ["company-a"],
  },
) {
  const previewIdentityLink = vi.fn().mockResolvedValue(preview);
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    chatChannelRoutes({} as Db, {
      service: { previewIdentityLink } as unknown as ChatChannelService,
      heartbeat: { wakeup: vi.fn() },
    }),
  );
  app.use(errorHandler);
  return { app, previewIdentityLink };
}

describe("chat identity-link preview authority", () => {
  it("returns the preview to a Board member of its exact company", async () => {
    const { app, previewIdentityLink } = fixture();
    const response = await request(app)
      .get("/api/chat-identity-links/preview")
      .query({ token });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(preview);
    expect(previewIdentityLink).toHaveBeenCalledExactlyOnceWith(token);
  });

  it.each([false, true])(
    "hides foreign previews identically to invalid or expired tokens (instance admin %s)",
    async (isInstanceAdmin) => {
      const { app, previewIdentityLink } = fixture({
        type: "board",
        source: "session",
        userId: "other-user",
        companyIds: ["company-b"],
        isInstanceAdmin,
      });
      const foreign = await request(app)
        .get("/api/chat-identity-links/preview")
        .query({ token });
      previewIdentityLink.mockRejectedValueOnce(
        unprocessable("This identity-link request is invalid or expired"),
      );
      const missing = await request(app)
        .get("/api/chat-identity-links/preview")
        .query({ token: `${token}-missing` });
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual({
        error: "Identity-link request not found",
      });
      expect(missing.body).toEqual(foreign.body);
      expect(JSON.stringify(foreign.body)).not.toContain("Private");
    },
  );

  it.each(["none", "agent"] as const)(
    "rejects %s actors before looking up the token",
    async (type) => {
      const { app, previewIdentityLink } = fixture({
        type,
        companyId: "company-a",
      });
      await request(app)
        .get("/api/chat-identity-links/preview")
        .query({ token })
        .expect(403);
      expect(previewIdentityLink).not.toHaveBeenCalled();
    },
  );

  it("keeps malformed tokens and unexpected service failures distinct from not found", async () => {
    const { app, previewIdentityLink } = fixture();
    await request(app)
      .get("/api/chat-identity-links/preview")
      .query({ token: "short" })
      .expect(400);
    expect(previewIdentityLink).not.toHaveBeenCalled();
    previewIdentityLink.mockRejectedValueOnce(
      new HttpError(503, "Temporarily unavailable"),
    );
    await request(app)
      .get("/api/chat-identity-links/preview")
      .query({ token })
      .expect(503);
  });
});
