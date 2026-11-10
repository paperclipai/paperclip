import { createHash } from "node:crypto";
import type { AcpxExtensionInput } from "./profile-extensions.js";

// Match the sidecar's provider identity boundary before Rust's opaque tool ID.
export function cursorToolIdentity(value: string): string {
  if (Buffer.byteLength(value) <= 240 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)) return value;
  return `acpx-tool-${createHash("sha256").update("paperclip.acpx.provider-identity.v1\0tool\0").update(value).digest("hex")}`;
}

/** Only the admitted native Cursor plan extension can attest a parent tool. */
export function cursorPlanToolIdentity(agent: string | null | undefined, input: AcpxExtensionInput): string | undefined {
  if (agent !== "cursor" || input.method !== "cursor/create_plan") return undefined;
  const value = input.details?.toolCallId;
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) throw new Error("Cursor plan omitted its bounded tool identity");
  return cursorToolIdentity(value);
}

/** Direct-driver counterpart of Rust acpx_opaque_item_id(..., "tool"). */
export function cursorToolExecutionId(value: string): string {
  const bounded = cursorToolIdentity(value);
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(bounded)) return bounded;
  return `acpx-tool-${createHash("sha256").update("paperclip.acpx.opaque-item.v1\0tool\0").update(bounded).digest("hex")}`;
}
