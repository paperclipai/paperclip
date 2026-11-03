import { DecisionHistoryPanel } from "@/components/DecisionHistoryPanel";
import type { SurfaceData } from "../../kit";
import { COMPANY } from "../../fixtures";
import { USER_LABELS } from "./adapters";

export function PanelBody(_: SurfaceData["panel"]) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--sz-60px) shrink-0 items-center border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">Decision history</span>
      </div>
      <div className="min-h-0 flex-1">
        <DecisionHistoryPanel companyId={COMPANY.id} agents={[]} userLabelMap={USER_LABELS} />
      </div>
    </div>
  );
}
