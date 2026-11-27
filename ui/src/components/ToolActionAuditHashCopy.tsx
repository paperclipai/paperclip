import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useCopyAction } from "@/lib/use-copy-action";
import { Button } from "./ui/button";

/**
 * The reviewed-arguments hash identifies exactly what an approval covers, which
 * matters for audits but means nothing to the person approving. Keep it off the
 * card and reachable through a copy action instead of printing the raw digest.
 * When the clipboard is blocked, show the hash as selectable text so the audit
 * value never becomes unreachable.
 */
export function ToolActionAuditHashCopy({ hash }: { hash: string }) {
  const { status, copy } = useCopyAction();
  const [copyFailed, setCopyFailed] = useState(false);
  const label = status === "copied" ? "Copied" : status === "failed" ? "Couldn’t copy" : "Copy audit hash";
  const Icon = status === "copied" ? Check : status === "failed" ? X : Copy;
  return (
    <div className="mt-1 space-y-1">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="text-muted-foreground"
        title="Copy the hash that identifies these exact arguments"
        onClick={() => {
          void copy(hash).then(result => {
            if (result === "failed") setCopyFailed(true);
          });
        }}
      >
        <Icon aria-hidden="true" />
        {label}
      </Button>
      {copyFailed ? (
        <p className="select-all break-all font-mono text-xs text-muted-foreground" aria-label="Audit hash">
          {hash}
        </p>
      ) : null}
    </div>
  );
}
