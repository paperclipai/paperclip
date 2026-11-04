/** A registered owner's reconciliation fence, not a host-sleep certificate.
 * Future deadlines belong to the domain's durable-state reader. */
export interface DeadlineReconciliationSnapshot {
  readonly revision: string;
  readonly reconciled: boolean;
}
