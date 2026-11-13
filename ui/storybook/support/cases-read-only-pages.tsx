import { Navigate, Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { Cases } from "@/pages/Cases";
import { CaseDetail } from "@/pages/CaseDetail";
import { PluginLauncherProvider } from "@/plugins/launchers";

/** Production routes and shell; only their network boundary is replaced in stories. */
export function ReadOnlyCasePages() {
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/cases" element={<Navigate to="/PAP/cases" replace />} />
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="cases" element={<Cases />} />
          <Route path="cases/:caseIdentifier" element={<CaseDetail />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
