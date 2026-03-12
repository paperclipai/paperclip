import i18n from "../i18n";
import { timeAgo as formatTimeAgo } from "./timeAgo";

export { formatTimeAgo };

export function statusLabel(status: string): string {
  const key = `status.${status}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function priorityLabel(priority: string): string {
  const key = `priority.${priority}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function adapterLabel(adapterType: string): string {
  const key = `adapter.${adapterType}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return adapterType;
}

export function roleLabel(role: string): string {
  const key = `role.${role}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function goalLevelLabel(level: string): string {
  const key = `goalLevel.${level}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function approvalTypeLabel(type: string): string {
  const key = `approvalType.${type}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return type.replace(/_/g, " ");
}

export function runSourceLabel(source: string): string {
  const key = `runSource.${source}`;
  const translated = i18n.t(key, { ns: "common" });
  if (translated !== key) return translated;
  return source.charAt(0).toUpperCase() + source.slice(1);
}

export function localizedDate(date: Date | string): string {
  const locale = i18n.language ?? "en";
  return new Date(date).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function localizedDateTime(date: Date | string): string {
  const locale = i18n.language ?? "en";
  return new Date(date).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
