import { memo, useMemo } from "react";
import { createUnifiedDiffClassifier } from "@/lib/patch";

export const PatchLines = memo(function PatchLines({ text }: { text: string }) {
  const lines = useMemo(() => {
    const classify = createUnifiedDiffClassifier();
    return text.split(/(?<=\n)/).map((line) => ({
      text: line,
      kind: classify(line.replace(/\r?\n$/, "")).kind,
    }));
  }, [text]);
  return <>{lines.map((line, index) => (
    <span key={index} className="paperclip-patch-line" data-patch-line={line.kind}>{line.text}</span>
  ))}</>;
});
