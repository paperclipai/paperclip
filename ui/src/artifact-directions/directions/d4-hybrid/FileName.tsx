import { cn } from "@/lib/utils";

/**
 * A filename is a machine value: monospace. When it does not fit, the stem
 * truncates and the extension never does — two files that share a long stem
 * (`acmehats-interface-craft.pptx` / `.pdf`) stay tellable apart.
 *
 * `mono={false}` is for a human title standing in where a file has no name.
 */
export function FileName({ name, mono = true, className }: { name: string; mono?: boolean; className?: string }) {
  const dot = mono ? name.lastIndexOf(".") : -1;
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return (
    <span data-filename className={cn("flex min-w-0", mono ? "font-mono" : null, className)}>
      <span className="truncate">{stem}</span>
      {ext ? <span className="shrink-0">{ext}</span> : null}
    </span>
  );
}
