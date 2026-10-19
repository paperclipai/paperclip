import { useLayoutEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { recoveryAction } from "../workspace-finalization-recovery/fixtures";

export type RecoveryFixtureState = "blocked" | "automatic" | "expired" | "recorded" | "rejected" | "unavailable";

export function RecoveryNoticeFixture({ state = "blocked", children }: {
  state?: RecoveryFixtureState; children: ReactNode;
}) {
  const action: IssueRecoveryAction = {
    ...recoveryAction, id: "recovery", sourceIssueId: "storybook-recovery",
    evidence: { runId: "stopped-run", automaticRecovery: { replay: ["automatic", "expired", "unavailable"].includes(state) ? "held" : "blocked" } },
    ...(["automatic", "expired", "unavailable"].includes(state) ? {
      status: "active", ownerType: "agent", attemptCount: 1, maxAttempts: 3,
      wakePolicy: { kind: "resume_native_run", runId: "stopped-run", attempt: 1, maxAttempts: 3, notBefore: "2020-01-01T00:00:00Z" },
      nativeRunActivity: state !== "expired" ? { runId: "stopped-run", status: "running", workspaceOperationId: null } : null,
    } : {}),
    resolutionNote: state === "recorded" ? "The recovered workspace was verified. External actions still require inspection before continuation."
      : state === "rejected" ? "The previous execution could not be verified stopped. The original workspace remains held." : null,
  };
  const response = { active: action.status === "active" ? action : null, actions: [action] };
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    queryClient.setQueryData(queryKeys.issues.runs("storybook-recovery"), [
      { runId: "stopped-run", agentId: "agent", status: state === "automatic" ? "running" : "failed" },
    ]);
    queryClient.setQueryData(queryKeys.issues.recoveryActions("storybook-recovery", "recovery", "stopped-run"), response);
    queryClient.setQueryData(queryKeys.issues.attachments("storybook-recovery"), [
      { id: "saved-source", originalFilename: "test-audit.patch", byteSize: 4096 },
    ]);
    return queryClient;
  });
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(rawUrl, window.location.origin).pathname;
      if (path === "/api/issues/storybook-recovery/recovery-actions" && (!init?.method || init.method === "GET")) {
        return state === "unavailable" ? Response.json({ error: "Recovery service unavailable" }, { status: 503 }) : Response.json(response);
      }
      return originalFetch(input, init);
    };
    window.fetch = fixtureFetch;
    if (state === "unavailable") void client.refetchQueries({ queryKey: queryKeys.issues.recoveryActions("storybook-recovery", "recovery", "stopped-run") });
    return () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; client.clear(); };
  }, [client, state]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
