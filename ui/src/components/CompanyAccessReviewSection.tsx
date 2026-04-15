import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

type CompanyAccessReviewSectionProps = {
  companyId: string;
};

export function CompanyAccessReviewSection({
  companyId,
}: CompanyAccessReviewSectionProps) {
  const reviewQuery = useQuery({
    queryKey: queryKeys.access.review(companyId),
    queryFn: () => accessApi.getCompanyAccessReview(companyId),
    enabled: Boolean(companyId),
    retry: false,
  });

  const error = reviewQuery.error;
  const permissionDenied =
    error instanceof ApiError && (error.status === 403 || error.status === 401);

  return (
    <div
      className="space-y-3 rounded-md border border-border px-4 py-4"
      data-testid="company-access-review-section"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-foreground">
          People with effective access
        </h2>
        <p className="text-sm text-muted-foreground">
          Review the humans who can currently access this company, including
          instance-admin authority that bypasses normal company membership.
        </p>
      </div>

      {reviewQuery.isLoading && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="company-access-review-loading"
        >
          Loading access review…
        </p>
      )}

      {reviewQuery.isError && (
        <div
          className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-3"
          data-testid="company-access-review-error"
        >
          <p className="text-sm text-muted-foreground">
            {permissionDenied
              ? "You need users:manage_permissions to review effective company access."
              : error instanceof Error
                ? error.message
                : "Failed to load the company access review."}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reviewQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {reviewQuery.isSuccess && reviewQuery.data.people.length === 0 && (
        <p
          className="text-sm text-muted-foreground"
          data-testid="company-access-review-empty"
        >
          No humans currently have effective access to this company.
        </p>
      )}

      {reviewQuery.isSuccess && reviewQuery.data.people.length > 0 && (
        <div className="space-y-3" data-testid="company-access-review-list">
          {reviewQuery.data.people.map((person) => (
            <div
              key={person.userId}
              className="space-y-2 rounded-md border border-border bg-background/60 px-3 py-3"
              data-testid={`company-access-review-entry-${person.userId}`}
            >
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">
                  {person.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {person.email ?? person.userId}
                </div>
              </div>

              <div className="space-y-1 text-sm">
                <div className="font-medium text-foreground">
                  Effective access
                </div>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {person.effectiveAccess.map((reason) => (
                    <li key={`${person.userId}-${reason.kind}`}>{reason.label}</li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1 text-sm">
                <div className="font-medium text-foreground">
                  Explicit company grants
                </div>
                {person.explicitPermissions.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {person.explicitPermissions.map((permission) => (
                      <li key={`${person.userId}-${permission}`}>{permission}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">No explicit company grants.</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
