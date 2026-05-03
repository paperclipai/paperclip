import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Camera,
  LoaderCircle,
  Save,
  Send,
  Smartphone,
  Trash2,
  UserRoundPen,
} from "lucide-react";
import type { AuthSession, CurrentUserProfile, UpdateCurrentUserProfile } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { assetsApi } from "@/api/assets";
import { notificationsApi, type PushSubscriptionRow } from "@/api/notifications";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProfileSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const avatarInputId = useId();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Profile" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    setName(session.user.name ?? "");
    setImage(session.user.image ?? "");
  }, [sessionQuery.data]);

  function syncSessionProfile(profile: CurrentUserProfile) {
    queryClient.setQueryData<AuthSession | null>(queryKeys.auth.session, (current) => {
      if (!current) return current;
      return {
        ...current,
        user: {
          ...current.user,
          ...profile,
        },
      };
    });
  }

  async function persistProfile(input: UpdateCurrentUserProfile) {
    const profile = await authApi.updateProfile(input);
    syncSessionProfile(profile);
    return profile;
  }

  function resolveProfileName() {
    return name.trim() || sessionQuery.data?.user.name || "Board";
  }

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCurrentUserProfile) => persistProfile(input),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update profile.");
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) {
        throw new Error("Select a company before uploading a profile avatar.");
      }

      const asset = await assetsApi.uploadImage(
        selectedCompanyId,
        file,
        `profiles/${sessionQuery.data?.user.id ?? "board-user"}`,
      );
      return persistProfile({ name: resolveProfileName(), image: asset.contentPath });
    },
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to upload avatar.");
    },
  });

  const removeAvatarMutation = useMutation({
    mutationFn: () => persistProfile({ name: resolveProfileName(), image: null }),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to remove avatar.");
    },
  });

  if (sessionQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading profile...</div>;
  }

  if (sessionQuery.error || !sessionQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {sessionQuery.error instanceof Error ? sessionQuery.error.message : "Failed to load profile."}
      </div>
    );
  }

  const currentName = name.trim() || sessionQuery.data.user.name || "Board";
  const currentImage = image.trim() || null;
  const initials = deriveInitials(currentName);
  const isSavingProfile = updateMutation.isPending || uploadAvatarMutation.isPending || removeAvatarMutation.isPending;
  const uploadHint = selectedCompany
    ? `Stored in Paperclip file storage for ${selectedCompany.name}.`
    : "Select a company to upload an avatar into Paperclip storage.";

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRoundPen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Profile</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Control how your account appears in the sidebar and other board surfaces.
        </p>
      </div>

      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <section className="space-y-8">
        <div className="relative overflow-hidden rounded-[28px] border border-border/70 bg-card shadow-sm">
          <div className="absolute inset-x-0 top-0 h-32 bg-[linear-gradient(135deg,hsl(var(--primary))_0%,hsl(var(--accent))_58%,color-mix(in_oklab,hsl(var(--background))_76%,white_24%)_100%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.22),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.08),transparent_36%)]" />
          <div className="relative p-6 pt-10">
            <div className="flex flex-wrap items-end gap-5 rounded-[24px] border border-border/70 bg-background/92 p-5 shadow-[0_18px_44px_-28px_rgba(0,0,0,0.45)] backdrop-blur-sm">
              <div className="space-y-3">
                <label
                  htmlFor={avatarInputId}
                  className="group relative block cursor-pointer rounded-full focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background"
                >
                  <input
                    ref={avatarInputRef}
                    id={avatarInputId}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={!selectedCompanyId || isSavingProfile}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      uploadAvatarMutation.mutate(file);
                      event.target.value = "";
                    }}
                  />
                  <span className="absolute inset-0 z-10 rounded-full bg-black/0 transition-colors group-hover:bg-black/14 group-focus-within:bg-black/14" />
                  <span className="absolute bottom-1 right-1 z-20 flex size-9 items-center justify-center rounded-full border border-background bg-primary text-primary-foreground shadow-sm">
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                  </span>
                  <Avatar size="lg" className="data-[size=lg]:size-24 ring-4 ring-background shadow-xl">
                    {currentImage ? <AvatarImage src={currentImage} alt={currentName} /> : null}
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={!selectedCompanyId || isSavingProfile}
                  >
                    {uploadAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Camera className="size-4" />}
                    {currentImage ? "Change photo" : "Upload photo"}
                  </Button>
                  {currentImage ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeAvatarMutation.mutate()}
                      disabled={isSavingProfile}
                    >
                      {removeAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-2 pb-1">
                <div>
                  <h2 className="truncate text-2xl font-semibold text-foreground">{currentName}</h2>
                  <p className="truncate text-sm text-muted-foreground">{sessionQuery.data.user.email ?? "No email"}</p>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  Click the avatar to upload a new image. {uploadHint}
                </p>
              </div>
            </div>
          </div>
        </div>

        <form
          className="grid gap-6 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            updateMutation.mutate({ name: resolveProfileName(), image: image.trim() || null });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="profile-name">Display name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder="Board"
            />
            <p className="text-xs text-muted-foreground">
              Shown in the sidebar account footer and comment author surfaces.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">Email</Label>
            <Input
              id="profile-email"
              value={sessionQuery.data.user.email ?? ""}
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              Email is managed by your auth session and is read-only here.
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={isSavingProfile || !name.trim()}>
              {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {updateMutation.isPending ? "Saving..." : "Save profile"}
            </Button>
          </div>
        </form>

        <NotificationsSection />

        <TwoFactorSection />
      </section>
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return window
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function detectIosNonStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/.test(ua);
  if (!isIos) return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return !standalone;
}

function describeDevice(row: PushSubscriptionRow): string {
  const ua = row.userAgent ?? "";
  if (!ua) return "Unknown device";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return ua.slice(0, 40);
}

function NotificationsSection() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pushSupported, setPushSupported] = useState<boolean>(false);
  const [permission, setPermission] = useState<NotificationPermission | "default">("default");
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const iosNonStandalone = useMemo(() => detectIosNonStandalone(), []);

  useEffect(() => {
    const supported =
      typeof window !== "undefined"
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
    setPushSupported(supported);
    if (supported) {
      setPermission(Notification.permission);
    }

    let cancelled = false;
    if (supported) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          if (cancelled) return;
          setCurrentEndpoint(sub?.endpoint ?? null);
        })
        .catch(() => {
          if (cancelled) return;
          setCurrentEndpoint(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const subscriptionsQuery = useQuery({
    queryKey: queryKeys.notifications.subscriptions,
    queryFn: () => notificationsApi.list(),
    enabled: pushSupported,
  });

  const vapidQuery = useQuery({
    queryKey: queryKeys.notifications.vapidPublicKey,
    queryFn: () => notificationsApi.vapidPublicKey(),
    enabled: pushSupported,
    staleTime: Infinity,
  });

  async function enablePush() {
    setError(null);
    setInfo(null);
    if (!pushSupported) {
      setError("Push notifications are not supported in this browser.");
      return;
    }
    if (!vapidQuery.data?.publicKey) {
      setError("Server is missing VAPID public key — ask an admin to configure WEB_PUSH_VAPID_PUBLIC.");
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError("Notification permission denied. Re-enable in your browser settings to subscribe.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await existing.unsubscribe().catch(() => {});
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidQuery.data.publicKey),
      });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const endpoint = json.endpoint ?? sub.endpoint;
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        const rawP256 = sub.getKey("p256dh");
        const rawAuth = sub.getKey("auth");
        if (!rawP256 || !rawAuth) {
          throw new Error("Browser did not return push keys.");
        }
        await notificationsApi.subscribe({
          endpoint: sub.endpoint,
          keys: {
            p256dh: arrayBufferToBase64Url(rawP256),
            auth: arrayBufferToBase64Url(rawAuth),
          },
        });
      } else {
        await notificationsApi.subscribe({ endpoint, keys: { p256dh, auth } });
      }
      setCurrentEndpoint(sub.endpoint);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.subscriptions });
      setInfo("Notifications enabled on this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disableThisDevice() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await notificationsApi.unsubscribe(endpoint).catch(() => {});
      }
      setCurrentEndpoint(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.subscriptions });
      setInfo("Notifications disabled on this device.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  const revokeMutation = useMutation({
    mutationFn: async (endpoint: string) => {
      await notificationsApi.unsubscribe(endpoint);
      if (endpoint === currentEndpoint && pushSupported) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe().catch(() => {});
        }
        setCurrentEndpoint(null);
      }
    },
    onSuccess: async () => {
      setError(null);
      setInfo("Device removed.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.notifications.subscriptions });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to remove device.");
    },
  });

  const testMutation = useMutation({
    mutationFn: () => notificationsApi.test(),
    onSuccess: (result) => {
      setError(null);
      setInfo(
        result.sent > 0
          ? `Test sent to ${result.sent} device${result.sent === 1 ? "" : "s"}.`
          : "No subscribed devices to send to.",
      );
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to send test notification.");
    },
  });

  const enabledOnThisDevice = !!currentEndpoint && permission === "granted";
  const subscriptions = subscriptionsQuery.data ?? [];

  return (
    <div className="mt-8 border-t pt-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          Notifications
        </h2>
        <p className="text-sm text-muted-foreground">
          Get push alerts on your phone or desktop for assignments, @mentions, and deadline starts.
        </p>
      </div>

      {iosNonStandalone ? (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Add to Home Screen first</p>
              <p>
                On iPhone or iPad, push notifications only work after you install Paperclip as a PWA.
                Open this site in Safari, tap the Share icon, then choose <span className="font-medium">Add to Home Screen</span>.
                Once launched from the home screen, return here to enable notifications.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {!pushSupported ? (
        <p className="text-sm text-muted-foreground">
          This browser doesn't support web push notifications.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Notifications on this device</p>
              <p className="text-xs text-muted-foreground">
                {permission === "denied"
                  ? "Permission was denied. Re-enable in your browser site settings to subscribe."
                  : enabledOnThisDevice
                    ? "You'll receive notifications here even when the tab is closed."
                    : "Enable to receive push notifications on this browser/device."}
              </p>
            </div>
            <ToggleSwitch
              checked={enabledOnThisDevice}
              disabled={busy || permission === "denied"}
              onCheckedChange={(checked) => {
                if (checked) {
                  void enablePush();
                } else {
                  void disableThisDevice();
                }
              }}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || subscriptions.length === 0}
            >
              {testMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send test notification
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Devices subscribed to your account
            </p>
            {subscriptionsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading devices...</p>
            ) : subscriptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No devices yet. Enable notifications above on each browser or phone you want alerts on.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {subscriptions.map((row) => {
                  const isThisDevice = row.endpoint === currentEndpoint;
                  return (
                    <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          {describeDevice(row)}
                          {isThisDevice ? (
                            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">
                              This device
                            </span>
                          ) : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          Added {new Date(row.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => revokeMutation.mutate(row.endpoint)}
                        disabled={revokeMutation.isPending}
                      >
                        <BellOff className="size-4" />
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {info ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{info}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function TwoFactorSection() {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const enabled = Boolean(
    (sessionQuery.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled,
  );

  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const enableMutation = useMutation({
    mutationFn: () => authApi.twoFactor.enable({ password }),
    onSuccess: (result) => {
      setTotpUri(result?.totpURI ?? null);
      setBackupCodes(result?.backupCodes ?? null);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Enable failed"),
  });

  const verifyMutation = useMutation({
    mutationFn: () => authApi.twoFactor.verifyTotp({ code: verifyCode.trim() }),
    onSuccess: async () => {
      setTotpUri(null);
      setVerifyCode("");
      setPassword("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Verification failed"),
  });

  const disableMutation = useMutation({
    mutationFn: () => authApi.twoFactor.disable({ password }),
    onSuccess: async () => {
      setPassword("");
      setBackupCodes(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Disable failed"),
  });

  return (
    <div className="mt-8 border-t pt-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">Two-factor authentication</h2>
        <p className="text-sm text-muted-foreground">
          {enabled ? "2FA is enabled on your account." : "Add a TOTP authenticator to protect your sign-in."}
        </p>
      </div>

      {totpUri ? (
        <div className="space-y-3 rounded-md border p-4">
          <p className="text-sm">
            Scan this URI in your authenticator app, then enter the 6-digit code to confirm.
          </p>
          <code className="block break-all text-xs bg-muted p-2 rounded">{totpUri}</code>
          {backupCodes && (
            <div>
              <p className="text-sm font-medium">Backup codes (save these):</p>
              <pre className="text-xs bg-muted p-2 rounded">{backupCodes.join("\n")}</pre>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="6-digit code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              className="max-w-[160px] font-mono"
            />
            <Button
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending || verifyCode.trim().length < 6}
            >
              Verify & activate
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="tfa-password" className="text-xs">Password</Label>
            <Input
              id="tfa-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1"
            />
          </div>
          {enabled ? (
            <Button
              variant="destructive"
              onClick={() => disableMutation.mutate()}
              disabled={disableMutation.isPending || !password}
            >
              Disable 2FA
            </Button>
          ) : (
            <Button
              onClick={() => enableMutation.mutate()}
              disabled={enableMutation.isPending || !password}
            >
              Enable 2FA
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
