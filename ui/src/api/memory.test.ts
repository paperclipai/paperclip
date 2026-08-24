import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { memoryApi } from "./memory";

describe("memoryApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ items: [], nextCursor: undefined });
  });

  it("calls the company-scoped records endpoint with bindingKey", async () => {
    await memoryApi.list("company-1", { bindingKey: "default" });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/records?bindingKey=default",
    );
  });

  it("serializes cursor and limit params", async () => {
    await memoryApi.list("company-1", {
      bindingKey: "default",
      cursor: "abc",
      limit: 50,
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/records?bindingKey=default&cursor=abc&limit=50",
    );
  });

  it("serializes scope as JSON", async () => {
    await memoryApi.list("company-1", {
      bindingKey: "default",
      scope: JSON.stringify({ agentId: "agent-1" }),
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      '/companies/company-1/memory/records?bindingKey=default&scope=%7B%22agentId%22%3A%22agent-1%22%7D',
    );
  });
});

describe("memoryApi.query", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ snippets: [] });
  });

  it("calls the query endpoint with bindingKey and q", async () => {
    await memoryApi.query("company-1", {
      bindingKey: "default",
      q: "project status",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/query?bindingKey=default&q=project+status",
    );
  });

  it("serializes topK and intent", async () => {
    await memoryApi.query("company-1", {
      bindingKey: "default",
      q: "browse all",
      topK: 5,
      intent: "browse",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/query?bindingKey=default&q=browse+all&topK=5&intent=browse",
    );
  });
});

describe("memoryApi.operations", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("calls the operations endpoint with default limit", async () => {
    await memoryApi.operations("company-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/operations?limit=50",
    );
  });

  it("passes through a custom limit", async () => {
    await memoryApi.operations("company-1", 25);
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/operations?limit=25",
    );
  });
});

describe("memoryApi.bindings", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("calls the bindings endpoint", async () => {
    await memoryApi.bindings("company-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/memory/bindings",
    );
  });
});
