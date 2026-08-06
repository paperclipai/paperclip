import { Bell, BellOff, Loader2, ShieldAlert, Smartphone } from "lucide-react";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Card, CardContent } from "@/components/ui/card";

type PushNotificationSectionProps = {
  companyId: string | null;
};

export function PushNotificationSection({ companyId }: PushNotificationSectionProps) {
  const { state, isToggling, subscriptions, enable, disable } = usePushNotifications(companyId);
  const currentEndpoint = state.status === "subscribed" ? state.endpoint : null;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          Push Notifications
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Receive alerts on this device when the board needs your attention.
        </p>
      </div>

      <Card>
        <CardContent className="py-3">
          {state.status === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking push support…
            </div>
          ) : state.status === "unsupported" ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <BellOff className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Push notifications are not supported in this browser.</span>
            </div>
          ) : state.status === "insecure" ? (
            <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Push notifications require a secure context (HTTPS). Access this app via
                your Tailscale HTTPS URL to enable them.
              </span>
            </div>
          ) : state.status === "denied" ? (
            <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
              <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Notification permission was denied. To re-enable, open your browser&apos;s
                site settings for this URL and allow notifications, then reload.
              </span>
            </div>
          ) : state.status === "error" ? (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <BellOff className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{state.message}</span>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-sm font-medium">Enable push notifications</p>
                    <p className="text-xs text-muted-foreground">
                      {state.status === "subscribed"
                        ? "This device is subscribed and will receive alerts."
                        : "This device will not receive push alerts."}
                    </p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={state.status === "subscribed"}
                  onCheckedChange={state.status === "subscribed" ? disable : enable}
                  disabled={isToggling}
                  aria-label="Toggle push notifications"
                />
              </div>
              <div className="border-t pt-3">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Smartphone className="h-3.5 w-3.5" />
                  Subscribed devices
                </div>
                {subscriptions.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No devices are subscribed yet.
                  </p>
                ) : (
                  <ul className="mt-2 divide-y">
                    {subscriptions.map((subscription) => {
                      const isCurrent = subscription.endpoint === currentEndpoint;
                      return (
                        <li
                          key={subscription.id}
                          className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium">
                                {subscription.deviceLabel || "Unnamed device"}
                              </p>
                              {isCurrent ? (
                                <span className="rounded-sm border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                                  This device
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              Added {new Date(subscription.createdAt).toLocaleDateString()}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
