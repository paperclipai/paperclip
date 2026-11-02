import { t } from "@/i18n";

/** Display known platform states without changing external state values. */
export function externalRunnerStatusLabel(status: string): string {
  switch (status) {
    case "pairing": return t("oct19Voice.statePairing");
    case "ready": return t("oct19Voice.stateReady");
    case "connected": return t("oct19Voice.stateConnected");
    case "revoked": return t("oct19Voice.stateRevoked");
    case "active": return t("oct19Voice.stateActive");
    case "expired": return t("oct19Voice.stateExpired");
    default: return status;
  }
}
