import { t, useTranslation, Trans } from "@/i18n";
import type { ReactNode } from "react";
import type { ProviderFailure } from "@paperclipai/shared";
import { InlineBanner } from "./InlineBanner";

const labels: Record<ProviderFailure["category"], string> = {
  get rate_limit() { return t("final-components-b:Rate_limit_reached_069462"); }, get quota_exhausted() { return t("final-components-b:Usage_allowance_exhausted_d88f7a"); },
  get authentication() { return t("final-components-b:Authentication_failed_93821e"); }, get permission() { return t("final-components-b:Access_denied_cc11d4"); },
  get model_unavailable() { return t("final-components-b:Model_unavailable_10bf73"); }, get invalid_request() { return t("final-components-b:Request_rejected_21b36b"); },
  get overloaded() { return t("final-components-b:Provider_at_capacity_34bff8"); }, get timeout() { return t("final-components-b:Provider_timed_out_4ec654"); }, get unknown() { return t("final-components-b:Provider_error_9ade31"); },
};

export function ProviderFailureNotice({ failure, actions, children, className }: {
  failure: ProviderFailure; actions?: ReactNode; children?: ReactNode; className?: string;
}) {
  useTranslation("task-components");
  const provider = ({ anthropic: "Claude", openai: "OpenAI", sandbox: t("final-components-b:Sandbox_provider") } as Record<string, string>)[failure.provider] ?? failure.provider;
  return (
    <InlineBanner tone="danger" title={`${provider}: ${Object.hasOwn(labels, failure.category) ? labels[failure.category] : failure.category}`} actions={actions} className={className}>
      <div className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap break-words">{failure.message}</p>
        <p className="text-xs text-muted-foreground">
          {failure.phase === "startup" ? t("final-components-b:Failed_before_work_started_a3e52b") : t("final-components-b:Failed_during_work_004bb0")}
          {failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : ""}
          {failure.providerCode ? ` · ${failure.providerCode}` : ""}
        </p>
        {failure.requestId && <p className="font-mono text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_ce4d38414925" components={{ part1: <>{failure.requestId}</> }} /></p>}
        {children}
      </div>
    </InlineBanner>
  );
}
