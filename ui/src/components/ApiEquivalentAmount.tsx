import type { ApiEquivalent } from "@paperclipai/shared";
import { formatCents, formatTokens } from "../lib/utils";
import { Badge } from "./ui/badge";

export const API_EQUIVALENT_TOOLTIP =
  "At public API list prices. Uses the price Claude Code reported when available. Not an invoice.";

/** What usage would cost at pay-per-token API prices; comparison only, never spend. */
export function ApiEquivalentAmount({ value, prefix }: { value?: ApiEquivalent; prefix?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1" title={API_EQUIVALENT_TOOLTIP}>
      <span className="whitespace-nowrap font-mono tabular-nums">{prefix}{formatCents(value.cents)}</span>
      <Badge variant="outline" className="font-normal text-muted-foreground">Estimated</Badge>
      {value.unpricedTokens > 0 && (
        <span className="whitespace-nowrap text-muted-foreground">
          + {formatTokens(value.unpricedTokens)} tokens not priced
        </span>
      )}
    </span>
  );
}
