import { useTranslation } from "@/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  OnboardingCardField,
  OnboardingLoginCodeRow,
  ProviderApiKeyCard,
  ProviderSubscriptionCard,
} from "@/components/AdapterLoginChrome";
import {
  AI_PROVIDERS,
  aiMethodLabel,
  aiProviderSubscriptionLabel,
  type AiAuthMethod,
  type AiProvider,
} from "./model";

/** Redacted view of the existing login lifecycle, supplied by the host. */
export type AiAuthState =
  | { phase: "idle" | "starting" | "submitting" | "connected" | "cancelled" }
  | { phase: "waiting"; authorizationUrl: string; code?: string }
  | { phase: "error" | "expired" | "unsupported"; message: string };

export interface AiConnectionAuthProps {
  provider: AiProvider;
  method: AiAuthMethod;
  state: AiAuthState;
  onStart: () => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onDone: () => void;
}

/** No provider calls or polling here: live hosts keep the existing login controllers. */
export function AiConnectionAuth(props: AiConnectionAuthProps) {
  // Remount private input state when the provider, method, or attempt changes phase.
  return (
    <AuthAttempt
      key={`${props.provider}:${props.method}:${props.state.phase}`}
      {...props}
    />
  );
}

function AuthAttempt({
  provider,
  method,
  state,
  onStart,
  onSubmit,
  onCancel,
  onDone,
}: AiConnectionAuthProps) {
  const { t } = useTranslation("connections");
  const [value, setValue] = useState("");
  const info = AI_PROVIDERS[provider];
  const busy = state.phase === "starting" || state.phase === "submitting";
  const unsupported =
    state.phase === "unsupported" ||
    (method === "subscription" && !info.subscriptionName);
  const submit = () => {
    if (!value.trim() || busy) return;
    const submitted = value.trim();
    setValue("");
    onSubmit(submitted);
  };
  return (
    <section
      aria-label={t("connect_f7689e7", { name: info.name })}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t("connect_f7689e7", { name: info.name })}</h3>
        <p className="text-xs text-muted-foreground">
          {aiMethodLabel(provider, method)}
        </p>
      </div>
      {state.phase === "connected" ? (
        <>
          <p role="status" className="text-sm">{t("connected_this_account_is_saved_in_connections_6e10f5e")}</p>
          <Button onClick={onDone}>{t("use_connection_e484145")}</Button>
        </>
      ) : (
        <>
          {unsupported ? (
            <p role="status" className="text-sm text-muted-foreground">
              {state.phase === "unsupported"
                ? state.message
                : t("this_provider_does_not_offer_a_subscription_eb9f33d")}
            </p>
          ) : (
            <>
              {(state.phase === "error" || state.phase === "expired") && (
                <p role="alert" className="text-sm text-destructive">
                  {state.message}
                </p>
              )}
              {state.phase === "cancelled" && (
                <p role="status" className="text-sm text-muted-foreground">{t("sign_in_cancelled_no_connection_was_created_5e364a6")}</p>
              )}
              {method === "api_key" ? (
                <ProviderApiKeyCard
                  providerName={info.name}
                  value={value}
                  onChange={setValue}
                  onSubmit={submit}
                  placeholder={t("enter_api_key_here_4991fd6")}
                  disabled={busy}
                  autoFocus
                />
              ) : busy ? (
                <ProviderSubscriptionCard
                  providerName={info.name}
                  mode={
                    provider === "anthropic"
                      ? "submitted_code"
                      : "displayed_code"
                  }
                  loading
                >
                  <span />
                </ProviderSubscriptionCard>
              ) : state.phase === "waiting" ? (
                <ProviderSubscriptionCard
                  providerName={info.name}
                  authorizationUrl={state.authorizationUrl}
                  mode={
                    provider === "anthropic"
                      ? "submitted_code"
                      : "displayed_code"
                  }
                >
                  {provider === "anthropic" ? (
                    <OnboardingCardField
                      value={value}
                      onChange={setValue}
                      onSubmit={submit}
                    />
                  ) : (
                    <OnboardingLoginCodeRow code={state.code ?? ""} />
                  )}
                </ProviderSubscriptionCard>
              ) : (
                <p className="text-sm text-muted-foreground">{t("sign_in_with_your_287d242", { subscriptionName: aiProviderSubscriptionLabel(provider) })}</p>
              )}
            </>
          )}
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setValue("");
                onCancel();
              }}
            >{t("cancel_1791a62")}</Button>
            {!unsupported &&
              (method === "api_key" ? (
                <Button disabled={busy || !value.trim()} onClick={submit}>
                  {busy ? t("connecting_fd3e796") : t("connect_b65463c")}
                </Button>
              ) : state.phase === "waiting" ? (
                provider === "anthropic" ? (
                  <Button disabled={!value.trim()} onClick={submit}>{t("submit_code_8b3fa6d")}</Button>
                ) : (
                  <span role="status" className="text-sm text-muted-foreground">{t("waiting_for_sign_in_5a2295d")}</span>
                )
              ) : (
                <Button disabled={busy} onClick={onStart}>
                  {busy
                    ? t("preparing_sign_in_514845a")
                    : state.phase === "idle"
                      ? t("sign_in_ada2e9e")
                      : t("try_again_042c862")}
                </Button>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
