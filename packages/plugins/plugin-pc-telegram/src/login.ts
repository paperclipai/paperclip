import type { LoginEvent, LoginStatus, PublicTelegramAccount } from "./types.js";

export function idleLoginStatus(): LoginStatus {
  return { state: "idle" };
}

export function reduceLogin(current: LoginStatus, event: LoginEvent): LoginStatus {
  if (event.type === "cancel") {
    if ("loginId" in current && current.loginId !== event.loginId) {
      return current;
    }
    return idleLoginStatus();
  }

  if (event.type === "start") {
    return { state: "qr_pending", loginId: event.loginId, qr: { imageDataUrl: "" } };
  }

  if (!("loginId" in current) || current.loginId !== event.loginId) {
    if (current.state === "idle" && event.type === "qr") {
      return { state: "qr_pending", loginId: event.loginId, qr: event.qr };
    }
    return current;
  }

  switch (event.type) {
    case "qr":
      if (current.state === "qr_pending" || current.state === "password_required") {
        return { state: "qr_pending", loginId: event.loginId, qr: event.qr };
      }
      return current;
    case "password_required":
      if (current.state === "qr_pending" || current.state === "password_required") {
        return { state: "password_required", loginId: event.loginId, hint: event.hint };
      }
      return current;
    case "connected":
      return { state: "connected", loginId: event.loginId, account: event.account };
    case "error":
      return { state: "error", loginId: event.loginId, message: event.message };
    default:
      return current;
  }
}

export function publicAccountFromLogin(status: LoginStatus): PublicTelegramAccount | null {
  return status.state === "connected" ? status.account : null;
}

export function loginNeedsPassword(status: LoginStatus): boolean {
  return status.state === "password_required";
}
