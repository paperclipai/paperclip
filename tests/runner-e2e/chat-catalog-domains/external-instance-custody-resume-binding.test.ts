import { expect, it } from "vitest";
import { publicResumeCustodyReceipt } from "./external-instance-custody.js";
function valid() {
  const preparing = { companyId: "company", agentId: "riley", operationId: "preparing", version: 1, phase: "preparing", hadOwnedSecret: false, returnedOwnedSecret: true };
  const receipt = { ...preparing, operationId: "actual-resume", version: 5, phase: "resuming", hadOwnedSecret: true, returnedOwnedSecret: false };
  const agent = { id: "riley", companyId: "company", lifecycleState: "paused", lifecycleVersion: 4 };
  return { companyId: "company", agentId: "riley", paused: agent, resumed: { ...agent, lifecycleState: "resuming", lifecycleVersion: 5 }, ready: { ...agent, lifecycleState: "ready", lifecycleVersion: 6 }, before: { ownerAgentId: "riley", receipts: [preparing] }, after: { ownerAgentId: "riley", receipts: [structuredClone(preparing), receipt] } };
}
it("accepts only the newly observed real operation and identical retries", () => {
  const v = valid(); expect(publicResumeCustodyReceipt(v)?.operationId).toBe("actual-resume");
  v.after.receipts.push(structuredClone(v.after.receipts[1]!)); expect(publicResumeCustodyReceipt(v)?.version).toBe(5);
});
it.each(["missing", "stale", "foreign-company", "foreign-agent", "wrong-owner", "wrong-version", "wrong-ready-version", "wrong-post-state", "error", "no-secret", "leaked-secret", "ambiguous", "rewritten-history", "no-preparing", "invalid-paused-version"])("rejects %s receipt/state", kind => {
  const v = valid(), row = v.after.receipts[1]!;
  if (kind === "missing") v.after.receipts.pop();
  if (kind === "stale") v.before.receipts.push(structuredClone(row));
  if (kind === "foreign-company") row.companyId = "other";
  if (kind === "foreign-agent") row.agentId = "other";
  if (kind === "wrong-owner") v.after.ownerAgentId = "other";
  if (kind === "wrong-version") row.version++;
  if (kind === "wrong-ready-version") v.ready.lifecycleVersion++;
  if (kind === "wrong-post-state") v.resumed.lifecycleState = "paused";
  if (kind === "error") Object.assign(v.ready, { lifecycleError: "failed" });
  if (kind === "no-secret") row.hadOwnedSecret = false;
  if (kind === "leaked-secret") row.returnedOwnedSecret = true;
  if (kind === "ambiguous") v.after.receipts.push({ ...row, operationId: "different-new-operation" });
  if (kind === "rewritten-history") v.after.receipts[0]!.version++;
  if (kind === "no-preparing") { v.before.receipts = []; v.after.receipts = [row]; }
  if (kind === "invalid-paused-version") v.paused.lifecycleVersion = Number.NaN;
  expect(publicResumeCustodyReceipt(v)).toBeUndefined();
});
