import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function agentAvatarFilename(name: string) {
  return `${name.replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent"}-avatar.png`;
}

/** Downloads the instance's generated PNG; provider upload remains explicit. */
export function AgentAvatarDownload({
  avatarUrl,
  name,
  iconOnly = false,
}: {
  avatarUrl: string;
  name: string;
  iconOnly?: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setFailed(false);
    try {
      const response = await fetch(avatarUrl);
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/png")
      )
        throw new Error("Avatar unavailable");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = agentAvatarFilename(name);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setFailed(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button
        variant={iconOnly ? "ghost" : "outline"}
        size={iconOnly ? "icon" : "default"}
        asChild
      >
        <a
          aria-label="Download avatar"
          title="Download avatar"
          href={avatarUrl}
          download={agentAvatarFilename(name)}
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
          {!iconOnly && "Download avatar"}
        </a>
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t download the avatar. Try downloading it again.
        </p>
      )}
    </div>
  );
}
