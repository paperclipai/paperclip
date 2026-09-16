import { afterEach, expect, it, vi } from "vitest";
import { companiesApi } from "./companies";

afterEach(() => vi.unstubAllGlobals());

it("keeps directory requests separate from navigation and previous accounts", async () => {
  let resolveOldDirectory!: (response: Response) => void;
  const oldDirectory = new Promise<Response>((resolve) => { resolveOldDirectory = resolve; });
  const fetchMock = vi.fn()
    .mockReturnValueOnce(oldDirectory)
    .mockResolvedValueOnce(Response.json([{ id: "member-company" }]))
    .mockResolvedValueOnce(Response.json([{ id: "directory-company" }]));
  vi.stubGlobal("fetch", fetchMock);
  const previousAccount = companiesApi.directory();
  const navigation = companiesApi.list();
  companiesApi.detachInflightDirectory();
  const currentDirectory = companiesApi.directory();
  try {
    await expect(navigation).resolves.toEqual([{ id: "member-company" }]);
    await expect(currentDirectory).resolves.toEqual([{ id: "directory-company" }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/companies", "/api/companies?scope=accessible", "/api/companies",
    ]);
  } finally {
    resolveOldDirectory(Response.json([]));
    await previousAccount;
  }
});

it("requests navigable companies and detaches the same request when accounts change", async () => {
  let resolveOldRequest!: (response: Response) => void;
  const oldRequest = new Promise<Response>((resolve) => { resolveOldRequest = resolve; });
  const currentCompanies = [{ id: "current-company" }];
  const fetchMock = vi.fn()
    .mockReturnValueOnce(oldRequest)
    .mockResolvedValueOnce(Response.json(currentCompanies));
  vi.stubGlobal("fetch", fetchMock);

  const previousAccount = companiesApi.list();
  companiesApi.detachInflightList();
  const currentAccount = companiesApi.list();
  try {
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/companies?scope=accessible",
      "/api/companies?scope=accessible",
    ]);
    await expect(currentAccount).resolves.toEqual(currentCompanies);
  } finally {
    resolveOldRequest(Response.json([{ id: "previous-company" }]));
    await previousAccount;
  }
});
