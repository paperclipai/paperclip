// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useCombinedInboxTasksEnabled } from "./useCombinedInboxTasksEnabled";

vi.mock("@/api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("@/api/workspacePreferences", () => ({ workspacePreferencesApi: { get: vi.fn(), update: vi.fn() } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn() } }));

it("retains standalone Inbox in Coordinator and restores the combined preference after opting out", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer" } });
  client.setQueryData(queryKeys.workspacePreferences.mine("viewer"), { userId: "viewer", coordinatorWorkspaceEnabled: true });
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableStreamlinedUi: true, enableCombinedInboxTasks: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  function Probe() { const setting = useCombinedInboxTasksEnabled(); return <p>{setting.loaded ? String(setting.enabled) : "loading"}</p>; }
  try {
    flushSync(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await vi.waitFor(() => expect(host.textContent).toBe("false"));
    flushSync(() => client.setQueryData(queryKeys.workspacePreferences.mine("viewer"), { userId: "viewer", coordinatorWorkspaceEnabled: false }));
    await vi.waitFor(() => expect(host.textContent).toBe("true"));
    expect(client.getQueryData(queryKeys.instance.experimentalSettings)).toMatchObject({ enableCombinedInboxTasks: true });
  } finally { flushSync(() => root.unmount()); client.clear(); host.remove(); }
});
