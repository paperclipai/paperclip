import type { LabAttentionRecord, SurfaceData } from "../../kit";
import { FocusCard } from "./FocusCard";

function Specimen({ label, record, featured, expanded }: { label: string; record: LabAttentionRecord; featured?: boolean; expanded?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      <FocusCard record={record} featured={featured} expanded={expanded} />
    </div>
  );
}

export function CardBody({ records }: SurfaceData["card"]) {
  const byKind = (kind: LabAttentionRecord["kind"]) => records.find((record) => record.kind === kind) ?? records[0];
  return (
    <div className="flex flex-col gap-6">
      <Specimen label="Collapsed · decide here" record={byKind("plan")} featured />
      <Specimen label="Expanded · the form is on the card" record={byKind("question")} expanded />
      <Specimen label="Stale" record={records.find((record) => record.stale) ?? byKind("review")} />
      <Specimen label="For @name" record={records.find((record) => record.forUser) ?? byKind("approval")} />
    </div>
  );
}
