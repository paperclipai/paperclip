import { useEffect } from "react";
import { Link } from "@/lib/router";
import { Activity, Inbox, ShieldCheck } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";

const GOVERNANCE_LINKS = [
  {
    title: "승인 대기열",
    description: "승인 대기열과 governed action을 바로 확인합니다.",
    href: "/approvals/pending",
    icon: ShieldCheck,
  },
  {
    title: "검토함",
    description: "사람 판단이 필요한 예외와 최근 신호를 확인합니다.",
    href: "/inbox/mine",
    icon: Inbox,
  },
  {
    title: "감사 기록",
    description: "최근 회사 활동과 감사 흔적을 추적합니다.",
    href: "/activity",
    icon: Activity,
  },
] as const;

export function GovernancePage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "승인/거버넌스" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={ShieldCheck} message="승인/거버넌스를 볼 회사를 먼저 선택하세요." />;
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card px-6 py-5">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            RealTycoon2 Governance
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">승인 대기열과 감사 신호</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            회사 단위의 승인, 예외 검토, 감사 기록을 한 곳에서 확인합니다.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {GOVERNANCE_LINKS.map((entry) => {
          const Icon = entry.icon;
          return (
            <Link
              key={entry.href}
              to={entry.href}
              className="rounded-lg border border-border bg-card px-5 py-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-foreground/80">
                <Icon className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium">{entry.title}</div>
                <p className="text-sm text-muted-foreground">{entry.description}</p>
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
