import type { CloudStackPortfolio } from "@/api/cloud";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const label = "Slack the Paperclip team";

export function SidebarSlackFeedback({ feedback, className }: {
  feedback: NonNullable<CloudStackPortfolio["slackFeedback"]>;
  className: string;
}) {
  const triggerClass = cn("group flex size-8 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className);
  const logo = <img src="/brands/apps/slack.svg" alt="" className="size-4 grayscale group-hover:grayscale-0 group-focus-visible:grayscale-0" />;
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <button type="button" aria-label={label} className={triggerClass}>{logo}</button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your private Slack channel</DialogTitle>
          <DialogDescription>
            {"message" in feedback ? feedback.message : "Open your shared channel to talk with the Paperclip team. If you still need to join, check your organization owner’s inbox for the Slack invitation."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {"href" in feedback ? (
            <Button asChild><a href={feedback.href} target="_blank" rel="noreferrer">Open Slack channel</a></Button>
          ) : (
            <DialogClose asChild><Button>Got it</Button></DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
