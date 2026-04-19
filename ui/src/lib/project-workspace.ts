export function isAbsoluteWorkspacePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

export function looksLikeProjectRepoUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

export function deriveWorkspaceNameFromPath(value: string) {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

export function deriveWorkspaceNameFromRepoUrl(value: string) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
    return repo || "GitHub repo";
  } catch {
    return "GitHub repo";
  }
}

export function deriveProjectNameFromRepoUrl(value: string) {
  return deriveWorkspaceNameFromRepoUrl(value);
}

export function validateProjectWorkspaceInputs(input: {
  localPath?: string | null;
  repoUrl?: string | null;
}) {
  const localPath = input.localPath?.trim() ?? "";
  const repoUrl = input.repoUrl?.trim() ?? "";

  if (localPath && !isAbsoluteWorkspacePath(localPath)) {
    return "Local folder must be a full absolute path.";
  }

  if (repoUrl && !looksLikeProjectRepoUrl(repoUrl)) {
    return "Repo must use a valid GitHub or GitHub Enterprise repo URL.";
  }

  return null;
}

export function buildProjectWorkspaceInput(input: {
  localPath?: string | null;
  repoUrl?: string | null;
}) {
  const localPath = input.localPath?.trim() ?? "";
  const repoUrl = input.repoUrl?.trim() ?? "";

  if (!localPath && !repoUrl) return undefined;

  return {
    name: localPath
      ? deriveWorkspaceNameFromPath(localPath)
      : deriveWorkspaceNameFromRepoUrl(repoUrl),
    ...(localPath ? { cwd: localPath } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    isPrimary: true,
  };
}
