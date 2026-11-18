import type { ManagedGoogleAccessRemoval } from "@paperclipai/shared";
import type { ToastAction, ToastInput, ToastTone } from "../../context/ToastContext";

export const GOOGLE_THIRD_PARTY_ACCESS_URL = "https://myaccount.google.com/connections";

export interface GoogleAccessRemovalNotice {
  body: string;
  tone: ToastTone;
  action?: ToastAction;
}

const openGoogleAccountConnections: ToastAction = {
  label: "Open Google account connections",
  onClick: () => { window.open(GOOGLE_THIRD_PARTY_ACCESS_URL, "_blank", "noopener,noreferrer"); },
};

export function googleAccessRemovalNotice(
  providerAccess: ManagedGoogleAccessRemoval | null | undefined,
): GoogleAccessRemovalNotice | null {
  if (providerAccess?.provider !== "google") return null;
  if (providerAccess.result === "ended") {
    return { tone: "success", body: "Paperclip's access to this Google account was also ended at Google." };
  }
  if (providerAccess.result === "ended_unconfirmed") {
    return {
      tone: "info",
      body: "Paperclip's access was ended at Google. If more than one Google account was connected here, check your Google account's third-party connections to be sure.",
      action: openGoogleAccountConnections,
    };
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
    action: openGoogleAccountConnections,
  };
}

export function connectionRemovalToast(input: {
  title: string;
  body: string;
  providerAccess: ManagedGoogleAccessRemoval | null | undefined;
}): ToastInput {
  const notice = googleAccessRemovalNotice(input.providerAccess);
  return {
    title: input.title,
    body: notice ? `${input.body} ${notice.body}` : input.body,
    tone: notice?.tone ?? "success",
    ...(notice?.action ? { action: notice.action } : {}),
  };
}
