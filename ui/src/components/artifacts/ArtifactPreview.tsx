import { useQuery } from "@tanstack/react-query";
import { artifactsApi } from "@/api/artifacts";
import { Loader2, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ArtifactPreviewProps {
  artifactId: string;
  mimeType: string;
  title: string;
}

export function ArtifactPreview({ artifactId, mimeType, title }: ArtifactPreviewProps) {
  const contentUrl = artifactsApi.getContentUrl(artifactId);
  const isText = mimeType.startsWith("text/") || mimeType === "application/json";
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  const isHtml = mimeType === "text/html";
  const isMarkdown = mimeType === "text/markdown";

  const { data: textContent, isLoading } = useQuery({
    queryKey: ["artifact-preview", artifactId],
    queryFn: async () => {
      const res = await fetch(contentUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load preview");
      return res.text();
    },
    enabled: isText && !isHtml,
  });

  return (
    <div className="flex flex-col gap-2">
      {/* Action bar */}
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
          <a href={contentUrl} download={title}>
            <Download className="w-3.5 h-3.5 mr-1" />
            Download
          </a>
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
          <a href={contentUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="w-3.5 h-3.5 mr-1" />
            Open
          </a>
        </Button>
      </div>

      {/* Preview content */}
      {isImage && (
        <div className="flex justify-center bg-muted/20 rounded-md p-3 border border-border/50">
          <img
            src={contentUrl}
            alt={title}
            className="max-w-full max-h-[60vh] object-contain rounded"
          />
        </div>
      )}

      {isPdf && (
        <div className="rounded-md overflow-hidden border border-border/50" style={{ height: "calc(100vh - 280px)", minHeight: 300 }}>
          <iframe src={contentUrl} className="w-full h-full" title={title} />
        </div>
      )}

      {isHtml && (
        <div className="rounded-md overflow-hidden border border-border/50" style={{ height: "calc(100vh - 280px)", minHeight: 300 }}>
          <iframe
            src={contentUrl}
            className="w-full h-full bg-white"
            title={title}
            sandbox="allow-scripts"
          />
        </div>
      )}

      {isText && isLoading && (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {isText && !isLoading && !isHtml && (
        <div className="bg-muted/20 rounded-md border border-border/50 overflow-auto" style={{ maxHeight: "calc(100vh - 280px)" }}>
          <pre className={`p-4 text-sm font-mono whitespace-pre-wrap ${isMarkdown ? "leading-relaxed" : ""}`}>
            {textContent}
          </pre>
        </div>
      )}

      {!isImage && !isPdf && !isHtml && !isText && (
        <div className="flex flex-col items-center gap-3 p-8 bg-muted/20 rounded-md border border-border/50">
          <p className="text-sm text-muted-foreground">Preview not available for {mimeType}</p>
        </div>
      )}
    </div>
  );
}
