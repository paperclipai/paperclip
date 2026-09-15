import { useId, useState, type MouseEvent } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type { Announcement, AnnouncementAction } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAnnouncementAnimation } from "@/hooks/useAnnouncementAnimation";

export interface AnnouncementCardProps {
  announcement: Announcement;
  onDismiss: () => void;
  imageSrc?: string;
  animationSrc?: string;
  className?: string;
}

function Action({ action, primary, onClick }: { action: AnnouncementAction; primary?: boolean; onClick: () => void }) {
  const content = <>{action.label}{!primary && action.kind === "external" && <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />}</>;
  const onAuxClick = (event: MouseEvent<HTMLAnchorElement>) => { if (event.button === 1) onClick(); };
  return (
    <Button asChild variant={primary ? "default" : "ghost"} size="sm" className="h-auto min-h-9 min-w-0 whitespace-normal py-2 text-left">
      {action.kind === "external" ? (
        <a href={action.url} target="_blank" rel="noopener noreferrer" onClick={onClick} onAuxClick={onAuxClick}>{content}</a>
      ) : <Link to={action.path} onClick={onClick} onAuxClick={onAuxClick}>{content}</Link>}
    </Button>
  );
}

export function AnnouncementCard({ announcement, onDismiss, imageSrc, animationSrc, className }: AnnouncementCardProps) {
  const titleId = useId();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const src = imageSrc ?? `/api/announcements/${encodeURIComponent(announcement.id)}/image`;
  const showImage = Boolean(announcement.image && failedImage !== src);
  const animationDocument = useAnnouncementAnimation(announcement, animationSrc);
  const showAnimation = Boolean(animationDocument);
  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      className={cn("relative w-full max-w-(--announcement-width) gap-0 overflow-hidden rounded-xl p-0 shadow-sm", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
      }}
    >
      {(showImage || animationDocument) && <div className="relative h-(--announcement-image-mobile-height) w-full shrink-0 overflow-hidden bg-muted md:h-(--announcement-image-height)">
        {showImage && <img src={src} alt={showAnimation ? "" : announcement.image!.alt} referrerPolicy="no-referrer" onError={() => setFailedImage(src)} className="h-full w-full object-cover" />}
        {showAnimation && <div role="img" aria-label={announcement.animation!.alt} className="pointer-events-none absolute inset-0">
          <iframe title={announcement.animation!.alt} aria-hidden="true" tabIndex={-1} sandbox="" referrerPolicy="no-referrer" srcDoc={animationDocument!} className="h-full w-full border-0" />
        </div>}
      </div>}
      <Button variant="secondary" size="icon" aria-label="Dismiss announcement" onClick={onDismiss} className="absolute right-2 top-2 z-10 size-8 rounded-full shadow-sm">
        <X className="size-4" aria-hidden="true" />
      </Button>
      <div className={cn("flex flex-col gap-1 px-4 py-4", !showImage && !animationDocument && "pr-12")}>
        <p className="text-xs text-muted-foreground">{announcement.eyebrow}</p>
        <h2 id={titleId} className="break-words text-base font-semibold leading-snug">{announcement.title}</h2>
        <p className="break-words text-sm leading-snug text-muted-foreground">{announcement.description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
        {announcement.secondaryLink && <Action action={announcement.secondaryLink} onClick={onDismiss} />}
        <div className="ml-auto min-w-0 max-w-full"><Action action={announcement.primaryAction} primary onClick={onDismiss} /></div>
      </div>
    </Card>
  );
}
