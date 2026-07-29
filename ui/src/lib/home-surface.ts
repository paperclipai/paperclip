export type HomeSurface = "channels" | "dashboard" | "tasks";

const STORAGE_PREFIX = "paperclip.lastHomeSurface.";

function storageKey(companyId: string): string {
  return `${STORAGE_PREFIX}${companyId}`;
}

export function loadLastHomeSurface(companyId: string): HomeSurface | null {
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    if (raw === "channels" || raw === "dashboard" || raw === "tasks") return raw;
    return null;
  } catch {
    return null;
  }
}

export function saveLastHomeSurface(companyId: string, surface: HomeSurface): void {
  try {
    localStorage.setItem(storageKey(companyId), surface);
  } catch {
    // Ignore localStorage failures.
  }
}

/**
 * New companies with channels + at least one project land in Channels.
 * Otherwise restore the remembered surface, falling back to Dashboard.
 */
export function resolveCompanyHomePath(input: {
  companyId: string;
  issuePrefix: string;
  channelsEnabled: boolean;
  hasProject: boolean;
}): string {
  const prefix = `/${input.issuePrefix}`;
  const remembered = loadLastHomeSurface(input.companyId);
  if (remembered === "channels" && input.channelsEnabled) return `${prefix}/channels`;
  if (remembered === "tasks") return `${prefix}/issues`;
  if (remembered === "dashboard") return `${prefix}/dashboard`;

  if (input.channelsEnabled && input.hasProject) return `${prefix}/channels`;
  return `${prefix}/dashboard`;
}
