import { useState } from "react";
import type { Artifact } from "@paperclipai/shared";
import {
  FileText,
  FileCode,
  FileImage,
  File,
  Download,
  MoreHorizontal,
  ExternalLink,
  Pencil,
  Trash2,
  FolderInput,
  Link,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { artifactsApi } from "@/api/artifacts";
import { ArtifactPreview } from "./ArtifactPreview";
import { cn } from "@/lib/utils";

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return FileImage;
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/pdf"
  )
    return FileText;
  if (
    mimeType.includes("javascript") ||
    mimeType.includes("typescript") ||
    mimeType.includes("css") ||
    mimeType.includes("html")
  )
    return FileCode;
  return File;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

interface ArtifactFileListProps {
  artifacts: Artifact[];
  isLoading: boolean;
  onRename: (artifact: Artifact) => void;
  onMove: (artifact: Artifact) => void;
  onDelete: (artifact: Artifact) => void;
  onOpenInFinder: (artifact: Artifact) => void;
  storageProvider?: string;
}

export function ArtifactFileList({
  artifacts,
  isLoading,
  onRename,
  onMove,
  onDelete,
  onOpenInFinder,
  storageProvider,
}: ArtifactFileListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No files in this folder
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left font-medium px-3 py-2 w-8"></th>
            <th className="text-left font-medium px-3 py-2">Name</th>
            <th className="text-left font-medium px-3 py-2 w-24">Type</th>
            <th className="text-left font-medium px-3 py-2 w-28">Created</th>
            <th className="text-right font-medium px-3 py-2 w-10"></th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => {
            const Icon = getFileIcon(artifact.mimeType);
            const isExpanded = expandedId === artifact.id;
            return (
              <ArtifactRow
                key={artifact.id}
                artifact={artifact}
                Icon={Icon}
                isExpanded={isExpanded}
                onTogglePreview={() => setExpandedId(isExpanded ? null : artifact.id)}
                onRename={onRename}
                onMove={onMove}
                onDelete={onDelete}
                onOpenInFinder={onOpenInFinder}
                storageProvider={storageProvider}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactRow({
  artifact,
  Icon,
  isExpanded,
  onTogglePreview,
  onRename,
  onMove,
  onDelete,
  onOpenInFinder,
  storageProvider,
}: {
  artifact: Artifact;
  Icon: React.ComponentType<{ className?: string }>;
  isExpanded: boolean;
  onTogglePreview: () => void;
  onRename: (a: Artifact) => void;
  onMove: (a: Artifact) => void;
  onDelete: (a: Artifact) => void;
  onOpenInFinder: (a: Artifact) => void;
  storageProvider?: string;
}) {
  const contentUrl = artifactsApi.getContentUrl(artifact.id);

  return (
    <>
      <tr
        className={cn(
          "border-b hover:bg-muted/50 cursor-pointer group",
          isExpanded && "bg-muted/30",
        )}
        onClick={onTogglePreview}
      >
        <td className="px-3 py-2">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="truncate">{artifact.title}</span>
          </div>
        </td>
        <td className="px-3 py-2 text-muted-foreground truncate">
          {artifact.mimeType.split("/")[1] || artifact.mimeType}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{formatDate(artifact.createdAt)}</td>
        <td className="px-3 py-2 text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={contentUrl} download={artifact.title}>
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </a>
              </DropdownMenuItem>
              {storageProvider === "local_disk" && (
                <DropdownMenuItem onClick={() => onOpenInFinder(artifact)}>
                  <ExternalLink className="w-4 h-4 mr-2" />
                  Open in Finder
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  navigator.clipboard.writeText(
                    `${window.location.origin}${contentUrl}`,
                  );
                }}
              >
                <Link className="w-4 h-4 mr-2" />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRename(artifact)}>
                <Pencil className="w-4 h-4 mr-2" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(artifact)}>
                <FolderInput className="w-4 h-4 mr-2" />
                Move to...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(artifact)}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={5} className="p-0">
            <div className="px-4 py-3 bg-muted/5 border-b">
              <ArtifactPreview
                artifactId={artifact.id}
                mimeType={artifact.mimeType}
                title={artifact.title}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
