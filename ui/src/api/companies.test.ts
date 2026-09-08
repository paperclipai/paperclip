import { afterEach, expect, it, vi } from "vitest";
import { companiesApi } from "./companies";

afterEach(() => vi.unstubAllGlobals());

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
