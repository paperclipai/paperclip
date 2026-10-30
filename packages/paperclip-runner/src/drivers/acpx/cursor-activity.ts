import { cursorPlanToolIdentity, cursorToolExecutionId, cursorToolIdentity } from "./cursor-plan-tool-identity.js";
import { createCursorToolEvidence } from "./cursor-tool-evidence.js";
import { persistedCursorUsageNotice } from "./cursor-usage-receipt.js";
import type { AcpxActivityAdapter } from "./profile-activity.js";

export const cursorActivityAdapter: AcpxActivityAdapter = Object.freeze<AcpxActivityAdapter>({
  toolIdentity: cursorToolIdentity,
  toolExecutionId: cursorToolExecutionId,
  inputToolIdentity: input => cursorPlanToolIdentity("cursor", input),
  createToolEvidence: createCursorToolEvidence,
  usageNotice: (before, after, requestId, turnId) =>
    persistedCursorUsageNotice(before, after, requestId, "cursor", `${turnId}:cursor-native-usage`),
});
