import { Bell, BellOff, Loader2, ShieldAlert, Smartphone } from "lucide-react";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Card, CardContent } from "@/components/ui/card";

export function PushNotificationSection() {
  const { state, isToggling, enable, disable } = usePushNotifications();

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
            <div className="flex items-center justify-between">
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
