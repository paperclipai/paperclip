import { Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { LabArtifact } from "../../kit";
import { externalProps, type SolidAction } from "./actions";
import { ICON_BUTTON } from "./slab";

/**
 * PANEL — a card's "More actions": every way out that is not the primary, in
 * one named control, so the foot is the same single row on every card. The
 * list is the product's own menu (it opens in a portal, outside the kit's
 * wrapper, in the app's popover chrome); each item is the action by name, not
 * an unlabelled icon.
 */
export function PanelMenu({ actions, artifact }: { actions: SolidAction[]; artifact: LabArtifact }) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger data-secondary aria-label={`More actions: ${artifact.title}`} title="More actions" className={ICON_BUTTON}>
        <Ellipsis aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const Icon = action.icon;
          const face = (
            <>
              <Icon aria-hidden />
              {action.label}
            </>
          );
          return (
            <DropdownMenuItem key={action.label} asChild>
              {action.href ? (
                <a href={action.href} {...externalProps(action)}>
                  {face}
                </a>
              ) : (
                <button type="button" className="w-full">
                  {face}
                </button>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
