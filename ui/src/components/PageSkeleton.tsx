import { Skeleton } from "@/components/ui/skeleton";

interface PageSkeletonProps {
  variant?:
    | "list"
    | "issues-list"
    | "detail"
    | "dashboard"
    | "command-center"
    | "approvals"
    | "costs"
    | "inbox"
    | "org-chart";
}

export function PageSkeleton({ variant = "list" }: PageSkeletonProps) {
  if (variant === "dashboard") {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full border border-border" />

        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (variant === "command-center") {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-border p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <Skeleton className="h-3 w-44" />
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-4 w-[min(36rem,100%)]" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-24" />
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {Array.from({ length: 2 }).map((_, group) => (
            <div key={group} className="rounded-lg border border-border">
              <div className="border-b border-border px-4 py-3">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="mt-2 h-3 w-28" />
              </div>
              <div className="divide-y divide-border">
                {Array.from({ length: 3 }).map((_, row) => (
                  <div key={row} className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(160px,0.7fr)_minmax(220px,1fr)]">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-56" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-3 w-36" />
                    </div>
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-40" />
                    </div>
                    <Skeleton className="h-16 w-full" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === "approvals") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-44" />
        </div>
        <div className="grid gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (variant === "costs") {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </div>

        <Skeleton className="h-40 w-full" />

        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (variant === "inbox") {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-8 w-40" />
        </div>

        <div className="space-y-5">
          {Array.from({ length: 3 }).map((_, section) => (
            <div key={section} className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <div className="space-y-1 border border-border">
                {Array.from({ length: 3 }).map((_, row) => (
                  <Skeleton key={row} className="h-14 w-full rounded-none" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant === "org-chart") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[calc(100vh-4rem)] w-full rounded-lg border border-border" />
      </div>
    );
  }

  if (variant === "detail") {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-3 w-64" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-7 w-48" />
          </div>
          <Skeleton className="h-4 w-40" />
        </div>

        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (variant === "issues-list") {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-9 w-64" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>

        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <div className="space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full rounded-none" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-9 w-44" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      <div className="space-y-1">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
