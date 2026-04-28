import { useEffect } from "react";
import { Link } from "@/lib/router";
import {
  Activity,
  Bot,
  Boxes,
  CircleDot,
  DollarSign,
  Hexagon,
  Inbox,
  LayoutDashboard,
  Repeat,
  Settings,
  Target,
} from "lucide-react";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";

type ControlLink = {
  title: string;
  description: string;
  href: string;
  icon: typeof LayoutDashboard;
};

const CONTROL_LINKS: ControlLink[] = [
  {
    title: "업무 대시보드",
    description: "RealTycoon2 운영 현황과 주요 신호",
    href: "/dashboard",
    icon: LayoutDashboard,
  },
  {
    title: "받은 요청",
    description: "사람 중심 운영 요청과 예외 신호",
    href: "/inbox",
    icon: Inbox,
  },
  {
    title: "작업",
    description: "Task와 To-Do 실행 단위 관리",
    href: "/issues",
    icon: CircleDot,
  },
  {
    title: "프로젝트",
    description: "프로젝트별 세부 drill-down",
    href: "/projects",
    icon: Hexagon,
  },
  {
    title: "Jarvis",
    description: "Jarvis 상세 상태와 구성",
    href: "/agents",
    icon: Bot,
  },
  {
    title: "목표",
    description: "Mission, Objective, Key Result 관리",
    href: "/goals",
    icon: Target,
  },
  {
    title: "반복 실행",
    description: "반복 실행 흐름과 자동화 루틴",
    href: "/routines",
    icon: Repeat,
  },
  {
    title: "비용",
    description: "비용 및 사용량 추적",
    href: "/costs",
    icon: DollarSign,
  },
  {
    title: "운영 기록",
    description: "운영 활동 로그와 최근 변화",
    href: "/activity",
    icon: Activity,
  },
  {
    title: "스킬",
    description: "회사 기술/스킬 자산 관리",
    href: "/skills",
    icon: Boxes,
  },
  {
    title: "설정",
    description: "회사-level 설정과 입출력",
    href: "/company/settings",
    icon: Settings,
  },
];

export function ControlPlanePage() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "운영 엔진" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-border bg-card px-6 py-5">
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            운영 엔진
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">RealTycoon2 운영 엔진</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            엔진 세부 구현을 제품 정체성으로 노출하지 않고, 회사 context를 유지한 채 작업, 프로젝트,
            Jarvis, 비용, 활동 기록으로 이동합니다.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CONTROL_LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Link
              key={link.href}
              to={link.href}
              className="rounded-2xl border border-border bg-card px-5 py-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
            >
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-foreground/80">
                <Icon className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <div className="text-sm font-medium">{link.title}</div>
                <p className="text-sm text-muted-foreground">{link.description}</p>
              </div>
            </Link>
          );
        })}
      </section>
    </div>
  );
}
