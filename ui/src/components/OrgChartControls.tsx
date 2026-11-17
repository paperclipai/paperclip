import type { ReactNode } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { Button } from "./ui/button";

export interface OrgChartActions {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

/** Shared camera controls can stay mounted while the chart view fades away. */
export function OrgChartControls({ zoomIn, zoomOut, fit, children }: OrgChartActions & { children?: ReactNode }) {
  return (
    <div className="org-chart-controls flex items-center gap-2" role="group" aria-label="Org chart controls">
      <div className="design-view-toggle" role="group" aria-label="Chart camera">
        <Button variant="ghost" size="icon-sm" className="design-toolbar-icon" aria-label="Zoom out" title="Zoom out" onClick={zoomOut}><Minus className="size-4" /></Button>
        <Button variant="ghost" size="icon-sm" className="design-toolbar-icon" aria-label="Zoom in" title="Zoom in" onClick={zoomIn}><Plus className="size-4" /></Button>
        <Button variant="ghost" size="icon-sm" className="design-toolbar-icon" aria-label="Fit chart to screen" title="Fit chart to screen" onClick={fit}><Maximize2 className="size-4" /></Button>
      </div>
      {children}
    </div>
  );
}
