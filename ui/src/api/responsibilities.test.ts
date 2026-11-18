import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { responsibilitiesApi } from "./responsibilities";

afterEach(() => vi.restoreAllMocks());

describe("responsibilitiesApi", () => {
  it("reads the acting user's overview by default", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ responsibilities: [] });
    await responsibilitiesApi.overview("company-1");
    expect(get).toHaveBeenCalledExactlyOnceWith("/companies/company-1/responsibilities");
  });

  it("passes the owner and let-go filters as query parameters", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ responsibilities: [] });
    await responsibilitiesApi.overview("company-1", { ownerUserId: "user-2", includeLetGo: true });
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "/companies/company-1/responsibilities?ownerUserId=user-2&includeLetGo=true",
    );
  });

  it("omits a false let-go filter", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ responsibilities: [] });
    await responsibilitiesApi.overview("company-1", { includeLetGo: false, ownerUserId: null });
    expect(get).toHaveBeenCalledExactlyOnceWith("/companies/company-1/responsibilities");
  });

  it("creates an area under the company", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ id: "resp-1" });
    const body = {
      title: "Fundraising",
      description: "Raise the round",
      standard: "Every investor conversation has a next step",
      metricName: "Investors contacted",
      metricTarget: 20,
    };
    await responsibilitiesApi.create("company-1", body);
    expect(post).toHaveBeenCalledExactlyOnceWith("/companies/company-1/responsibilities", body);
  });

  it("reads, updates and deletes one area by id", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ id: "resp-1" });
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ id: "resp-1" });
    const del = vi.spyOn(api, "delete").mockResolvedValue({ id: "resp-1" });
    await responsibilitiesApi.get("resp-1");
    await responsibilitiesApi.update("resp-1", { healthOverride: null, status: "active" });
    await responsibilitiesApi.remove("resp-1");
    expect(get).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1");
    expect(patch).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1", { healthOverride: null, status: "active" });
    expect(del).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1");
  });

  it("links and unlinks work under an area", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ link: { id: "link-1" } });
    const del = vi.spyOn(api, "delete").mockResolvedValue({ id: "link-1" });
    await responsibilitiesApi.link("resp-1", { projectId: "11111111-1111-4111-8111-111111111111" });
    await responsibilitiesApi.unlink("resp-1", "link-1");
    expect(post).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1/links", {
      projectId: "11111111-1111-4111-8111-111111111111",
    });
    expect(del).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1/links/link-1");
  });

  it("delegates work to an agent", async () => {
    const post = vi.spyOn(api, "post").mockResolvedValue({ issue: { id: "issue-1" }, link: { id: "link-1" } });
    await responsibilitiesApi.delegate("resp-1", {
      title: "Draft the update",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      mode: "prepare_i_decide",
    });
    expect(post).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp-1/delegate", {
      title: "Draft the update",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      mode: "prepare_i_decide",
    });
  });
  it("reads the Dashboard paragraph for the acting user, or for an owner", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ text: "", source: "computed", generatedAt: "", refreshing: false });
    await responsibilitiesApi.companySummary("company-1");
    await responsibilitiesApi.companySummary("company-1", { ownerUserId: "user-2" });
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/companies/company-1/responsibilities/summary",
      "/companies/company-1/responsibilities/summary?ownerUserId=user-2",
    ]);
  });

  it("reads one responsibility's paragraph by id", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ text: "", source: "model", generatedAt: "", refreshing: false });
    await responsibilitiesApi.summary("resp 1");
    expect(get).toHaveBeenCalledExactlyOnceWith("/responsibilities/resp%201/summary");
  });
});
