import { useId, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";

export interface SlackAvatarProps {
  agentName: string;
  appName: string;
  avatarUrl: string;
}

/** Shared by Slack onboarding and its Settings page. Slack upload is manual. */
export function SlackAvatarContent({
  agentName,
  appName,
  avatarUrl,
  compact = false,
}: SlackAvatarProps & { compact?: boolean }) {
  const id = useId();
  const filename = `${appName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent"}-avatar.png`;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      const response = await fetch(avatarUrl);
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/png")
      )
        throw new Error("Avatar unavailable");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-8">
      <section
        aria-labelledby={`${id}-download`}
        className="flex flex-col items-start gap-6 sm:flex-row sm:items-center"
      >
        <img
          src={avatarUrl}
          width={512}
          height={512}
          alt={`${agentName}’s Cliptoon avatar`}
          className="size-40 shrink-0 rounded-lg bg-muted object-contain"
        />
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 id={`${id}-download`} className="text-sm font-semibold">
              {compact
                ? "Download your agent’s avatar"
                : "1. Download your agent’s avatar"}
            </h2>
            <p className="text-xs text-muted-foreground">
              PNG · 512 × 512 · Ready for Slack
            </p>
          </div>
          <Button variant="outline" asChild>
            <a
              href={avatarUrl}
              download={filename}
              aria-disabled={downloading}
              onClick={(event) => {
                event.preventDefault();
                void download();
              }}
            >
              {downloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Download avatar
            </a>
          </Button>
          {downloadError && (
            <p role="alert" className="text-sm text-destructive">
              Couldn’t download the avatar. Try downloading it again.
            </p>
          )}
        </div>
      </section>

      <details open={compact ? undefined : true} className="space-y-4">
        <summary
          className={
            compact
              ? "cursor-pointer text-sm underline underline-offset-4"
              : "hidden"
          }
        >
          How to upload in Slack
        </summary>
        <section aria-labelledby={`${id}-upload`} className="space-y-4">
          <div className="space-y-1">
            <h2 id={`${id}-upload`} className="text-sm font-semibold">
              {compact ? "Upload it in Slack" : "2. Upload it in Slack"}
            </h2>
            <p className="text-sm text-muted-foreground">
              You’ll upload the downloaded image directly in Slack’s app
              settings.
            </p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >
                Open Slack app Settings{" "}
                <ExternalLink className="inline size-3" />
              </a>{" "}
              and choose <strong>{appName}</strong>.
            </li>
            <li>
              Choose <strong>Basic Information</strong>, then scroll to{" "}
              <strong>Display Information</strong>.
            </li>
            <li>
              Under <strong>App icon &amp; Preview</strong>, click the app icon
              and upload{" "}
              <span className="break-all font-mono text-xs">{filename}</span>.
            </li>
            <li>
              Confirm the crop, then click <strong>Save Changes</strong> in
              Slack.
            </li>
          </ol>
        </section>
      </details>
    </div>
  );
}

export function SlackAvatarStep({
  uploaded,
  onUploaded,
  onSkip,
  onSaveExit,
  ...props
}: SlackAvatarProps & {
  uploaded: boolean;
  onUploaded: () => void;
  onSkip: () => void;
  onSaveExit: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">
            Give {props.agentName} a face in Slack
          </h1>
          <span className="text-xs text-muted-foreground">Optional</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Use {props.agentName}’s avatar so your team recognizes the agent
        </p>
      </div>
      <SlackAvatarContent {...props} />
      {uploaded && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg bg-(--status-task-done)/10 p-3 text-sm"
        >
          <Check className="size-4 text-(--status-task-done)" />
          You marked the avatar as uploaded in Slack.
        </p>
      )}
      <SetupWizardFooter onSaveExit={onSaveExit}>
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button onClick={onUploaded}>
          {uploaded ? "Continue" : "I’ve uploaded the avatar"}
          <ArrowRight className="size-4" />
        </Button>
      </SetupWizardFooter>
    </div>
  );
}

export function SlackAvatarSettings(props: SlackAvatarProps) {
  return (
    <section className="space-y-4" aria-label="Slack avatar">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Agent avatar</h2>
        <p className="text-sm text-muted-foreground">
          Use {props.agentName}’s avatar so your team recognizes the agent
        </p>
      </div>
      <SlackAvatarContent {...props} compact />
    </section>
  );
}
