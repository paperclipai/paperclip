import type { ManagedGoogleAccessRemoval } from "@paperclipai/shared";
import type { ToastAction, ToastTone } from "../../context/ToastContext";

export const GOOGLE_THIRD_PARTY_ACCESS_URL = "https://myaccount.google.com/connections";

export interface GoogleAccessRemovalNotice {
  body: string;
  tone: ToastTone;
  action?: ToastAction;
}

export function googleAccessRemovalNotice(
  providerAccess: ManagedGoogleAccessRemoval | null | undefined,
): GoogleAccessRemovalNotice | null {
  if (providerAccess?.provider !== "google") return null;
  if (providerAccess.result === "ended") {
    return { tone: "success", body: "Paperclip's access to this Google account was also ended at Google." };
  }
  if (providerAccess.result === "other_connections_remain") {
    return {
      tone: "success",
      body: "Other Paperclip connections still use this Google account, so Google keeps Paperclip's access until you remove those too.",
    };
  }
  return {
    tone: "warn",
    body: "Paperclip removed the connection but couldn't end its access at Google. You can remove Paperclip from your Google account's third-party connections.",
    action: {
      label: "Open Google account connections",
      onClick: () => { window.open(GOOGLE_THIRD_PARTY_ACCESS_URL, "_blank", "noopener,noreferrer"); },
    },
  };
}
