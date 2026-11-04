import type { IssueWorkProduct } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { pullRequestHref, pullRequestIdentity, pullRequestLabel, pullRequestNeedsReview, pullRequestState } from "@/lib/issue-pull-requests";
import type { ExternalObjectPillData } from "./ExternalObjectPill";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import { externalObjectDisplayStatusLabel, externalObjectLivenessLabel } from "@/lib/external-objects";

/** Saved PRs remain inspectable even when the provider lookup is unavailable. */
export function IssuePullRequestLinks({ products, externalObjects = [] }: {
  products: IssueWorkProduct[];
  externalObjects?: ExternalObjectPillData[];
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-2">
      {products.map((product) => {
        const href = pullRequestHref(product);
        const label = pullRequestLabel(product);
        const state = pullRequestState(product);
        const identity = pullRequestIdentity(href);
        const provider = identity ? externalObjects.find((entry) => pullRequestIdentity(entry.url) === identity) : undefined;
        const providerStatus = provider ? externalObjectDisplayStatusLabel(provider) : null;
        const providerTerminal = provider?.liveness === "fresh"
          && (provider.statusIconKey === "git-merge" || ["merged", "closed"].includes(providerStatus?.toLowerCase() ?? ""));
        return (
          <li key={product.id} className="flex min-w-0 flex-wrap items-center gap-2">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" title={product.title}
                className="break-words text-sm text-primary underline-offset-2 hover:underline">
                {label}
              </a>
            ) : <span className="break-words text-sm">{label} · No PR link provided</span>}
            {provider ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                data-external-status={provider.statusCategory} data-external-liveness={provider.liveness}>
                <ExternalObjectStatusIcon category={provider.statusCategory} liveness={provider.liveness}
                  statusIconKey={provider.statusIconKey} label={providerStatus} />
                <span>{providerStatus}{!["fresh", "unknown"].includes(provider.liveness) ? ` (${externalObjectLivenessLabel(provider.liveness)})` : ""}</span>
              </span>
            ) : null}
            {pullRequestNeedsReview(product) && !providerTerminal ? (
              <Badge variant="outline">Review requested</Badge>
            ) : ["merged", "closed", "archived", "draft", "changes_requested"].includes(state)
              && providerStatus?.toLowerCase() !== state ? (
              <span className="text-xs text-muted-foreground">{provider ? "Saved: " : ""}{state.replaceAll("_", " ")}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
