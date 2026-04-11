import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings } from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [summaryHourDraft, setSummaryHourDraft] = useState("8");
  const [summaryMinuteDraft, setSummaryMinuteDraft] = useState("00");

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to sign out.");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const dailyExecutiveSummarySendHour = generalQuery.data?.dailyExecutiveSummarySendHour ?? 8;
  const dailyExecutiveSummarySendMinute = generalQuery.data?.dailyExecutiveSummarySendMinute ?? 0;

  useEffect(() => {
    setSummaryHourDraft(String(dailyExecutiveSummarySendHour));
    setSummaryMinuteDraft(String(dailyExecutiveSummarySendMinute).padStart(2, "0"));
  }, [dailyExecutiveSummarySendHour, dailyExecutiveSummarySendMinute]);

  const parsedSummaryHour = Number(summaryHourDraft);
  const parsedSummaryMinute = Number(summaryMinuteDraft);
  const scheduleInputValid =
    Number.isInteger(parsedSummaryHour) &&
    Number.isInteger(parsedSummaryMinute) &&
    parsedSummaryHour >= 0 &&
    parsedSummaryHour <= 23 &&
    parsedSummaryMinute >= 0 &&
    parsedSummaryMinute <= 59;
  const scheduleDirty =
    scheduleInputValid &&
    (parsedSummaryHour !== dailyExecutiveSummarySendHour || parsedSummaryMinute !== dailyExecutiveSummarySendMinute);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide defaults that affect how operator-visible logs are displayed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle username log censoring"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Enable app keyboard shortcuts, including inbox navigation and global shortcuts like creating issues or
              toggling panels. This is off by default.
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label="Toggle keyboard shortcuts"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Executive summary send time</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Global daily send time used for company executive summary emails. This uses the server's local timezone.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">
              Hour (0-23)
              <input
                type="number"
                min={0}
                max={23}
                value={summaryHourDraft}
                onChange={(event) => setSummaryHourDraft(event.target.value)}
                className="mt-1 block w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Minute (0-59)
              <input
                type="number"
                min={0}
                max={59}
                value={summaryMinuteDraft}
                onChange={(event) => setSummaryMinuteDraft(event.target.value)}
                className="mt-1 block w-24 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <Button
              type="button"
              size="sm"
              disabled={updateGeneralMutation.isPending || !scheduleInputValid || !scheduleDirty}
              onClick={() =>
                updateGeneralMutation.mutate({
                  dailyExecutiveSummarySendHour: parsedSummaryHour,
                  dailyExecutiveSummarySendMinute: parsedSummaryMinute,
                } satisfies PatchInstanceGeneralSettings)
              }
            >
              {updateGeneralMutation.isPending ? "Saving..." : "Save schedule"}
            </Button>
          </div>
          {!scheduleInputValid ? (
            <p className="text-xs text-destructive">Enter a valid 24-hour time.</p>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">AI feedback sharing</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Control whether thumbs up and thumbs down votes can send the voted AI output to
              Paperclip Labs. Votes are always saved locally.
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Read our terms of service
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              No default is saved yet. The next thumbs up or thumbs down choice will ask once and
              then save the answer here.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: "Always allow",
                description: "Share voted AI outputs automatically.",
              },
              {
                value: "not_allowed",
                label: "Don't allow",
                description: "Keep voted AI outputs local only.",
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            To retest the first-use prompt in local dev, remove the{" "}
            <code>feedbackDataSharingPreference</code> key from the{" "}
            <code>instance_settings.general</code> JSON row for this instance, or set it back to{" "}
            <code>"prompt"</code>. Unset and <code>"prompt"</code> both mean no default has been
            chosen yet.
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Sign out</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Sign out of this Paperclip instance. You will be redirected to the login page.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </section>
    </div>
  );
}
