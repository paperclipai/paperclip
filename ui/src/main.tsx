import { VoiceCallProvider } from "./components/voice/VoiceCallProvider";
import { useAccountIdentity } from "./api/companies-query";
import * as React from "react";
import { StrictMode, useEffect } from "react";
import * as ReactDOM from "react-dom";
import { BrowserRouter } from "@/lib/router";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { SentryGate } from "./components/SentryGate";
import { CompanyProvider, useCompany } from "./context/CompanyContext";
import { LinkPreviewProvider } from "./context/LinkPreviewContext";
import { LiveUpdatesProvider } from "./context/LiveUpdatesProvider";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { PanelProvider } from "./context/PanelContext";
import { SidebarProvider } from "./context/SidebarContext";
import { DialogProvider } from "./context/DialogContext";
import { EditorAutocompleteProvider } from "./context/EditorAutocompleteContext";
import { applyLiveEventFreeQueryDefaults } from "./lib/live-reconcile";
import { PrimaryAgentProvider } from "./context/PrimaryAgentProvider";
import { ToastProvider, useToastActions, type ToastInput } from "./context/ToastContext";
import { ThemeProvider } from "./context/ThemeContext";
import { DesignSandboxProvider } from "./context/DesignSandboxContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initPluginBridge } from "./plugins/bridge-init";
import { PluginLauncherProvider } from "./plugins/launchers";
import { startChunkLoadRecovery } from "./lib/chunk-load-recovery";
import { startPerfMeasureReaper } from "./lib/perf-measure-reaper";
import { getOrCreatePaperclipReactRoot } from "./lib/react-root";
import { startServiceWorkerUpdates } from "./lib/service-worker-updates";
import { connectivity } from "./lib/connectivity";
import { bindConnectivity, createAppQueryClient } from "./lib/query-client";
import { captureQueryException } from "./lib/sentry";
import { startPersistedQueryCache } from "./lib/persisted-query-cache";
import { hasPendingWrites, subscribePendingWrites } from "./lib/reload-safety";
import { installInsecureRandomUuid } from "./lib/uuid";
import "@mdxeditor/editor/style.css";
import "./index.css";

// Plain HTTP is not a secure context, so crypto.randomUUID is missing and any
// render that calls it throws. Install the fallback before the first paint.
// The installed function must not call crypto.randomUUID: it is that function.
installInsecureRandomUuid();
initPluginBridge(React, ReactDOM);

// React 19.2 emits an unbounded stream of performance.measure() entries for its
// DevTools performance tracks and never clears them; on a long-lived tab they
// accumulate into millions of native objects (GBs). Reap them periodically.
startPerfMeasureReaper();

startChunkLoadRecovery();

// The global mutation error toast is raised from the MutationCache, outside
// React; the bridge below hands it the ToastProvider's pushToast.
let pushMutationErrorToast: ((input: ToastInput) => void) | null = null;

function MutationErrorToastBridge() {
  const { pushToast } = useToastActions();
  useEffect(() => {
    pushMutationErrorToast = pushToast;
    return () => {
      if (pushMutationErrorToast === pushToast) pushMutationErrorToast = null;
    };
  }, [pushToast]);
  return null;
}

// Retry, pause-on-outage, and error-reporting defaults live in
// lib/query-client.ts; app-specific cache tuning stays here.
const queryClient = createAppQueryClient(
  {
    connectivity,
    reportError: (error, queryKey) => captureQueryException(error, queryKey),
    notifyMutationError: ({ title, body }) => pushMutationErrorToast?.({ title, body, tone: "error" }),
  },
  {
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Explicit so cross-tab-published cache entries for resources this tab
        // isn't observing get collected promptly rather than lingering. Single
        // tuning point if we need to trim the cache footprint further.
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
      },
    },
  },
);
// Instance and personal preference reads have no live events; see live-reconcile.ts.
applyLiveEventFreeQueryDefaults(queryClient);
// Outages pause queries and replayable mutations instead of failing them, and
// live queries refresh once when the server answers again.
bindConnectivity(queryClient, connectivity);
startPersistedQueryCache(queryClient, {
  buildId: typeof __PAPERCLIP_BUILD_COMMIT__ === "string" ? __PAPERCLIP_BUILD_COMMIT__ : null,
});
window.addEventListener("load", () => {
  startServiceWorkerUpdates({
    canReload: () => connectivity.getSnapshot().status === "online"
      && connectivity.getSnapshot().pendingWrites === 0 && queryClient.isMutating() === 0 && !hasPendingWrites(),
    subscribeReloadSafety: listener => {
      const cleanups = [connectivity.subscribe(listener), queryClient.getMutationCache().subscribe(listener), subscribePendingWrites(listener)];
      return () => { for (const cleanup of cleanups) cleanup(); };
    },
  });
});

function CompanyAwareBreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const { selectedCompany } = useCompany();
  return <BreadcrumbProvider companyName={selectedCompany?.name ?? null}>{children}</BreadcrumbProvider>;
}

function CompanyVoiceCalls({ children }: { children: React.ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { userId } = useAccountIdentity();
  return <VoiceCallProvider companyId={selectedCompanyId} userId={userId}>{children}</VoiceCallProvider>;
}

function CompanyLinkPreviews({ children }: { children: React.ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { userId, settled } = useAccountIdentity();
  return <LinkPreviewProvider companyId={settled ? selectedCompanyId : null} userId={userId}>{children}</LinkPreviewProvider>;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Paperclip root element is missing");

getOrCreatePaperclipReactRoot(window, rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <SentryGate />
        <ThemeProvider>
          <BrowserRouter>
            <CompanyProvider>
              <EditorAutocompleteProvider>
                <ToastProvider>
                  <MutationErrorToastBridge />
                  <PrimaryAgentProvider>
                  <LiveUpdatesProvider>
                    <TooltipProvider>
                      <CompanyAwareBreadcrumbProvider>
                        <SidebarProvider>
                          <PanelProvider>
                            <PluginLauncherProvider>
                              <DialogProvider>
                                <DesignSandboxProvider><CompanyVoiceCalls><CompanyLinkPreviews><App /></CompanyLinkPreviews></CompanyVoiceCalls></DesignSandboxProvider>
                              </DialogProvider>
                            </PluginLauncherProvider>
                          </PanelProvider>
                        </SidebarProvider>
                      </CompanyAwareBreadcrumbProvider>
                    </TooltipProvider>
                  </LiveUpdatesProvider>
                  </PrimaryAgentProvider>
                </ToastProvider>
              </EditorAutocompleteProvider>
            </CompanyProvider>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>
);
