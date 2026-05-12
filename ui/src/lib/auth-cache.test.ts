import { describe, expect, it, vi } from "vitest";
import { clearAuthenticatedCache } from "./auth-cache";
import { queryKeys } from "./queryKeys";

describe("clearAuthenticatedCache", () => {
  it("clears authenticated query data and per-company navigation memory", async () => {
    localStorage.setItem("paperclip.companyPaths", JSON.stringify({ "company-1": "/issues/ISS-1" }));
    const queryClient = {
      cancelQueries: vi.fn().mockResolvedValue(undefined),
      removeQueries: vi.fn(),
      setQueryData: vi.fn(),
    };

    await clearAuthenticatedCache(queryClient as never);

    expect(queryClient.cancelQueries).toHaveBeenCalled();
    expect(queryClient.removeQueries).toHaveBeenCalledWith({ predicate: expect.any(Function) });
    expect(queryClient.setQueryData).toHaveBeenCalledWith(queryKeys.auth.session, null);
    expect(localStorage.getItem("paperclip.companyPaths")).toBeNull();
  });
});
