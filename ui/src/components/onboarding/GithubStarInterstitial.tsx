import { Github, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OnboardingCard, OnboardingHeading } from "./OnboardingPrimitives";

const PAPERCLIP_REPO_URL = "https://github.com/paperclipai/paperclip";

/**
 * Local-flow only: a warm "star us on GitHub" interstitial shown after "Get
 * started", before landing in the app. "Star on GitHub" opens the repo in a new
 * tab and continues; "Not right now" just continues. Both call onContinue,
 * which runs the same completion as the cloud flow (launch task → dashboard).
 */
export function GithubStarInterstitial({ onContinue }: { onContinue: () => void }) {
  return (
    <OnboardingCard className="text-center">
      <div className="flex flex-col items-center gap-6">
        <span className="grid size-16 place-items-center rounded-full bg-muted/50 text-foreground">
          <Star className="size-7" />
        </span>
        <OnboardingHeading
          title="Enjoying Paperclip so far?"
          lede="Paperclip is open source. A GitHub star helps other people find it and means a lot to a small team — it takes two seconds."
          center
        />
        <div className="flex w-full flex-col gap-2">
          <Button
            size="lg"
            className="w-full rounded-full"
            onClick={() => {
              window.open(PAPERCLIP_REPO_URL, "_blank", "noopener,noreferrer");
              onContinue();
            }}
          >
            <Github className="mr-1.5 size-4" />
            Star on GitHub
          </Button>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={onContinue}>
            Not right now
          </Button>
        </div>
      </div>
    </OnboardingCard>
  );
}
