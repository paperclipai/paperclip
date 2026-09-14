import { useEffect, useLayoutEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { RuntimeServices, RuntimeServiceDetail } from "@/pages/RuntimeServices";
import { CompanyEnvironments } from "@/pages/CompanyEnvironments";
import { AuthPage } from "@/pages/Auth";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Navigate, Route, Routes, useNavigate } from "@/lib/router";
import { environmentId, installRuntimeServiceReview, reviewTask, serviceId, type ServiceScenario } from "../fixtures/runtimeServices";

export interface RuntimeServicesReviewProps {
  page?: "inventory" | "detail" | "task" | "environments" | "auth";
  scenario?: ServiceScenario;
}

/** Production routes and production app shell; only the API responses are simulated. */
export function RuntimeServicesReview({ page = "inventory", scenario = "ready" }: RuntimeServicesReviewProps) {
  const [fixture] = useState(() => installRuntimeServiceReview(scenario, page));
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const path = page === "task" ? `/PAP/issues/${reviewTask.identifier}`
    : page === "detail" ? `/PAP/runtime-services/${serviceId}`
    : page === "environments" ? `/PAP/company/settings/instance/environments/${environmentId}/edit`
    : page === "auth" ? `/auth?next=${encodeURIComponent(`/runtime-previews/open/${serviceId}/web?path=%2Fdashboard`)}`
    : "/PAP/runtime-services";
  useLayoutEffect(() => { if (!ready) { navigate(path, { replace: true }); setReady(true); } }, [navigate, path, ready]);
  useEffect(() => () => fixture.restore(), [fixture]);
  return <QueryClientProvider client={fixture.client}><PluginLauncherProvider>
    {ready && <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="runtime-services" element={<RuntimeServices />} />
        <Route path="runtime-services/:serviceId" element={<RuntimeServiceDetail />} />
        <Route path="issues/:issueId" element={<IssueDetail />} />
        <Route path="company/settings/instance/environments" element={<CompanyEnvironments />} />
        <Route path="company/settings/instance/environments/:environmentId/edit" element={<CompanyEnvironments mode="edit" />} />
      </Route>
      <Route path="*" element={<Navigate to={path} replace />} />
    </Routes>}
  </PluginLauncherProvider></QueryClientProvider>;
}
