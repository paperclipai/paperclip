import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBriefingFeedbackService = vi.hoisted(() => ({
  submit: vi.fn(),
  listByBriefing: vi.fn(),
  getTrends: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    briefingFeedbackService: () => mockBriefingFeedbackService,
  }));
}

async function createApp() {
  const [{ briefingFeedbackRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/briefing-feedback.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/feedback", briefingFeedbackRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("briefing feedback routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("submits feedback with all fields", async () => {
    mockBriefingFeedbackService.submit.mockResolvedValue({
      id: "fb-1",
      briefingId: "briefing-1",
      userId: "user-1",
      rating: "yes",
      category: "inaccurate_info",
      freeText: "The weather section was wrong",
      createdAt: new Date("2026-05-11T00:00:00Z"),
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/feedback/briefing")
      .send({
        briefingId: "briefing-1",
        userId: "user-1",
        rating: "yes",
        category: "inaccurate_info",
        freeText: "The weather section was wrong",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "fb-1",
      briefingId: "briefing-1",
      rating: "yes",
      category: "inaccurate_info",
      freeText: "The weather section was wrong",
    });
    expect(mockBriefingFeedbackService.submit).toHaveBeenCalledWith({
      briefingId: "briefing-1",
      userId: "user-1",
      rating: "yes",
      category: "inaccurate_info",
      freeText: "The weather section was wrong",
    });
  });

  it("submits feedback with only required fields", async () => {
    mockBriefingFeedbackService.submit.mockResolvedValue({
      id: "fb-2",
      briefingId: "briefing-2",
      userId: "user-2",
      rating: "no",
      category: null,
      freeText: null,
      createdAt: new Date("2026-05-11T00:00:00Z"),
      updatedAt: new Date("2026-05-11T00:00:00Z"),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/feedback/briefing")
      .send({
        briefingId: "briefing-2",
        userId: "user-2",
        rating: "no",
      });

    expect(res.status).toBe(201);
    expect(mockBriefingFeedbackService.submit).toHaveBeenCalledWith({
      briefingId: "briefing-2",
      userId: "user-2",
      rating: "no",
      category: null,
      freeText: null,
    });
  });

  it("rejects invalid rating", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/feedback/briefing")
      .send({
        briefingId: "briefing-3",
        userId: "user-3",
        rating: "invalid",
      });

    expect(res.status).toBe(400);
    expect(mockBriefingFeedbackService.submit).not.toHaveBeenCalled();
  });

  it("rejects invalid category", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/feedback/briefing")
      .send({
        briefingId: "briefing-4",
        userId: "user-4",
        rating: "somewhat",
        category: "invalid_category",
      });

    expect(res.status).toBe(400);
    expect(mockBriefingFeedbackService.submit).not.toHaveBeenCalled();
  });

  it("lists feedback for a briefing", async () => {
    const feedbackRows = [
      {
        id: "fb-1",
        briefingId: "briefing-1",
        userId: "user-1",
        rating: "yes",
        category: "inaccurate_info",
        freeText: "Great briefing",
        createdAt: new Date("2026-05-11T00:00:00Z"),
        updatedAt: new Date("2026-05-11T00:00:00Z"),
      },
    ];
    mockBriefingFeedbackService.listByBriefing.mockResolvedValue(feedbackRows);

    const app = await createApp();
    const res = await request(app).get("/feedback/briefing?briefingId=briefing-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject([
      { id: "fb-1", briefingId: "briefing-1", userId: "user-1", rating: "yes", category: "inaccurate_info", freeText: "Great briefing" },
    ]);
    expect(mockBriefingFeedbackService.listByBriefing).toHaveBeenCalledWith("briefing-1");
  });

  it("rejects list without briefingId", async () => {
    const app = await createApp();
    const res = await request(app).get("/feedback/briefing");

    expect(res.status).toBe(400);
    expect(mockBriefingFeedbackService.listByBriefing).not.toHaveBeenCalled();
  });

  it("returns empty list when no feedback exists", async () => {
    mockBriefingFeedbackService.listByBriefing.mockResolvedValue([]);

    const app = await createApp();
    const res = await request(app).get("/feedback/briefing?briefingId=nonexistent");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
