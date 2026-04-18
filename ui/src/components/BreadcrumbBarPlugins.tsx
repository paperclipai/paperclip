import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";

type BreadcrumbBarPluginsProps = {
  companyId: string | null;
  companyPrefix: string | null;
};

export default function BreadcrumbBarPlugins({
  companyId,
  companyPrefix,
}: BreadcrumbBarPluginsProps) {
  const context = { companyId, companyPrefix };
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId });
  const { launchers } = usePluginLaunchers({
    placementZones: ["globalToolbarButton"],
    companyId,
    enabled: !!companyId,
  });

  if (slots.length === 0 && launchers.length === 0) return null;

  return (
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      <PluginSlotOutlet
        slotTypes={["globalToolbarButton"]}
        context={context}
        className="flex items-center gap-1"
      />
      <PluginLauncherOutlet
        placementZones={["globalToolbarButton"]}
        context={context}
        className="flex items-center gap-1"
      />
    </div>
  );
}
