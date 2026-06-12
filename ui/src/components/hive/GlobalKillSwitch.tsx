import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { plansApi } from "../../api/plans";
import { useCompany } from "../../context/CompanyContext";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

// Company-wide hard stop. Engaging cancels every running agent and pauses the
// company so nothing new can start; releasing re-activates it. The state mirrors
// the company's manual pause so a reload reflects reality.
export function GlobalKillSwitch() {
  const queryClient = useQueryClient();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToastActions();
  const [confirm, setConfirm] = useState(false);

  // A paused company (any reason) can be re-activated from here. Budget pauses
  // are routed by the server to the raise-budget flow (409 with guidance).
  const paused = selectedCompany?.status === "paused";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.liveMeter(selectedCompanyId) });
    }
  };

  const engage = useMutation({
    mutationFn: () => plansApi.engageKillSwitch(selectedCompanyId!),
    onSuccess: () => {
      pushToast({ title: "Kill switch engaged", body: "All agent work cancelled.", tone: "warn" });
      setConfirm(false);
      refresh();
    },
    onError: (e) =>
      pushToast({ title: "Kill switch failed", body: errMsg(e), tone: "error" }),
  });

  const reactivate = useMutation({
    mutationFn: () => plansApi.reactivateCompany(selectedCompanyId!),
    onSuccess: () => {
      pushToast({ title: "Company re-activated", body: "Agents can run again.", tone: "success" });
      refresh();
    },
    onError: (e) => pushToast({ title: "Couldn't re-activate", body: errMsg(e), tone: "error" }),
  });

  if (!selectedCompanyId) return null;

  if (paused) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-green-500/60 text-green-700 dark:text-green-300"
            onClick={() => reactivate.mutate()}
            disabled={reactivate.isPending}
          >
            <OctagonX className="h-4 w-4" />
            Re-activate company
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Sets the company back to active so agents can run again. If it was
          paused by a budget cap, raise the cap to resume.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            onClick={() => setConfirm(true)}
            aria-label="Engage global kill switch"
          >
            <OctagonX className="h-4 w-4" />
            Kill switch
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Immediately cancels every running agent and pauses the company. You can
          release it again at any time.
        </TooltipContent>
      </Tooltip>
      <ConfirmActionDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Engage the kill switch?"
        description="This immediately cancels every running agent in this company and pauses it so no new work can start. You can release it again at any time."
        confirmLabel="Engage kill switch"
        destructive
        pending={engage.isPending}
        onConfirm={() => engage.mutate()}
      />
    </>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
