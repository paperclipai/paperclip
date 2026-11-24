import { useState } from "react";
import { Copy, Download } from "lucide-react";
import type { IssueDocument } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";
import { downloadDocumentFile } from "@/lib/download-document-file";

export function DocumentMarkdownActions({ document }: { document: Pick<IssueDocument, "key" | "body"> }) {
  const [copyStatus, setCopyStatus] = useState<"Copied" | "Could not copy Markdown">();

  async function copyMarkdown() {
    try {
      await copyTextToClipboard(document.body);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Could not copy Markdown");
    }
  }

  return (
    <div className="ml-auto flex flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" onClick={copyMarkdown}>
        <Copy aria-hidden />
        Copy Markdown
      </Button>
      <Button variant="ghost" size="sm" onClick={() => downloadDocumentFile(document.key, document.body)}>
        <Download aria-hidden />
        Download Markdown
      </Button>
      <span role="status">{copyStatus}</span>
    </div>
  );
}
