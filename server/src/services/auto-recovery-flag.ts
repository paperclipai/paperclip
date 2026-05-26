import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";

export const AUTO_RECOVERY_ISSUES_ENV_VAR = "PAPERCLIP_AUTO_RECOVERY_ISSUES";

function readEnvOverride(): boolean | null {
  const raw = (process.env[AUTO_RECOVERY_ISSUES_ENV_VAR] ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return false;
  return null;
}

/**
 * Resolves whether automatic recovery-style issue creation (productivity reviews
 * and stranded-issue recovery issues) is enabled. Resolution order:
 *
 *   1. `PAPERCLIP_AUTO_RECOVERY_ISSUES` env var (`on` | `off` | unset).
 *   2. Instance experimental setting `autoRecoveryIssues`.
 *   3. Default `false` (suppressed) — see THE-303 / THE-408.
 */
export async function isAutoRecoveryIssuesEnabled(db: Db): Promise<boolean> {
  const envOverride = readEnvOverride();
  if (envOverride !== null) return envOverride;
  const experimental = await instanceSettingsService(db).getExperimental();
  return experimental.autoRecoveryIssues;
}
