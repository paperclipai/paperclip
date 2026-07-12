import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { type MyValueState, myValueLabel, myValueTone } from "./user-secret-presentation";

export type { MyValueState };
export { myValueLabel, myValueTone };

/**
 * Derive the current user's value state for a definition:
 * - "set": an active value exists
 * - "inactive": a value exists but is disabled/archived
 * - "not_set": no value stored yet
 */
export function myValueState(
  _definition: UserSecretDefinition,
  secret: CompanySecret | null | undefined,
): MyValueState {
  if (!secret) return "not_set";
  if (secret.status === "active") return "set";
  return "inactive";
}
