import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { Link } from "@/lib/router";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";

export function PipelinesExperimentalGate({ children }: { children: ReactNode }) {
  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.data?.enablePipelines === true) {
    return <>{children}</>;
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Pipelines</h1>
      </div>
      <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
        Pipelines are disabled. Enable them in{" "}
        <Link
          className="text-primary underline-offset-2 hover:underline"
          to="/company/settings/instance/experimental"
        >
          Instance Settings
        </Link>{" "}
        to show pipeline boards, review queue, learnings, and pipeline item tools.
      </div>
    </div>
  );
}
