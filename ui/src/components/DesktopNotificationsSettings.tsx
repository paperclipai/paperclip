import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bell } from "lucide-react";
import { useActiveCompanyPrefix, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import {
  bindDesktopNotificationNavigation,
  isDesktopNotificationSupported,
  readDesktopNotificationLevel,
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  sendTestDesktopNotification,
  subscribeDesktopNotificationLevel,
  writeDesktopNotificationLevel,
  type DesktopNotificationLevel,
  type DesktopNotificationPermission,
} from "@/lib/desktop-notifications";

const LEVEL_OPTIONS: RadioCardOption[] = [
  {
    value: "off",
    title: "Off",
    description: "Keep alerts inside Paperclip. This is the default.",
  },
  {
    value: "attention",
    title: "Needs attention",
    description: "Failed runs, warnings, join requests, and requests that need you.",
  },
  {
    value: "all",
    title: "All",
    description: "Every in-app toast that already passed the live-update gates.",
  },
];

function permissionCopy(permission: DesktopNotificationPermission, supported: boolean): string {
  if (!supported || permission === "unsupported") {
    return "This browser cannot show desktop notifications. Use a current browser on a secure origin (HTTPS or localhost).";
  }
  if (permission === "denied") {
    return "Notifications are blocked for this site. Allow them in your browser site settings, then try again.";
  }
  if (permission === "granted") {
    return "This browser allowed Paperclip to show notifications.";
  }
  return "The browser will ask for permission when you enable this.";
}

export function DesktopNotificationNavigationBinder() {
  const navigate = useNavigate();
  const companyPrefix = useActiveCompanyPrefix();
  useEffect(() => {
    bindDesktopNotificationNavigation((href) => {
      navigate(href);
    }, companyPrefix);
    return () => bindDesktopNotificationNavigation(null);
  }, [navigate, companyPrefix]);
  return null;
}

export function DesktopNotificationsSettings() {
  const level = useSyncExternalStore(
    subscribeDesktopNotificationLevel,
    readDesktopNotificationLevel,
    (): DesktopNotificationLevel => "off",
  );
  const [permission, setPermission] = useState<DesktopNotificationPermission>(() => readDesktopNotificationPermission());
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectionSeq = useRef(0);
  const supported = isDesktopNotificationSupported();

  async function enableLevel(next: DesktopNotificationLevel) {
    const requestId = ++selectionSeq.current;
    setSaveError(null);
    let nextPermission = readDesktopNotificationPermission();
    if (next !== "off" && nextPermission !== "granted" && nextPermission !== "unsupported") {
      nextPermission = await requestDesktopNotificationPermission();
    }
    if (requestId !== selectionSeq.current) return;
    setPermission(nextPermission);
    if (!writeDesktopNotificationLevel(next)) {
      setSaveError("This browser could not save the notification choice. Check that site data is allowed, then try again.");
    }
  }

  async function onTest() {
    let nextPermission = readDesktopNotificationPermission();
    if (nextPermission !== "granted" && nextPermission !== "unsupported") {
      nextPermission = await requestDesktopNotificationPermission();
    }
    setPermission(nextPermission);
    sendTestDesktopNotification();
  }

  return (
    <section className="space-y-4" aria-label="Desktop notifications">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Desktop notifications</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Show a system notification when Paperclip is open in another tab. Off by default. This browser stores the choice locally.
        </p>
      </div>

      <RadioCardGroup
        ariaLabel="Desktop notification level"
        value={level}
        onValueChange={(value) => {
          void enableLevel(value as DesktopNotificationLevel);
        }}
        options={LEVEL_OPTIONS}
        className="max-w-2xl"
        disabled={!supported}
      />

      <p className="max-w-2xl text-sm text-muted-foreground" role="status">
        {permissionCopy(permission, supported)}
      </p>

      {saveError ? (
        <p className="max-w-2xl text-sm text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="flex max-w-2xl">
        <Button type="button" variant="outline" onClick={() => void onTest()} disabled={!supported}>
          Send test notification
        </Button>
      </div>
    </section>
  );
}
