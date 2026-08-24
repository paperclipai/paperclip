import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { knowledgeApi } from "./knowledge";

describe("knowledgeApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ items: [], nextCursor: undefined });
  });

  it("calls the company-scoped list endpoint", async () => {
    await knowledgeApi.list("company-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/knowledge");
  });

  it("serializes status, cursor, and limit params", async () => {
    await knowledgeApi.list("company-1", {
      status: "published",
      cursor: "abc",
      limit: 50,
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge?status=published&cursor=abc&limit=50",
    );
  });

  it("serializes search param", async () => {
    await knowledgeApi.list("company-1", { search: "onboarding" });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge?search=onboarding",
    );
  });
});

describe("knowledgeApi.get", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("calls the document detail endpoint", async () => {
    mockApi.get.mockResolvedValue({ id: "doc-1" });
    await knowledgeApi.get("company-1", "doc-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1",
    );
  });

  it("returns null on 404", async () => {
    mockApi.get.mockRejectedValue({ status: 404 });
    const result = await knowledgeApi.get("company-1", "missing");
    expect(result).toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    mockApi.get.mockRejectedValue({ status: 500 });
    await expect(knowledgeApi.get("company-1", "doc-1")).rejects.toEqual({ status: 500 });
  });
});

describe("knowledgeApi.create", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
  });

  it("posts to the create endpoint", async () => {
    mockApi.post.mockResolvedValue({ id: "doc-1" });
    await knowledgeApi.create("company-1", { title: "New doc", body: "hello" });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/knowledge",
      { title: "New doc", body: "hello" },
    );
  });
});

describe("knowledgeApi.update", () => {
  beforeEach(() => {
    mockApi.patch.mockReset();
  });

  it("patches the document endpoint", async () => {
    mockApi.patch.mockResolvedValue({ id: "doc-1", title: "Updated" });
    await knowledgeApi.update("company-1", "doc-1", { title: "Updated" });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1",
      { title: "Updated" },
    );
  });
});

describe("knowledgeApi.remove", () => {
  beforeEach(() => {
    mockApi.delete.mockReset();
  });

  it("deletes the document endpoint", async () => {
    await knowledgeApi.remove("company-1", "doc-1");
    expect(mockApi.delete).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1",
    );
  });
});

describe("knowledgeApi lifecycle actions", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({ document: { id: "doc-1" } });
  });

  it("submits for review", async () => {
    await knowledgeApi.submitForReview("company-1", "doc-1");
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/submit-review",
      {},
    );
  });

  it("reviews with a decision", async () => {
    await knowledgeApi.review("company-1", "doc-1", { status: "approved", comment: "LGTM" });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/review",
      { status: "approved", comment: "LGTM" },
    );
  });

  it("publishes a document", async () => {
    await knowledgeApi.publish("company-1", "doc-1", { changeDescription: "Final" });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/publish",
      { changeDescription: "Final" },
    );
  });

  it("archives a document", async () => {
    await knowledgeApi.archive("company-1", "doc-1");
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/archive",
      {},
    );
  });
});

describe("knowledgeApi revisions + backlinks", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("lists revisions", async () => {
    await knowledgeApi.listRevisions("company-1", "doc-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/revisions",
    );
  });

  it("fetches a specific revision", async () => {
    await knowledgeApi.getRevision("company-1", "doc-1", "rev-2");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/revisions/rev-2",
    );
  });

  it("computes a diff between revisions", async () => {
    await knowledgeApi.diff("company-1", "doc-1", "rev-1", "rev-2");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/revisions/rev-1/diff/rev-2",
    );
  });

  it("lists backlinks", async () => {
    await knowledgeApi.listBacklinks("company-1", "doc-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/doc-1/backlinks",
    );
  });
});

describe("knowledgeApi.searchPublished", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("calls the search endpoint with q", async () => {
    await knowledgeApi.searchPublished("company-1", "deploy");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/search?q=deploy",
    );
  });

  it("serializes limit param", async () => {
    await knowledgeApi.searchPublished("company-1", "deploy", 25);
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/knowledge/search?q=deploy&limit=25",
    );
  });
});