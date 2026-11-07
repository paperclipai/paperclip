import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SkillsLayout } from "@/pages/skills/skills-layout";

/** Cards / List switch for the Skills page, matching the Agents view toggle. */
export function SkillsLayoutToggle({ layout, onLayoutChange }: { layout: SkillsLayout; onLayoutChange: (layout: SkillsLayout) => void }) {
  return (
    <div className="design-view-toggle flex items-center" role="group" aria-label="Skills layout">
      <Button type="button" size="icon-sm" variant={layout === "cards" ? "secondary" : "ghost"} onClick={() => onLayoutChange("cards")} title="Card view" aria-label="Card view" aria-pressed={layout === "cards"}><LayoutGrid aria-hidden /></Button>
      <Button type="button" size="icon-sm" variant={layout === "list" ? "secondary" : "ghost"} onClick={() => onLayoutChange("list")} title="List view" aria-label="List view" aria-pressed={layout === "list"}><List aria-hidden /></Button>
    </div>
  );
}
