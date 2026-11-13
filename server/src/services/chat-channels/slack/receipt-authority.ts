import { verifyCloudConnectorReceipt } from "../../cloud-runtime-identity.js";
import { parseSlackFormFinalizedReceipt, type SlackFormFinalizedReceipt } from "./ack-receipt.js";
import { parseSlackFormRetirementReceipt, type SlackFormRetirementReceipt } from "./ack-retirement-receipt.js";

type ReceiptVerificationInput = { compactJws: string; env?: NodeJS.ProcessEnv };
export function verifySlackFormFinalizedReceipt(input: ReceiptVerificationInput): SlackFormFinalizedReceipt {
  return verifyCloudConnectorReceipt(input, parseSlackFormFinalizedReceipt);
}
export function verifySlackFormRetirementReceipt(input: ReceiptVerificationInput): SlackFormRetirementReceipt {
  return verifyCloudConnectorReceipt(input, parseSlackFormRetirementReceipt);
}
