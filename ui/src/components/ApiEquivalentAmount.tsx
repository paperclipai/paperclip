import type { ApiEquivalent } from "@paperclipai/shared";
import { formatCents, formatTokens } from "../lib/utils";
import { Badge } from "./ui/badge";

export const API_EQUIVALENT_TOOLTIP =
  "At public API list prices. Uses the price Claude Code reported when available. Not an invoice.";

export function formatApiEquivalent(value?: Pick<ApiEquivalent, "cents" | "unpricedTokens">): string {
  if (!value) return "—";
  if (value.cents === 0 && value.unpricedTokens > 0) return "Not priced";
  return formatCents(value.cents);
}

export function unpricedTokensNote(unpricedTokens?: number): string {
  return unpricedTokens ? `${formatTokens(unpricedTokens)} tokens not priced` : "";
}

export function ApiEquivalentAmount({ value }: { value?: ApiEquivalent }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const note = unpricedTokensNote(value.unpricedTokens);
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1" title={API_EQUIVALENT_TOOLTIP}>
      <span className="whitespace-nowrap font-mono tabular-nums">{formatApiEquivalent(value)}</span>
      <Badge variant="outline" className="font-normal text-muted-foreground">Estimated</Badge>
      {note && value.cents > 0 && <span className="whitespace-nowrap text-muted-foreground">+ {note}</span>}
      {note && value.cents === 0 && <span className="whitespace-nowrap text-muted-foreground">{note}</span>}
    </span>
  );
}
