import { useState } from "react";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import type { LabAttentionRecord, SurfaceData } from "../../kit";
import { COMPANY } from "../../fixtures";
import { toAttentionItem, USER_LABELS, VIEWER_ID } from "./adapters";

const noop = () => undefined;

function Specimen({ label, record, expanded }: { label: string; record: LabAttentionRecord; expanded: boolean }) {
  const item = toAttentionItem(record);
  const [open, setOpen] = useState(expanded);
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <AttentionQueueRow
        item={item}
        companyId={COMPANY.id}
        expanded={open}
        onToggleExpand={() => setOpen((value) => !value)}
        onDismiss={noop}
        onWithdraw={noop}
        onSnooze={noop}
        currentUserId={VIEWER_ID}
        userLabelMap={USER_LABELS}
      />
    </div>
  );
}

export function CardBody({ records }: SurfaceData["card"]) {
  const byKind = (kind: LabAttentionRecord["kind"]) => records.find((record) => record.kind === kind) ?? records[0];
  return (
    <div className="space-y-6">
      <Specimen label="Collapsed" record={byKind("plan")} expanded={false} />
      <Specimen label="Expanded" record={byKind("approval")} expanded />
      <Specimen label="Stale" record={records.find((record) => record.stale) ?? byKind("review")} expanded={false} />
      <Specimen label="For @name" record={records.find((record) => record.forUser) ?? byKind("approval")} expanded={false} />
    </div>
  );
}
