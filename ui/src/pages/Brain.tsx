import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { Brain } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BrainGraphExplorer } from "../components/brain/BrainGraphExplorer";
import { BrainPagesBrowser } from "../components/brain/BrainPagesBrowser";
import { BrainSearch } from "../components/brain/BrainSearch";
import { BrainActivity } from "../components/brain/BrainActivity";
import { BrainEntityDetail } from "../components/brain/BrainEntityDetail";

type BrainTab = "graph" | "pages" | "search" | "activity";

const VALID_TABS = new Set<string>(["graph", "pages", "search", "activity"]);

export function BrainPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const [selectedEntitySlug, setSelectedEntitySlug] = useState<string | null>(null);

  const activeTab: BrainTab = tab && VALID_TABS.has(tab) ? (tab as BrainTab) : "graph";

  useEffect(() => {
    setBreadcrumbs([{ label: "Brain" }]);
  }, [setBreadcrumbs]);

  const handleTabChange = useCallback(
    (value: string) => {
      navigate(value === "graph" ? "/brain" : `/brain/${value}`, { replace: true });
      setSelectedEntitySlug(null);
    },
    [navigate],
  );

  const handleSelectEntity = useCallback((slug: string) => {
    setSelectedEntitySlug(slug);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedEntitySlug(null);
  }, []);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to explore the brain." />;
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full min-h-0">
          <div className="px-4 pt-3 shrink-0">
            <TabsList variant="line">
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
              <TabsTrigger value="search">Search</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="graph" className="flex-1 min-h-0">
            <BrainGraphExplorer companyId={selectedCompanyId} onSelectEntity={handleSelectEntity} />
          </TabsContent>

          <TabsContent value="pages" className="flex-1 min-h-0">
            <BrainPagesBrowser companyId={selectedCompanyId} onSelectEntity={handleSelectEntity} />
          </TabsContent>

          <TabsContent value="search" className="flex-1 min-h-0">
            <BrainSearch companyId={selectedCompanyId} onSelectEntity={handleSelectEntity} />
          </TabsContent>

          <TabsContent value="activity" className="flex-1 min-h-0">
            <BrainActivity companyId={selectedCompanyId} onSelectEntity={handleSelectEntity} />
          </TabsContent>
        </Tabs>
      </div>

      {selectedEntitySlug && (
        <div className="w-80 shrink-0 border-l border-border bg-background overflow-hidden">
          <BrainEntityDetail
            companyId={selectedCompanyId}
            slug={selectedEntitySlug}
            onNavigate={handleSelectEntity}
            onOpenInGraph={(slug) => {
              handleTabChange("graph");
              handleSelectEntity(slug);
            }}
            onClose={handleCloseDetail}
          />
        </div>
      )}
    </div>
  );
}
