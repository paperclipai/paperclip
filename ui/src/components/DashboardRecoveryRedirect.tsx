import { Navigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";

export function DashboardRecoveryRedirect() {
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Loading dashboard…
      </p>
    );
  }

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  if (!fallbackCompany) {
    return <Navigate to="/" replace />;
  }

  return <Navigate to={`/${fallbackCompany.issuePrefix}/dashboard`} replace />;
}
