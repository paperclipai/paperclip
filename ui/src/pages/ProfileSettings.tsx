import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { User, Lock, Globe, Check, AlertTriangle, Bell } from "lucide-react";

// ---------------------------------------------------------------------------
// Timezone options (major US + international zones)
// ---------------------------------------------------------------------------

const TIMEZONE_OPTIONS = [
  { value: "America/Chicago", label: "Central Time (CT)" },
  { value: "America/New_York", label: "Eastern Time (ET)" },
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)" },
  { value: "America/Anchorage", label: "Alaska Time (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii Time (HT)" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Shanghai", label: "Shanghai (CST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
];

// ---------------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "ironworks:profile";
const nameKey = `${STORAGE_PREFIX}:displayName`;
const emailKey = `${STORAGE_PREFIX}:email`;
const tzKey = `${STORAGE_PREFIX}:timezone`;

function loadProfile() {
  return {
    displayName: localStorage.getItem(nameKey) ?? "",
    email: localStorage.getItem(emailKey) ?? "admin@ironworks.local",
    timezone: localStorage.getItem(tzKey) ?? "America/Chicago",
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validatePassword(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 8) issues.push("Must be at least 8 characters");
  if (!/[A-Z]/.test(password)) issues.push("Must contain an uppercase letter");
  if (!/[a-z]/.test(password)) issues.push("Must contain a lowercase letter");
  if (!/[0-9]/.test(password)) issues.push("Must contain a number");
  return issues;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProfileSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [profileSaved, setProfileSaved] = useState(false);

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordErrors, setPasswordErrors] = useState<string[]>([]);
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Profile" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const profile = loadProfile();
    setDisplayName(profile.displayName);
    setEmail(profile.email);
    setTimezone(profile.timezone);
  }, []);

  function handleSaveProfile() {
    if (!displayName.trim()) return;
    localStorage.setItem(nameKey, displayName.trim());
    localStorage.setItem(tzKey, timezone);
    setProfileSaved(true);
    pushToast({ title: "Profile updated", tone: "success" });
    setTimeout(() => setProfileSaved(false), 2000);
  }

  function handleChangePassword() {
    const issues = validatePassword(newPassword);
    if (!currentPassword) {
      issues.unshift("Current password is required");
    }
    if (newPassword !== confirmPassword) {
      issues.push("Passwords do not match");
    }
    if (issues.length > 0) {
      setPasswordErrors(issues);
      return;
    }
    setPasswordErrors([]);
    // In a real app this would call an API. For now, just confirm.
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordSaved(true);
    pushToast({ title: "Password changed", tone: "success" });
    setTimeout(() => setPasswordSaved(false), 2000);
  }

  const profileDirty = (() => {
    const saved = loadProfile();
    return (
      displayName !== saved.displayName || timezone !== saved.timezone
    );
  })();

  const nameError =
    displayName.length > 0 && displayName.trim().length === 0
      ? "Name cannot be blank"
      : null;

  return (
    <div className="p-6 max-w-2xl space-y-8">
      {/* Header */}
      <div className="flex items-center gap-2">
        <User className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">
          Account & Profile
        </h1>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link to="/notifications">
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            Notification Preferences
          </Link>
        </Button>
      </div>

      {/* Profile form */}
      <div className="rounded-lg border border-border p-5 space-y-5">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Profile</h2>
        </div>

        <div className="space-y-4">
          {/* Display name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Display name</label>
            <input
              className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
                nameError
                  ? "border-destructive focus:border-destructive"
                  : "border-border focus:border-primary"
              }`}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name"
            />
            {nameError && (
              <p className="text-xs text-destructive">{nameError}</p>
            )}
          </div>

          {/* Email (read-only) */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Email</label>
            <input
              className="w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-sm outline-none text-muted-foreground cursor-not-allowed"
              value={email}
              readOnly
              tabIndex={-1}
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed here. Contact your administrator.
            </p>
          </div>

          {/* Timezone */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              Timezone preference
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleSaveProfile}
            disabled={!displayName.trim() || !!nameError || !profileDirty}
          >
            Save Profile
          </Button>
          {profileSaved && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
        </div>
      </div>

      {/* Change password */}
      <div className="rounded-lg border border-border p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Change Password</h2>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Current password</label>
            <input
              type="password"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-primary"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">New password</label>
            <input
              type="password"
              className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
                newPassword && validatePassword(newPassword).length > 0
                  ? "border-amber-500 focus:border-amber-500"
                  : "border-border focus:border-primary"
              }`}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              autoComplete="new-password"
            />
            {newPassword && validatePassword(newPassword).length > 0 && (
              <div className="space-y-0.5 mt-1">
                {validatePassword(newPassword).map((issue) => (
                  <p
                    key={issue}
                    className="text-[11px] text-amber-600 dark:text-amber-400"
                  >
                    - {issue}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Confirm new password</label>
            <input
              type="password"
              className={`w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none ${
                confirmPassword && confirmPassword !== newPassword
                  ? "border-destructive focus:border-destructive"
                  : "border-border focus:border-primary"
              }`}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
            />
            {confirmPassword && confirmPassword !== newPassword && (
              <p className="text-xs text-destructive">
                Passwords do not match
              </p>
            )}
          </div>
        </div>

        {passwordErrors.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {passwordErrors.map((err) => (
                <p key={err} className="text-xs text-destructive">
                  {err}
                </p>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleChangePassword}
            disabled={!currentPassword || !newPassword || !confirmPassword}
          >
            Change Password
          </Button>
          {passwordSaved && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <Check className="h-3 w-3" />
              Password changed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
