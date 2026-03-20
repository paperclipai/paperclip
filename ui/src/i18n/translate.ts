import i18n from "./i18n";

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

export function translateEnum(baseKey: string, value: string, fallback?: string): string {
  const key = `${baseKey}.${value}`;
  if (i18n.exists(key)) return i18n.t(key);
  return fallback ?? humanize(value);
}

export function translateStatus(status: string): string {
  return translateEnum("statusLabels", status, status);
}

export function translatePriority(priority: string): string {
  return translateEnum("priorityLabels", priority, priority);
}

export function translateRole(role: string): string {
  return translateEnum("roleLabels", role, role);
}

export function translateActivityEntityType(entityType: string): string {
  return translateEnum("activity.entityTypes", entityType, entityType);
}

