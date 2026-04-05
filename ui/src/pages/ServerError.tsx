import { Link } from "@/lib/router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "../hooks/usePageTitle";

export function ServerErrorPage() {
  usePageTitle("Error");

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="mx-auto max-w-md px-6 text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-destructive/20 bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>

        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred. Our team has been notified and is looking into it.
        </p>

        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">Go to Dashboard</Link>
          </Button>
        </div>

        <p className="mt-8 text-xs text-muted-foreground">
          Error 500 - Internal Server Error
        </p>
      </div>
    </div>
  );
}
