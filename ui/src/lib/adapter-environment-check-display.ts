import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { t } from "@/i18n";

type CheckMessage = Pick<AdapterEnvironmentTestResult["checks"][number], "code" | "message">;

const messages: Record<string, { source: string; key: string }> = {
  ai_connection_api_key_reverified: {
    source: "The provider verified this API key for adoption.",
    key: "sep14Dynamic.apiKeyReverified",
  },
  codex_probe_cleanup_incomplete: {
    source: "Temporary probe files could not be fully removed; this does not change the connection result.",
    key: "stable916Shell.probeCleanupIncomplete",
  },
  grok_environment_unprepared: {
    source: "Could not stage the managed account into the environment",
    key: "stable916Shell.managedAccountUnprepared",
  },
};

/** Exact first-party code/message pairs only; provider diagnostics stay raw. */
export function adapterEnvironmentCheckMessageDisplay(check: CheckMessage): string {
  if (check.code === "ai_connection_api_key_rejected") {
    if (check.message === "Could not verify the account. Try again.") return t("stable916Shell.accountVerificationFailed");
    if (check.message === "The selected account's API key was not available to verify.") return t("stable916Shell.accountKeyUnavailable");
  }
  const known = Object.hasOwn(messages, check.code) ? messages[check.code] : undefined;
  if (known?.source === check.message) return t(known.key);
  return check.message;
}
