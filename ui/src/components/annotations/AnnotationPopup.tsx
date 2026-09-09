import { Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Annotation } from "../../api/annotations";
import { cn } from "@/lib/utils";

interface AnnotationPopupProps {
  annotation: Annotation;
  currentUserId: string | null;
  isAdmin: boolean;
  onEdit: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onClose: () => void;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
  warning:  "bg-orange-500/20 text-orange-400 border-orange-500/30",
  info:     "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

const TYPE_LABEL: Record<string, string> = {
  perimeter: "Perimeter",
  hazard:    "Hazard",
  resource:  "Resource",
  note:      "Note",
};

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Annotation click popup.
 *
 * FIX(IUN-2268 #2): Edit/Delete buttons were previously gated on
 * currentUserId === authorId only. Spec requires org:admin to also see Delete
 * for any annotation. Now: Edit shows for own annotation or admin; Delete shows
 * for own annotation or admin.
 */
export function AnnotationPopup({
  annotation,
  currentUserId,
  isAdmin,
  onEdit,
  onDelete,
  onClose,
}: AnnotationPopupProps) {
  const isOwner = !!currentUserId && currentUserId === annotation.authorId;
  const canEdit = isOwner || isAdmin;
  const canDelete = isOwner || isAdmin;

  const authorInitial = (annotation.authorName ?? annotation.authorId).charAt(0).toUpperCase();

  return (
    <div className="absolute z-30 bottom-4 left-4 w-72 rounded-lg border border-border bg-card shadow-lg p-4">
      <button
        onClick={onClose}
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary text-sm font-semibold">
          {authorInitial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground truncate">
            {annotation.authorName ?? annotation.authorId} &middot; {timeAgo(annotation.createdAt)}
          </p>
          <p className="mt-0.5 text-sm font-medium leading-tight">{annotation.label}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Badge
          variant="outline"
          className="text-[11px] py-0 capitalize"
        >
          {TYPE_LABEL[annotation.annotationType] ?? annotation.annotationType}
        </Badge>
        <Badge
          variant="outline"
          className={cn("text-[11px] py-0 capitalize border", SEVERITY_BADGE[annotation.severity])}
        >
          {annotation.severity}
        </Badge>
        {annotation.visibility === "admin_only" && (
          <Badge variant="outline" className="text-[11px] py-0 text-muted-foreground">
            Admin only
          </Badge>
        )}
      </div>

      {annotation.irwinIncidentId && (
        <p className="mt-2 text-xs text-muted-foreground">
          IRWIN: {annotation.irwinIncidentId}
        </p>
      )}

      {(canEdit || canDelete) && (
        <div className="mt-3 flex gap-2">
          {canEdit && (
            <Button size="sm" variant="outline" className="flex-1 h-7 text-xs gap-1" onClick={() => onEdit(annotation)}>
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          )}
          {canDelete && (
            <Button size="sm" variant="outline" className="flex-1 h-7 text-xs gap-1 text-destructive hover:text-destructive" onClick={() => onDelete(annotation)}>
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
