import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalToastActions } from "../context/ToastContext";
import { CHROMELESS_DISPLAY_MODES, isChromelessDisplayMode } from "../lib/pwa-display-mode";
import { useTranslation } from "@/i18n";

function ControlButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void | Promise<void>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-8 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={() => void onClick()}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function StandaloneBrowserControls({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const [chromeless, setChromeless] = useState(() =>
    typeof window !== "undefined" && mobile ? isChromelessDisplayMode() : false,
  );
  const toastActions = useOptionalToastActions();

  useEffect(() => {
    if (!mobile || typeof window === "undefined") {
      setChromeless(false);
      return;
    }

    const update = () => setChromeless(isChromelessDisplayMode());

    update();
    if (typeof window.matchMedia !== "function") return;

    const mediaQueries = CHROMELESS_DISPLAY_MODES.map((mode) => window.matchMedia(`(display-mode: ${mode})`));
    if (mediaQueries.every((media) => typeof media.addEventListener === "function")) {
      mediaQueries.forEach((media) => media.addEventListener("change", update));
      return () => mediaQueries.forEach((media) => media.removeEventListener("change", update));
    }

    mediaQueries.forEach((media) => media.addListener(update));
    return () => mediaQueries.forEach((media) => media.removeListener(update));
  }, [mobile]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  const share = useCallback(async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title || "Paperclip", url });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toastActions?.pushToast({
          title: t("components.standaloneBrowserControls.linkCopied", { defaultValue: "Link copied" }),
          tone: "success",
        });
        return;
      }
      toastActions?.pushToast({
        title: t("components.standaloneBrowserControls.sharingUnavailable", { defaultValue: "Sharing is unavailable" }),
        body: url,
        tone: "warn",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toastActions?.pushToast({
        title: t("components.standaloneBrowserControls.shareFailed", { defaultValue: "Share failed" }),
        body: t("components.standaloneBrowserControls.shareFailedBody", {
          defaultValue: "Try opening the page in your browser.",
        }),
        tone: "error",
      });
    }
  }, [toastActions, t]);

  const openInBrowser = useCallback(() => {
    window.open(window.location.href, "_blank", "noopener,noreferrer");
  }, []);

  if (!mobile || !chromeless) return null;

  return (
    <div className="flex h-10 items-center justify-end gap-1 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <ControlButton
        label={t("components.standaloneBrowserControls.refresh", { defaultValue: "Refresh" })}
        onClick={refresh}
      >
        <RefreshCw className="h-4 w-4" />
      </ControlButton>
      <ControlButton
        label={t("components.standaloneBrowserControls.share", { defaultValue: "Share" })}
        onClick={share}
      >
        <Share2 className="h-4 w-4" />
      </ControlButton>
      <ControlButton
        label={t("components.standaloneBrowserControls.openInBrowser", { defaultValue: "Open in Browser" })}
        onClick={openInBrowser}
      >
        <ExternalLink className="h-4 w-4" />
      </ControlButton>
    </div>
  );
}
