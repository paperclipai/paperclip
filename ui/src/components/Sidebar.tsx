import {
  BookOpen,
  Bot,
  ClipboardList,
  DollarSign,
  Network,
  Boxes,
  Settings,
  ShieldCheck,
  Search,
  SquarePen,
  Building2,
  GitBranch,
  FileText,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { CompanySwitcher } from "./CompanySwitcher";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";

export function Sidebar() {
  const navigate = useNavigate();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-64 h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/10 text-xs font-semibold text-emerald-500">
            RT
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500">RealTycoon2</div>
            <CompanySwitcher />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0"
            onClick={openSearch}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-3">
        <div className="flex flex-col gap-0.5">
          <button
            onClick={() => navigate("/one-liner")}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">업무 빠른 기록</span>
          </button>
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label="업무 운영">
          <SidebarNavItem to="/one-liner" label="일일 업무 기록" icon={SquarePen} />
          <SidebarNavItem to="/issues" label="업무 보드" icon={ClipboardList} />
          <SidebarNavItem to="/knowledge" label="지식 위키/그래프" icon={BookOpen} />
          <SidebarNavItem to="/pnl" label="성과 정산" icon={DollarSign} />
          <SidebarNavItem to="/org" label="조직/OKR" icon={Network} />
          <SidebarNavItem to="/governance" label="승인/거버넌스" icon={ShieldCheck} badge={inboxBadge.approvals} />
        </SidebarSection>

        <SidebarSection label="확장 운영">
          <SidebarNavItem to="/enterprise-rollout" label="기업 연동" icon={Building2} />
          <SidebarNavItem to="/marketplace" label="Jarvis 마켓" icon={Boxes} />
          <SidebarNavItem to="/plan-alignment" label="개발기획서 정합성" icon={FileText} />
          <SidebarNavItem to="/activity" label="자동화 실행 기록" icon={GitBranch} liveCount={liveRunCount} />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="관리">
          <SidebarNavItem to="/costs" label="비용/예산" icon={DollarSign} />
          <SidebarNavItem to="/skills" label="재사용 스킬" icon={Bot} />
          <SidebarNavItem to="/company/settings" label="회사 설정" icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
