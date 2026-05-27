import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, LoaderCircle, Save, Trash2, UserRoundPen } from "lucide-react";
import type { AuthSession, CurrentUserProfile, UpdateCurrentUserProfile } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import type { SupportedLocale } from "@/i18n/locales";
import { authApi } from "@/api/auth";
import { assetsApi } from "@/api/assets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProfileSettings() {
  const { t } = useTranslation();
  const { locale, setLocale, supportedLocales } = useLocale();
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
      { label: t("breadcrumbs.instanceSettings", { ns: "common", defaultValue: "Instance Settings" }) },
      { label: t("breadcrumbs.profile", { ns: "common", defaultValue: "Profile" }) },
    ]);
  }, [setBreadcrumbs, t]);

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
    return name.trim() || sessionQuery.data?.user.name || t("profile.fields.displayNamePlaceholder", {
      ns: "settings",
      defaultValue: "Board",
    });
  }

  const updateMutation = useMutation({
    mutationFn: (input: UpdateCurrentUserProfile) => persistProfile(input),
    onSuccess: (profile) => {
      setActionError(null);
      setName(profile.name ?? "");
      setImage(profile.image ?? "");
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : t("profile.errors.update", {
        ns: "settings",
        defaultValue: "Failed to update profile.",
      }));
    },
  });

  const uploadAvatarMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) {
        throw new Error(t("profile.errors.selectCompany", {
          ns: "settings",
          defaultValue: "Select a company before uploading a profile avatar.",
        }));
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
      setActionError(error instanceof Error ? error.message : t("profile.errors.upload", {
        ns: "settings",
        defaultValue: "Failed to upload avatar.",
      }));
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
      setActionError(error instanceof Error ? error.message : t("profile.errors.remove", {
        ns: "settings",
        defaultValue: "Failed to remove avatar.",
      }));
    },
  });

  if (sessionQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("profile.loading", { ns: "settings", defaultValue: "Loading profile..." })}
      </div>
    );
  }

  if (sessionQuery.error || !sessionQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {sessionQuery.error instanceof Error
          ? sessionQuery.error.message
          : t("profile.errors.load", {
              ns: "settings",
              defaultValue: "Failed to load profile.",
            })}
      </div>
    );
  }

  const currentName = name.trim() || sessionQuery.data.user.name || t("profile.fields.displayNamePlaceholder", {
    ns: "settings",
    defaultValue: "Board",
  });
  const currentImage = image.trim() || null;
  const initials = deriveInitials(currentName);
  const isSavingProfile = updateMutation.isPending || uploadAvatarMutation.isPending || removeAvatarMutation.isPending;
  const uploadHint = selectedCompany
    ? t("profile.card.uploadHintStored", {
        ns: "settings",
        companyName: selectedCompany.name,
        defaultValue: `Stored in Brabrix Agent file storage for ${selectedCompany.name}.`,
      })
    : t("profile.card.uploadHintSelectCompany", {
        ns: "settings",
        defaultValue: "Select a company to upload an avatar into Brabrix Agent storage.",
      });

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <UserRoundPen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">
            {t("profile.title", { ns: "settings", defaultValue: "Profile" })}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("profile.subtitle", {
            ns: "settings",
            defaultValue: "Control how your account appears in the sidebar and other board surfaces.",
          })}
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
                    {currentImage
                      ? t("profile.buttons.changePhoto", { ns: "settings", defaultValue: "Change photo" })
                      : t("profile.buttons.uploadPhoto", { ns: "settings", defaultValue: "Upload photo" })}
                  </Button>
                  {currentImage ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeAvatarMutation.mutate()}
                      disabled={isSavingProfile}
                    >
                      {removeAvatarMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      {t("profile.buttons.remove", { ns: "settings", defaultValue: "Remove" })}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 space-y-2 pb-1">
                <div>
                  <h2 className="truncate text-2xl font-semibold text-foreground">{currentName}</h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {sessionQuery.data.user.email ?? t("profile.card.noEmail", { ns: "settings", defaultValue: "No email" })}
                  </p>
                </div>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t("profile.card.clickHint", {
                    ns: "settings",
                    uploadHint,
                    defaultValue: `Click the avatar to upload a new image. ${uploadHint}`,
                  })}
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
            <Label htmlFor="profile-name">
              {t("profile.fields.displayName", { ns: "settings", defaultValue: "Display name" })}
            </Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              placeholder={t("profile.fields.displayNamePlaceholder", { ns: "settings", defaultValue: "Board" })}
            />
            <p className="text-xs text-muted-foreground">
              {t("profile.fields.displayNameHint", {
                ns: "settings",
                defaultValue: "Shown in the sidebar account footer and comment author surfaces.",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">
              {t("profile.fields.email", { ns: "settings", defaultValue: "Email" })}
            </Label>
            <Input
              id="profile-email"
              value={sessionQuery.data.user.email ?? ""}
              readOnly
              disabled
            />
            <p className="text-xs text-muted-foreground">
              {t("profile.fields.emailHint", {
                ns: "settings",
                defaultValue: "Email is managed by your auth session and is read-only here.",
              })}
            </p>
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="profile-language">
              {t("language.label", { ns: "common", defaultValue: "Language" })}
            </Label>
            <Select
              value={locale}
              onValueChange={(value) => {
                if (supportedLocales.includes(value as SupportedLocale)) {
                  setLocale(value as SupportedLocale);
                }
              }}
            >
              <SelectTrigger id="profile-language" className="w-full md:w-[280px]" aria-label={t("language.label", {
                ns: "common",
                defaultValue: "Language",
              })}>
                <SelectValue placeholder={t("language.label", { ns: "common", defaultValue: "Language" })} />
              </SelectTrigger>
              <SelectContent>
                {supportedLocales.map((supportedLocale) => (
                  <SelectItem key={supportedLocale} value={supportedLocale}>
                    {t(`language.options.${supportedLocale}`, {
                      ns: "common",
                      defaultValue: supportedLocale,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("profile.language.hint", {
                ns: "settings",
                defaultValue: "Choose your preferred language for menus, pages, and workflows.",
              })}
            </p>
          </div>

          <div className="md:col-span-2 flex justify-end">
            <Button type="submit" disabled={isSavingProfile || !name.trim()}>
              {updateMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
              {updateMutation.isPending
                ? t("profile.buttons.saving", { ns: "settings", defaultValue: "Saving..." })
                : t("profile.buttons.saveProfile", { ns: "settings", defaultValue: "Save profile" })}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
