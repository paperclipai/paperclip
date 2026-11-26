import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { ReviewQueueCard } from "./ReviewQueueCard";
import { useReviewQueue } from "./useReviewCount";

/**
 * Review — the "decisions waiting on you" inbox (PAP-12371, Finding B).
 *
 * Ask-first approvals used to live only inside the "Needs attention" page,
 * folded together with health/error triage. That buried the one thing a user
 * must act on for their agents to proceed. This is the explicit, top-level
 * home for those approvals, aligned with the Inbox "waiting for your OK"
 * language from the approved PAP-11178 gateway UX. Health issues stay on
 * "Needs attention"; decisions live here.
 */
export function AppsReview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queue = useReviewQueue();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Plugins", href: "/apps" },
      { label: "Reviews" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select an organization to review approvals.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-16">
      <header className="flex flex-col gap-3">
        <Button asChild variant="ghost" size="sm" className="-ml-3 h-8 self-start text-muted-foreground">
          <Link to="/apps"><ArrowLeft className="size-4" aria-hidden />Plugins</Link>
        </Button>
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl leading-8 font-semibold tracking-tight text-foreground">Reviews</h1>
          {queue.loaded ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {queue.count === 0
                ? "Nothing is waiting on you."
                : `${queue.count} ${queue.count === 1 ? "request" : "requests"} from your plugins ${queue.count === 1 ? "is" : "are"} waiting on you.`}
            </p>
          ) : null}
        </div>
      </header>

      <ReviewQueueCard layout="decisions" />
    </div>
  );
}
