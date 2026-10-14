import { useEffect, type ReactNode } from "react";

export function FileRecoveryApiFixture({ response, children }: { response: "success" | "conflict"; children: ReactNode }) {
  useEffect(() => {
    const originalFetch = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(rawUrl, window.location.origin).pathname !== "/api/issues/storybook-recovery/recovery-actions/resolve") return originalFetch(input, init);
      if (response === "conflict") return Response.json({ error: "The original execution is not verified stopped." }, { status: 409 });
      const body = JSON.parse(String(init?.body));
      if (body.sourceIssueStatus !== "in_review" || body.executionReconciliation?.runId !== "stopped-run") return Response.json({ error: "Recovery source changed." }, { status: 409 });
      return Response.json({ outcome: "restored", sourceIssueStatus: "in_review" });
    };
    window.fetch = fixtureFetch;
    return () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; };
  }, [response]);
  return children;
}
