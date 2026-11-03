import type { ReactNode } from "react";
import type { LabAttentionRecord, SurfaceData } from "../../kit";
import { RailRow, WorkspaceDetail } from "./WorkspaceParts";

const noop = () => undefined;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

export function CardBody({ records }: SurfaceData["card"]) {
  const byKind = (kind: LabAttentionRecord["kind"]) => records.find((record) => record.kind === kind) ?? records[0];
  const plan = byKind("plan");
  const stale = records.find((record) => record.stale) ?? byKind("review");
  const forName = records.find((record) => record.forUser) ?? byKind("approval");
  return (
    <div className="flex flex-col gap-6">
      <Row label="Collapsed · one line in the rail">
        <div className="rounded-xl border border-border bg-card p-1.5">
          <RailRow record={plan} selected={false} onSelect={noop} />
        </div>
      </Row>
      <Row label="Selected · the rail row that drives the workspace">
        <div className="rounded-xl border border-border bg-card p-1.5">
          <RailRow record={plan} selected onSelect={noop} />
        </div>
      </Row>
      <Row label="Expanded · the decision workspace">
        <div className="min-h-120 overflow-hidden rounded-xl border border-border bg-card">
          <WorkspaceDetail record={plan} featured />
        </div>
      </Row>
      <Row label="Stale · rail row">
        <div className="rounded-xl border border-border bg-card p-1.5">
          <RailRow record={stale} selected={false} onSelect={noop} />
        </div>
      </Row>
      <Row label="For @name · rail row">
        <div className="rounded-xl border border-border bg-card p-1.5">
          <RailRow record={forName} selected={false} onSelect={noop} />
        </div>
      </Row>
    </div>
  );
}
