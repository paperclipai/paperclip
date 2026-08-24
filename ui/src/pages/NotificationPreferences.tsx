import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, LoaderCircle, Save } from "lucide-react";
import type {
  NotificationType,
  NotificationChannel,
  NotificationPreference,
  NotificationPreferenceUpsertInput,
  DigestFrequency,
} from "@paperclipai/shared";
import { NOTIFICATION_TYPES, NOTIFICATION_CHANNELS, DIGEST_FREQUENCIES } from "@paperclipai/shared";
import { notificationsApi } from "@/api/notifications";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { usePageMeta } from "../hooks/usePageMeta";

const TYPE_LABELS: Record<NotificationType, string> = {
  review_requested: "Review requested",
  approval_needed: "Approval needed",
  work_completed: "Work completed",
  budget_threshold: "Budget threshold",
  execution_error: "Execution error",
};

const TYPE_DESCRIPTIONS: Record<NotificationType, string> = {
  review_requested: "An agent requests human review of completed work.",
  approval_needed: "A human approval is required before work can proceed.",
  work_completed: "An agent finishes assigned work.",
  budget_threshold: "Spending approaches or exceeds a budget limit.",
  execution_error: "An agent run fails or times out during execution.",
};

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: "In-app",
  email: "Email",
  webpush: "Push notification",
};

const FREQUENCY_LABELS: Record<DigestFrequency, string> = {
  never: "Never",
  instant: "Instant",
  daily: "Daily digest",
  weekly: "Weekly digest",
};

function buildInitialPrefs(
  existing: NotificationPreference[],
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const nt of NOTIFICATION_TYPES) {
    for (const ch of NOTIFICATION_CHANNELS) {
      const key = `${nt}:${ch}`;
      const pref = existing.find(
        (p) => p.notificationType === nt && p.channel === ch,
      );
      map[key] = pref?.enabled ?? false;
    }
  }
  return map;
}

function buildInitialDigest(
  existing: NotificationPreference[],
): Record<string, DigestFrequency> {
  const map: Record<string, DigestFrequency> = {};
  for (const nt of NOTIFICATION_TYPES) {
    const prefs = existing.filter((p) => p.notificationType === nt);
    const digest = prefs.find((p) => p.digestFrequency !== null)?.digestFrequency;
    map[nt] = (digest as DigestFrequency) ?? "instant";
  }
  return map;
}

export function NotificationPreferences() {
  const { setBreadcrumbs } = useBreadcrumbs();
  usePageMeta("Notification Preferences", "Configure your notification preferences.");
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState(false);

  const [channelEnabled, setChannelEnabled] = useState<
    Record<string, boolean>
  >({});
  const [digestFreq, setDigestFreq] = useState<Record<string, DigestFrequency>>({});

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Notifications" },
    ]);
  }, [setBreadcrumbs]);

  const prefsQuery = useQuery({
    queryKey: queryKeys.notifications.preferences(selectedCompanyId!),
    queryFn: () => notificationsApi.getPreferences(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  // Initialise local state once data arrives
  useEffect(() => {
    if (prefsQuery.data) {
      setChannelEnabled(buildInitialPrefs(prefsQuery.data));
      setDigestFreq(buildInitialDigest(prefsQuery.data));
    }
  }, [prefsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      const prefs: NotificationPreferenceUpsertInput[] = [];
      for (const nt of NOTIFICATION_TYPES) {
        for (const ch of NOTIFICATION_CHANNELS) {
          const key = `${nt}:${ch}`;
          prefs.push({
            notificationType: nt,
            channel: ch,
            enabled: channelEnabled[key] ?? false,
            digestFrequency: ch === "email" ? digestFreq[nt] : null,
          });
        }
      }
      return notificationsApi.upsertPreferences(selectedCompanyId, prefs);
    },
    onSuccess: () => {
      setActionError(null);
      setActionSuccess(true);
      setTimeout(() => setActionSuccess(false), 3000);
      queryClient.invalidateQueries({
        queryKey: queryKeys.notifications.preferences(selectedCompanyId!),
      });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to save preferences.");
      setActionSuccess(false);
    },
  });

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a company to configure notification preferences.
      </div>
    );
  }

  if (prefsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Loading preferences...
      </div>
    );
  }

  if (prefsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {prefsQuery.error instanceof Error
          ? prefsQuery.error.message
          : "Failed to load notification preferences."}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Notification preferences</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Choose which channels you want to receive notifications on for each type of event.
          In-app notifications are delivered to the board. Email and push require configuration
          on the server (SMTP and VAPID keys).
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="rounded-md border border-green-500/40 bg-green-500/5 px-3 py-2 text-sm text-green-600">
          Preferences saved successfully.
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Table header */}
        <div className="grid grid-cols-[1fr_repeat(3,auto)_auto] gap-0 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <div>Event type</div>
          {NOTIFICATION_CHANNELS.map((ch) => (
            <div key={ch} className="w-24 text-center">
              {CHANNEL_LABELS[ch]}
            </div>
          ))}
          <div className="w-32 text-center">Email digest</div>
        </div>

        {/* Rows */}
        {NOTIFICATION_TYPES.map((nt) => (
          <div
            key={nt}
            className="grid grid-cols-[1fr_repeat(3,auto)_auto] gap-0 border-b border-border/60 px-4 py-3 last:border-b-0"
          >
            <div className="self-center pr-4">
              <div className="text-sm font-medium">{TYPE_LABELS[nt]}</div>
              <div className="text-xs text-muted-foreground">
                {TYPE_DESCRIPTIONS[nt]}
              </div>
            </div>

            {NOTIFICATION_CHANNELS.map((ch) => {
              const key = `${nt}:${ch}`;
              return (
                <div key={ch} className="flex w-24 items-center justify-center">
                  <ToggleSwitch
                    checked={channelEnabled[key] ?? false}
                    onCheckedChange={(checked) =>
                      setChannelEnabled((prev) => ({ ...prev, [key]: checked }))
                    }
                    aria-label={`${TYPE_LABELS[nt]} ${CHANNEL_LABELS[ch]}`}
                  />
                </div>
              );
            })}

            <div className="flex w-32 items-center justify-center">
              <select
                value={digestFreq[nt] ?? "instant"}
                onChange={(e) =>
                  setDigestFreq((prev) => ({
                    ...prev,
                    [nt]: e.target.value as DigestFrequency,
                  }))
                }
                className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
                aria-label={`${TYPE_LABELS[nt]} digest frequency`}
              >
                {DIGEST_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </section>

      <div className="flex items-center justify-end gap-3">
        <Button
          variant="default"
          size="sm"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? (
            <>
              <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="mr-1.5 h-3.5 w-3.5" />
              Save preferences
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
