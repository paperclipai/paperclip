export function isGitRepoUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!parsed.hostname) return false;
    return parsed.pathname.split("/").filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

export function isPlainHttpGitRepoUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "http:" && isGitRepoUrl(value);
  } catch {
    return false;
  }
}

export function deriveRepoNameFromUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
    return repo || "Git repo";
  } catch {
    return "Git repo";
  }
}

export function formatGitRepoUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return parsed.host;
    const displaySegments = [...segments];
    displaySegments[displaySegments.length - 1] =
      displaySegments[displaySegments.length - 1]?.replace(/\.git$/i, "") ?? "";
    return [parsed.host, ...displaySegments.filter(Boolean)].join("/");
  } catch {
    return value;
  }
}
