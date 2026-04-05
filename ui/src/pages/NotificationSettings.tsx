import { useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { usePageTitle } from "../hooks/usePageTitle";
import { Button } from "@/components/ui/button";
import { Bell, BellOff, Check, Clock } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NotificationChannel = "in_app" | "email" | "both" | "none";

interface NotificationCategory {
  key: string;
  label: string;
  description: string;
}

interface NotificationPrefs {
  channels: Record<string, NotificationChannel>;
  dndEnabled: boolean;
  dndFrom: string;
  dndTo: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: NotificationCategory[] = [
  { key: "approvals", label: "Approvals", description: "Approval requests and resolution notifications" },
  { key: "agent_failures", label: "Agent Failures", description: "Agent run errors and crash alerts" },
  { key: "task_completions", label: "Task Completions", description: "When agents complete assigned tasks" },
  { key: "mentions", label: "Mentions", description: "When you are mentioned in comments or messages" },
  { key: "budget_alerts", label: "Budget Alerts", description: "Budget threshold warnings and overages" },
];

const CHANNEL_OPTIONS: { value: NotificationChannel; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "in_app", label: "In-app" },
  { value: "email", label: "Email" },
  { value: "none", label: "None" },
];

const STORAGE_KEY = "ironworks:notification-prefs";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as NotificationPrefs;
  } catch {
    // fallback
  }
  const defaults: NotificationPrefs = {
    channels: {},
    dndEnabled: false,
    dndFrom: "22:00",
    dndTo: "08:00",
  };
  for (const cat of CATEGORIES) {
    defaults.channels[cat.key] = "both";
  }
  return defaults;
}

function savePrefs(prefs: NotificationPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotificationSettings() {
  usePageTitle("Notification Settings");
  const { setBreadcrumbs } = useBreadcrumbs();
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Profile", href: "/profile" },
      { label: "Notifications" },
    ]);
  }, [setBreadcrumbs]);

  function updateChannel(key: string, value: NotificationChannel) {
    setPrefs((prev) => ({
      ...prev,
      channels: { ...prev.channels, [key]: value },
    }));
    setSaved(false);
  }

  function toggleDnd() {
    setPrefs((prev) => ({ ...prev, dndEnabled: !prev.dndEnabled }));
    setSaved(false);
  }

  function updateDndTime(field: "dndFrom" | "dndTo", value: string) {
    setPrefs((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  }

  function handleSave() {
    savePrefs(prefs);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notification Preferences
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Choose how and when you receive notifications for each category.
        </p>
      </div>

      {/* Notification channels table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">
                Category
              </th>
              <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3 w-[180px]">
                Delivery
              </th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map((cat) => (
              <tr key={cat.key} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3">
                  <div className="text-sm font-medium">{cat.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{cat.description}</div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {CHANNEL_OPTIONS.map((opt) => {
                      const isActive = prefs.channels[cat.key] === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => updateChannel(cat.key, opt.value)}
                          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                            isActive
                              ? "border-foreground bg-foreground/5 font-medium"
                              : "border-border text-muted-foreground hover:border-foreground/30"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Do Not Disturb */}
      <div className="rounded-lg border border-border p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BellOff className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Do Not Disturb</div>
              <div className="text-xs text-muted-foreground">
                Suppress all notifications during the scheduled window
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={toggleDnd}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
              prefs.dndEnabled ? "bg-foreground" : "bg-muted"
            }`}
            role="switch"
            aria-checked={prefs.dndEnabled}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                prefs.dndEnabled
                  ? "translate-x-5 bg-background"
                  : "translate-x-0 bg-muted-foreground"
              }`}
            />
          </button>
        </div>

        {prefs.dndEnabled && (
          <div className="flex items-center gap-3 pl-6">
            <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">From</span>
              <input
                type="time"
                value={prefs.dndFrom}
                onChange={(e) => updateDndTime("dndFrom", e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <span className="text-muted-foreground">To</span>
              <input
                type="time"
                value={prefs.dndTo}
                onChange={(e) => updateDndTime("dndTo", e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
            </label>
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave}>
          {saved ? (
            <>
              <Check className="h-4 w-4 mr-1.5" />
              Saved
            </>
          ) : (
            "Save preferences"
          )}
        </Button>
        {saved && (
          <span className="text-xs text-green-600 dark:text-green-400">
            Notification preferences updated
          </span>
        )}
      </div>
    </div>
  );
}
