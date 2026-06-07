import { useEffect } from "react";
import { Rocket as RocketIcon, ExternalLink } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";

export function Rocket() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "Rocket SDR" }]), [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Rocket SDR</h1>
      <AgnbSubnav group="campaigns" />
      <EmptyState icon={RocketIcon} message="Rocket SDR runs in its own dashboard. Campaign sends + native reply triage live there." />
      <div className="flex justify-center">
        <Button asChild>
          <a href="https://app.rocketsdr.ai" target="_blank" rel="noreferrer"><ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open Rocket SDR</a>
        </Button>
      </div>
    </div>
  );
}
