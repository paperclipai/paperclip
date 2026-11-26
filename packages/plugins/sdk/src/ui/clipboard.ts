import { getSdkUiRuntimeValue } from "./runtime.js";

/**
 * Copy text through the host's HTTP-safe clipboard implementation.
 *
 * Plugin UI code must use this helper instead of calling the browser Clipboard
 * API directly so copy actions also work in Paperclip's plain-HTTP deployments.
 */
export function copyTextToClipboard(text: string): Promise<void> {
  const copy = getSdkUiRuntimeValue<(value: string) => Promise<void>>("copyTextToClipboard");
  return copy(text);
}
