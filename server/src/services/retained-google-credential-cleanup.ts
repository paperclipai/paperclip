// Compatibility names for Google-specific callers; all managed accounts share
// the same company/account-scoped owner and bounded reconciliation registry.
export {
  assertAiCredentialCleanupSettled as assertGoogleCredentialCleanupSettled,
  bindRetainedAiCredentialHome as bindRetainedGoogleCredentialHome,
  reconcileRetainedAiCleanup as reconcileRetainedGoogleCleanup,
  reconcileRetainedAiCleanupForHome as reconcileRetainedGoogleCleanupForHome,
  retainAiCredentialCleanup as retainGoogleCredentialCleanup,
  retainAiCredentialCleanupForHome as retainGoogleCredentialCleanupForHome,
  type RetainedAiCleanupScope as RetainedGoogleCleanupScope,
} from "./retained-ai-credential-cleanup.js";
