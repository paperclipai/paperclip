import path from "node:path";

const SESSION_CWD_SYSTEM_ROOTS = new Set([
  "/",
  "/tmp",
  "/var",
  "/var/tmp",
  "/var/run",
  "/usr",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/private",
  "/private/tmp",
]);

export function isUnsafeSessionWorkspaceCwd(cwd: string | null | undefined): boolean {
  const value = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  if (!value) return false;
  const normalized = path.normalize(value.replace(/\/+$/, "") || "/");
  return SESSION_CWD_SYSTEM_ROOTS.has(normalized);
}
