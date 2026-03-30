import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import {
  BookOpen,
  Rocket,
  Users,
  MessageCircle,
  Shield,
  Brain,
  Keyboard,
  FolderOpen,
  CreditCard,
  Bot,
  LayoutDashboard,
  ListChecks,
  Target,
  Network,
  Settings,
  Activity,
  Inbox,
  ChevronRight,
} from "lucide-react";

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold mb-4">
        <Icon className="h-5 w-5 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 mb-4 last:mb-0">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
        {number}
      </div>
      <div className="flex-1">
        <h3 className="font-medium mb-1">{title}</h3>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function NavItem({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2 py-2">
      <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
      <div>
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground"> — {description}</span>
      </div>
    </div>
  );
}

function KeyboardShortcut({
  keys,
  description,
}: {
  keys: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <kbd className="px-2 py-1 rounded border bg-muted text-xs font-mono min-w-[80px] text-center">
        {keys}
      </kbd>
      <span className="text-sm">{description}</span>
    </div>
  );
}

export function UsageGuide() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "사용법" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">Paperclip 사용법</h1>
        <p className="text-muted-foreground">
          Paperclip은 AI 에이전트 조직을 관리하는 컨트롤 플레인입니다.
          회사를 만들고, 에이전트를 고용하고, 이슈를 통해 작업을 지시하세요.
        </p>
      </div>

      {/* 시작하기 */}
      <Section icon={Rocket} title="시작하기">
        <Step number={1} title="회사 만들기">
          처음 접속하면 온보딩 위자드가 시작됩니다. 회사 이름과 미션을 입력하세요.
          이것이 에이전트들이 일할 조직이 됩니다.
        </Step>
        <Step number={2} title="CEO 에이전트 생성">
          <div className="space-y-1">
            <p>첫 번째 에이전트를 만듭니다. 주요 설정:</p>
            <ul className="list-disc list-inside ml-2 space-y-0.5">
              <li><strong>이름</strong> — CEO, CTO 등 역할에 맞는 이름</li>
              <li><strong>어댑터</strong> — Claude Code (권장), Codex, Gemini CLI 등</li>
              <li><strong>작업 디렉토리</strong> — 에이전트가 작업할 폴더 경로 (전체 경로 입력)</li>
              <li><strong>모델</strong> — 사용할 AI 모델 선택</li>
            </ul>
          </div>
        </Step>
        <Step number={3} title="첫 이슈 생성">
          에이전트에게 시킬 첫 번째 작업을 만드세요.
          이슈가 생성되면 에이전트가 자동으로 작업을 시작합니다.
        </Step>
        <Step number={4} title="환경 테스트">
          온보딩에서 "지금 테스트" 버튼으로 어댑터가 제대로 설치되었는지 확인하세요.
          실패하면 해당 CLI 도구가 시스템에 설치되어 있는지 확인해야 합니다.
        </Step>
      </Section>

      {/* 주요 메뉴 */}
      <Section icon={LayoutDashboard} title="주요 메뉴 안내">
        <div className="text-sm space-y-0.5">
          <NavItem label="대시보드" description="회사 현황 요약, 활동 중인 에이전트, 비용, 최근 활동" />
          <NavItem label="받은함" description="에이전트 활동 알림, 승인 요청, 읽지 않은 업데이트" />
          <NavItem label="이슈" description="에이전트에게 할당할 작업 목록. 생성/편집/상태 관리" />
          <NavItem label="목표" description="회사의 상위 목표 설정. 이슈를 목표에 연결 가능" />
          <NavItem label="조직도" description="에이전트 간 보고 구조를 시각적으로 확인" />
          <NavItem label="비용" description="AI 모델 사용 비용 추적, 분석 (제공자/모델/에이전트별)" />
          <NavItem label="활동" description="전체 회사 활동 로그 (실행, 이슈 변경, 댓글 등)" />
          <NavItem label="설정" description="회사명, 로고, 브랜드 색상, 예산 정책, 위험 존" />
        </div>
      </Section>

      {/* 에이전트 관리 */}
      <Section icon={Bot} title="에이전트 관리">
        <div className="text-sm space-y-3">
          <div>
            <h3 className="font-medium mb-1">에이전트 추가</h3>
            <p className="text-muted-foreground">
              사이드바의 에이전트 옆 "+" 버튼 또는 에이전트 목록에서 "새 에이전트"를 클릭합니다.
              이름, 직함, 어댑터 유형, 상위 에이전트(보고 대상)를 설정합니다.
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-1">에이전트 상태</h3>
            <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground">
              <li><strong>활성</strong> — 이슈를 받을 수 있는 상태</li>
              <li><strong>실행 중</strong> — 현재 작업을 수행하는 중</li>
              <li><strong>일시정지</strong> — 수동 또는 예산 초과로 정지됨</li>
              <li><strong>대기 중</strong> — 할당된 작업이 없는 상태</li>
            </ul>
          </div>
          <div>
            <h3 className="font-medium mb-1">에이전트 상세 탭</h3>
            <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground">
              <li><strong>개요</strong> — 상태, 최근 실행, 할당된 이슈, 차트</li>
              <li><strong>구성</strong> — 어댑터 설정, 모델, 작업 디렉토리 변경</li>
              <li><strong>스킬</strong> — 에이전트에 할당된 스킬 관리</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 이슈/작업 */}
      <Section icon={ListChecks} title="이슈와 작업">
        <div className="text-sm space-y-3">
          <div>
            <h3 className="font-medium mb-1">이슈 만들기</h3>
            <p className="text-muted-foreground">
              사이드바 상단의 "새 이슈" 버튼 또는 이슈 목록에서 생성합니다.
              제목, 설명, 담당 에이전트, 우선순위, 프로젝트를 지정할 수 있습니다.
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-1">이슈 상태 흐름</h3>
            <p className="text-muted-foreground">
              <code className="bg-muted px-1 rounded">할 일</code> →{" "}
              <code className="bg-muted px-1 rounded">진행 중</code> →{" "}
              <code className="bg-muted px-1 rounded">검토 중</code> →{" "}
              <code className="bg-muted px-1 rounded">완료</code>
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-1">이슈 상세 페이지</h3>
            <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground">
              <li><strong>대화 탭</strong> — 에이전트와 채팅 형태로 소통 (에이전트 할당 시 기본 탭)</li>
              <li><strong>댓글 탭</strong> — 전통적인 코멘트 뷰</li>
              <li><strong>문서</strong> — 이슈에 첨부된 문서, 파일 관리</li>
              <li><strong>실행 요약</strong> — 최근 에이전트 실행 결과 요약</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* CEO에게 질문하기 */}
      <Section icon={MessageCircle} title="CEO에게 질문하기">
        <div className="text-sm space-y-3">
          <div>
            <h3 className="font-medium mb-1">빠른 질문 (플로팅 버튼)</h3>
            <p className="text-muted-foreground">
              화면 우하단의 말풍선 버튼을 클릭하면 CEO에게 바로 질문할 수 있습니다.
              질문을 입력하면 자동으로 이슈가 생성되고 CEO 에이전트가 응답합니다.
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-1">Board 커맨드 (Cmd+J)</h3>
            <p className="text-muted-foreground">
              세 가지 모드로 에이전트에게 지시할 수 있습니다:
            </p>
            <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground mt-1">
              <li><strong>질문</strong> — 에이전트에게 정보를 물어볼 때</li>
              <li><strong>작업</strong> — 구체적인 작업을 시킬 때</li>
              <li><strong>결정</strong> — 중요한 의사결정을 요청할 때</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* 프로젝트 */}
      <Section icon={FolderOpen} title="프로젝트">
        <div className="text-sm space-y-3">
          <p className="text-muted-foreground">
            프로젝트로 이슈를 그룹으로 묶어 관리할 수 있습니다.
          </p>
          <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground">
            <li>프로젝트별 이슈 보기 및 필터링</li>
            <li>프로젝트 색상으로 시각적 구분</li>
            <li>코드베이스 연결 (GitHub 리포지토리, 로컬 폴더)</li>
            <li>실행 워크스페이스 관리 (Git Worktree 격리)</li>
            <li>프로젝트별 예산 정책 설정</li>
          </ul>
        </div>
      </Section>

      {/* 비용 관리 */}
      <Section icon={CreditCard} title="비용 및 예산">
        <div className="text-sm space-y-3">
          <div>
            <h3 className="font-medium mb-1">비용 추적</h3>
            <p className="text-muted-foreground">
              비용 페이지에서 AI 모델 사용 비용을 실시간으로 확인합니다.
              "분석" 탭에서 청구자, 제공자, 모델, 에이전트별로 비용을 분석할 수 있습니다.
            </p>
          </div>
          <div>
            <h3 className="font-medium mb-1">예산 정책</h3>
            <p className="text-muted-foreground">
              설정 페이지에서 예산 정책을 생성합니다:
            </p>
            <ul className="list-disc list-inside ml-2 space-y-0.5 text-muted-foreground mt-1">
              <li><strong>소프트 경고</strong> — 임계값 도달 시 알림만 표시</li>
              <li><strong>하드 스톱</strong> — 임계값 도달 시 에이전트 자동 일시정지</li>
              <li>대상: 회사 전체, 특정 에이전트, 특정 프로젝트</li>
              <li>기간: 월별 또는 전체 기간</li>
            </ul>
          </div>
          <div>
            <h3 className="font-medium mb-1">예산 경고</h3>
            <p className="text-muted-foreground">
              사이드바 "비용" 메뉴 옆에 경고 배지가 표시됩니다.
              예산 인시던트 발생 시 설정 페이지에서 "예산 증액 및 재개" 또는 "일시정지 유지"를 선택할 수 있습니다.
            </p>
          </div>
        </div>
      </Section>

      {/* 조직 구조 */}
      <Section icon={Network} title="조직 구조">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            에이전트들은 상하 보고 구조를 가질 수 있습니다. CEO가 CTO에게, CTO가 엔지니어에게 작업을 위임하는 형태입니다.
          </p>
          <p>
            조직도 페이지에서 전체 구조를 시각적으로 확인할 수 있고, 확대/축소/화면 맞추기 기능이 제공됩니다.
          </p>
        </div>
      </Section>

      {/* 승인 */}
      <Section icon={Shield} title="승인">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            에이전트가 새 에이전트 채용, 예산 초과 등 중요한 작업을 수행하려 할 때 승인을 요청합니다.
          </p>
          <ul className="list-disc list-inside ml-2 space-y-0.5">
            <li>승인 페이지에서 대기 중인 요청 확인</li>
            <li>승인 또는 거부 가능</li>
            <li>댓글로 에이전트에게 추가 지시 가능</li>
            <li>설정에서 "신입 채용 시 보드 승인 필요" 옵션 설정</li>
          </ul>
        </div>
      </Section>

      {/* 메모리 */}
      <Section icon={Brain} title="메모리 시스템">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            에이전트가 이전 대화와 결정을 기억할 수 있는 메모리 시스템이 내장되어 있습니다.
          </p>
          <ul className="list-disc list-inside ml-2 space-y-0.5">
            <li>메모리는 회사 단위로 격리됩니다</li>
            <li>에이전트 실행 후 자동 기록 또는 수동 저장 가능</li>
            <li>검색으로 관련 메모리를 찾아 에이전트 컨텍스트에 주입</li>
            <li>모든 메모리 작업은 감사 로그에 기록됩니다</li>
          </ul>
        </div>
      </Section>

      {/* 키보드 단축키 */}
      <Section icon={Keyboard} title="키보드 단축키">
        <div className="space-y-1">
          <KeyboardShortcut keys="Cmd + K" description="커맨드 팔레트 — 빠른 검색, 페이지 이동, 작업 실행" />
          <KeyboardShortcut keys="Cmd + J" description="Board 커맨드 — CEO에게 질문/작업/결정 요청" />
          <KeyboardShortcut keys="Enter" description="채팅 메시지 전송 (이슈 대화 탭)" />
        </div>
      </Section>

      {/* 팁 */}
      <section className="rounded-lg border border-primary/20 bg-primary/5 p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold mb-3">
          💡 유용한 팁
        </h2>
        <ul className="text-sm space-y-2 text-muted-foreground">
          <li>
            <strong>작업 디렉토리 주의</strong> — 에이전트 설정 시 작업 디렉토리는 반드시 전체
            경로를 입력하세요 (예: <code className="bg-muted px-1 rounded">/Users/사용자명/프로젝트</code>).
            상대 경로나 잘린 경로는 오류를 발생시킵니다.
          </li>
          <li>
            <strong>이슈 = 대화</strong> — 이슈 상세 페이지의 "대화" 탭에서 에이전트와 채팅처럼
            소통할 수 있습니다. 메시지를 보내면 에이전트가 자동으로 깨어나 응답합니다.
          </li>
          <li>
            <strong>예산 설정 권장</strong> — 비용 폭주를 방지하려면 회사 또는 에이전트별 월간
            예산 정책을 설정하세요. 하드 스톱 정책은 자동으로 에이전트를 멈춥니다.
          </li>
          <li>
            <strong>에이전트 환경 테스트</strong> — 에이전트가 실행에 실패하면 어댑터 CLI가
            시스템에 설치되어 있는지 확인하세요 (예: claude, codex, gemini 명령어).
          </li>
        </ul>
      </section>
    </div>
  );
}
