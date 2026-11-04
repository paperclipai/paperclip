import type { ReactNode } from "react";
import type { ProviderFailure } from "@paperclipai/shared";
import { InlineBanner } from "./InlineBanner";

const labels: Record<ProviderFailure["category"], string> = {
  rate_limit: "Rate limit reached", quota_exhausted: "Usage allowance exhausted",
  authentication: "Authentication failed", permission: "Access denied",
  model_unavailable: "Model unavailable", invalid_request: "Request rejected",
  overloaded: "Provider at capacity", timeout: "Provider timed out", unknown: "Provider error",
};

export function ProviderFailureNotice({ failure, actions, children, className }: {
  failure: ProviderFailure; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  const provider = ({ anthropic: "Claude", openai: "OpenAI" } as Record<string, string>)[failure.provider] ?? failure.provider;
  return (
    <InlineBanner tone="danger" title={`${provider}: ${labels[failure.category]}`} actions={actions} className={className}>
      <div className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap break-words">{failure.message}</p>
        <p className="text-xs text-muted-foreground">
          {failure.phase === "startup" ? "Failed before work started" : "Failed during work"}
          {failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : ""}
          {failure.providerCode ? ` · ${failure.providerCode}` : ""}
        </p>
        {failure.requestId && <p className="font-mono text-xs text-muted-foreground">Request: {failure.requestId}</p>}
        {children}
      </div>
    </InlineBanner>
  );
}
