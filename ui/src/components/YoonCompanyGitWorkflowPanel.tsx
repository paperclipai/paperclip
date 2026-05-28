import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Github,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { cn } from "../lib/utils";

const LOCAL_WORKSPACE = "C:\\yooncompany\\external\\paperclip";
const FORK_REPOSITORY = "hy60002/paperclip";
const UPSTREAM_REPOSITORY = "paperclipai/paperclip";
const BRANCH_PREFIX = "codex/";

const workflowSteps = [
  {
    icon: FolderOpen,
    title: "로컬 작업 폴더",
    value: LOCAL_WORKSPACE,
    body: "Codex가 실제 코드를 읽고 수정하는 Windows 폴더입니다. 화면의 GitHub 저장소 목록과 같은 것이 아닙니다.",
  },
  {
    icon: Github,
    title: "개인 포크",
    value: FORK_REPOSITORY,
    body: "Codex 브랜치는 먼저 사용자 포크로 push합니다. 원본 저장소에 직접 push하지 않습니다.",
  },
  {
    icon: Github,
    title: "공개 원본",
    value: UPSTREAM_REPOSITORY,
    body: "PR의 대상 저장소입니다. 머지는 원본 저장소 권한과 base branch 정책을 통과해야 합니다.",
  },
  {
    icon: GitBranch,
    title: "브랜치",
    value: `${BRANCH_PREFIX}작은-단위-작업명`,
    body: "한 브랜치에는 검증 가능한 작은 범위만 싣고, 기존 변경을 되돌리지 않습니다.",
  },
  {
    icon: GitPullRequest,
    title: "PR",
    value: `${FORK_REPOSITORY} -> ${UPSTREAM_REPOSITORY}`,
    body: "typecheck, test, browser 검증과 PR CI 결과를 증거로 남긴 뒤 다음 단위로 넘어갑니다.",
  },
  {
    icon: GitMerge,
    title: "머지",
    value: "CI 통과 + 원본 정책/권한 필요",
    body: "권한이나 branch policy가 막으면 Codex가 우회하지 않고 결과를 보고합니다.",
  },
];

const safetyRules = [
  "commit/push/PR/merge는 승인 범위와 실제 diff가 일치할 때만 진행",
  "paperclipai/paperclip 원본 정책을 우회하는 admin merge 금지",
  "CI 실패, pending, 권한 부족, branch policy block은 머지 중단 사유",
  "배포, DB 변경, 삭제, 외부 공개, 비용 변경은 별도 L3/L4 승인 필요",
];

function WorkflowStep({
  icon: Icon,
  title,
  value,
  body,
}: {
  icon: typeof FolderOpen;
  title: string;
  value: string;
  body: string;
}) {
  return (
    <div className="min-w-0 border border-border bg-background px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{title}</span>
      </div>
      <div className="mt-1 break-words text-sm font-medium">{value}</div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
    </div>
  );
}

export function YoonCompanyGitWorkflowPanel({ className }: { className?: string }) {
  return (
    <section
      className={cn("border border-border bg-muted/20 p-4", className)}
      aria-label="YoonCompany GitHub 작업 위치 안내"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            로컬/GitHub/PR 위치 안내
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            이 패널은 작업 위치와 승인 경계를 설명하는 읽기 전용 안내입니다. 여기서 git 상태를 변경하거나 머지를 실행하지 않습니다.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <a
            href="https://github.com/hy60002/paperclip"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 border border-border bg-background px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            포크 열기
            <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href="https://github.com/paperclipai/paperclip/pulls"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 border border-border bg-background px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            원본 PR 보기
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {workflowSteps.map((step) => (
          <WorkflowStep key={step.title} {...step} />
        ))}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[1.1fr_1fr]">
        <div className="border border-border bg-background px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" />
            표준 작업 순서
          </div>
          <div className="mt-2 grid gap-1 text-xs leading-5 text-muted-foreground">
            <div>1. 실제 코드와 git status 확인</div>
            <div>2. 의도 파일만 구현, stage, commit</div>
            <div>3. 사용자 포크로 push 후 원본 대상으로 PR 생성/갱신</div>
            <div>4. typecheck/test/browser와 PR CI 결과를 PR 댓글에 증거로 남김</div>
            <div>5. 원본 정책과 권한이 허용할 때만 merge</div>
          </div>
        </div>

        <div className="border border-amber-400/40 bg-amber-50/60 px-3 py-2 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <ShieldCheck className="h-3.5 w-3.5" />
            승인/차단 기준
          </div>
          <div className="mt-2 grid gap-1.5">
            <div className="flex items-start gap-2 text-xs leading-5">
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>승인 id는 작업 이슈와 PR 증거 댓글에 남김</span>
            </div>
            {safetyRules.map((rule) => (
              <div key={rule} className="flex items-start gap-2 text-xs leading-5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{rule}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
