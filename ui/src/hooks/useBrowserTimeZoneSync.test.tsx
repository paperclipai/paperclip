// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserTimeZoneSyncForTests, useBrowserTimeZoneSync } from "./useBrowserTimeZoneSync";
import { queryKeys } from "@/lib/queryKeys";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/api/workspacePreferences", () => ({ workspacePreferencesApi: { get: mocks.get, update: mocks.update } }));

const preference = (userId: string, timeZone: string | null) => ({ userId, coordinatorWorkspaceEnabled: true, timeZone, updatedAt: null });
function Probe({ companyId, userId }: { companyId: string | null; userId: string | null }) {
  useBrowserTimeZoneSync(companyId, userId);
  return null;
}
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("useBrowserTimeZoneSync", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserTimeZoneSyncForTests();
    const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...resolvedOptions.call(this), timeZone: "America/Chicago" };
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); });
  async function mount(companyId: string | null, userId: string | null) {
    flushSync(() => root.render(<QueryClientProvider client={client}><Probe companyId={companyId} userId={userId} /></QueryClientProvider>));
    await flush();
  }

  it("saves the browser zone once when the saved zone differs", async () => {
    mocks.get.mockResolvedValue(preference("a", null));
    mocks.update.mockResolvedValue(preference("a", "America/Chicago"));
    await mount("company", "a");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("company", { timeZone: "America/Chicago" });
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toMatchObject({ timeZone: "America/Chicago" });
    flushSync(() => root.render(<QueryClientProvider client={client}><Probe companyId="other" userId="a" /></QueryClientProvider>));
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer workspace choice when the zone save answers late", async () => {
    mocks.get.mockResolvedValue(preference("a", null));
    let answer!: (value: ReturnType<typeof preference>) => void;
    mocks.update.mockReturnValue(new Promise(resolve => { answer = resolve; }));
    await mount("company", "a");
    client.setQueryData(queryKeys.workspacePreferences.mine("a"), { ...preference("a", null), coordinatorWorkspaceEnabled: false });
    answer(preference("a", "America/Chicago"));
    await flush();
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a")))
      .toMatchObject({ coordinatorWorkspaceEnabled: false, timeZone: "America/Chicago" });
  });

  it("does not write when the zone already matches, without a company, or when signed out", async () => {
    mocks.get.mockResolvedValue(preference("a", "America/Chicago"));
    await mount("company", "a");
    await mount(null, "a");
    await mount("company", null);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("stays silent when saving fails", async () => {
    mocks.get.mockResolvedValue(preference("a", "Europe/Paris"));
    mocks.update.mockRejectedValue(new Error("offline"));
    await mount("company", "a");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.workspacePreferences.mine("a"))).toMatchObject({ timeZone: "Europe/Paris" });
  });
});
