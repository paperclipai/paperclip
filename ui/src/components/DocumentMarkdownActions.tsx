import { Copy, Download } from "lucide-react";
import type { IssueDocument } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { downloadDocumentFile } from "@/lib/download-document-file";
import { useCopyAction } from "@/lib/use-copy-action";

export function DocumentMarkdownActions({ document }: { document: Pick<IssueDocument, "key" | "body"> }) {
  const { copied, failed, copy } = useCopyAction();

  return (
    <div className="ml-auto flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => void copy(document.body)}>
        <Copy aria-hidden />
        Copy Markdown
      </Button>
      <Button variant="ghost" size="sm" onClick={() => downloadDocumentFile(document.key, document.body)}>
        <Download aria-hidden />
        Download Markdown
      </Button>
      <span role="status">{copied ? "Copied" : failed ? "Could not copy Markdown" : null}</span>
    </div>
  );
}
