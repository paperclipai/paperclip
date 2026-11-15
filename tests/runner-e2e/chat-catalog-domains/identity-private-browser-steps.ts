import { NATIVE_PROOF_FAILURE_REASONS } from "./identity-new-company-native-proof.js";

/** Closed failure steps the private identity child may report. */
export const IDENTITY_PRIVATE_STEPS = ["request", "launch", "sign-in", "wizard", "new-company-native", "observability", "canary-failure",
  "new-company-create", "new-company-agent-route", "new-company-configure", "new-company-account", "new-company-test", "new-company-hire",
  "new-company-readback", "new-company-credential-scan", "new-company-chat",
  ...NATIVE_PROOF_FAILURE_REASONS.map(reason => `new-company-proof-${reason}` as const)] as const;
export type IdentityPrivateStep = typeof IDENTITY_PRIVATE_STEPS[number];
