export function buildBootstrapPendingMessage(hasActiveInvite: boolean) {
  if (hasActiveInvite) {
    return "No instance admin exists yet. A bootstrap invite is already active. Use the existing first-admin invite URL to finish setup in the browser, or run this command to rotate the invite if you no longer have that URL:";
  }

  return "No instance admin exists yet. Run this command in your Paperclip environment to generate the first-admin invite URL, then open that invite in the browser to finish setup:";
}
