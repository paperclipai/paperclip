import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "en" | "ko";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: string, vars?: Record<string, string>) => string;
}

const LOCALE_STORAGE_KEY = "paperclip.locale";

const messages: Record<Locale, Record<string, string>> = {
  en: {
    "layout.skipToMain": "Skip to Main Content",
    "layout.documentation": "Documentation",
    "layout.switchTheme": "Switch to {theme} mode",
    "layout.switchLanguage": "Switch to Korean",
    "theme.light": "light",
    "theme.dark": "dark",

    "sidebar.selectCompany": "Select company",
    "sidebar.newIssue": "New Issue",
    "sidebar.dashboard": "Dashboard",
    "sidebar.inbox": "Inbox",
    "sidebar.work": "Work",
    "sidebar.issues": "Issues",
    "sidebar.goals": "Goals",
    "sidebar.company": "Company",
    "sidebar.org": "Org",
    "sidebar.costs": "Costs",
    "sidebar.activity": "Activity",
    "sidebar.settings": "Settings",

    "issues.breadcrumb": "Issues",
    "issues.selectCompany": "Select a company to view issues.",
    "goals.breadcrumb": "Goals",
    "goals.selectCompany": "Select a company to view goals.",
    "goals.empty": "No goals yet.",
    "goals.add": "Add Goal",
    "goals.new": "New Goal",

    "settings.company": "Company",
    "settings.breadcrumb": "Settings",
    "settings.title": "Company Settings",
    "settings.general": "General",
    "settings.companyName": "Company name",
    "settings.companyNameHint": "The display name for your company.",
    "settings.description": "Description",
    "settings.descriptionHint": "Optional description shown in the company profile.",
    "settings.descriptionPlaceholder": "Optional company description",
    "settings.appearance": "Appearance",
    "settings.brandColor": "Brand color",
    "settings.brandColorHint": "Sets the hue for the company icon. Leave empty for auto-generated color.",
    "settings.clear": "Clear",
    "settings.saveChanges": "Save changes",
    "settings.saving": "Saving...",
    "settings.saved": "Saved",
    "settings.saveFailed": "Failed to save",

    "onboarding.getStarted": "Get Started",
    "onboarding.stepOf": "Step {step} of 4",
    "onboarding.nameCompany": "Name your company",
    "onboarding.nameCompanyDesc": "This is the organization your agents will work for.",
    "onboarding.companyName": "Company name",
    "onboarding.missionOptional": "Mission / goal (optional)",
    "onboarding.missionPlaceholder": "What is this company trying to achieve?",
    "onboarding.createFirstAgent": "Create your first agent",
    "onboarding.createFirstAgentDesc": "Choose how this agent will run tasks.",
    "onboarding.giveTask": "Give it something to do",
    "onboarding.giveTaskDesc": "Give your agent a small task to start with — a bug fix, a research question, writing a script.",
    "onboarding.taskTitle": "Task title",
    "onboarding.taskDescriptionOptional": "Description (optional)",
    "onboarding.ready": "Ready to launch",
    "onboarding.readyDesc": "Everything is set up. Your assigned task already woke the agent, so you can jump straight to the issue.",
    "onboarding.company": "Company",
    "onboarding.task": "Task",
    "onboarding.back": "Back",
    "onboarding.next": "Next",
    "onboarding.creating": "Creating...",
    "onboarding.openIssue": "Open Issue",
    "onboarding.opening": "Opening...",

    "inbox.breadcrumb": "Inbox",
    "inbox.tabNew": "New",
    "inbox.tabAll": "All",
    "inbox.allCategories": "All categories",
    "inbox.myRecentIssues": "My recent issues",
    "inbox.joinRequests": "Join requests",
    "inbox.approvals": "Approvals",
    "inbox.failedRuns": "Failed runs",
    "inbox.alerts": "Alerts",
    "inbox.staleWork": "Stale work",
    "inbox.emptyNew": "No issues you're involved in yet.",
    "inbox.emptyFiltered": "No inbox items match these filters.",
    "inbox.approvalsNeedAction": "Approvals Needing Action",

    "dashboard.breadcrumb": "Dashboard",
    "dashboard.welcome": "Welcome to Paperclip. Set up your first company and agent to get started.",
    "dashboard.getStarted": "Get Started",
    "dashboard.selectCompany": "Create or select a company to view the dashboard.",

    "activity.breadcrumb": "Activity",
    "activity.selectCompany": "Select a company to view activity.",
    "activity.empty": "No activity yet.",
    "activity.filterPlaceholder": "Filter by type",
    "activity.allTypes": "All types",

    "costs.breadcrumb": "Costs",
    "costs.selectCompany": "Select a company to view costs.",

    "org.breadcrumb": "Org Chart",
    "org.selectCompany": "Select a company to view the org chart.",
    "org.empty": "No organizational hierarchy defined.",
  },
  ko: {
    "layout.skipToMain": "메인 콘텐츠로 건너뛰기",
    "layout.documentation": "문서",
    "layout.switchTheme": "{theme} 모드로 전환",
    "layout.switchLanguage": "영어로 전환",
    "theme.light": "라이트",
    "theme.dark": "다크",

    "sidebar.selectCompany": "회사 선택",
    "sidebar.newIssue": "새 이슈",
    "sidebar.dashboard": "대시보드",
    "sidebar.inbox": "받은함",
    "sidebar.work": "작업",
    "sidebar.issues": "이슈",
    "sidebar.goals": "목표",
    "sidebar.company": "회사",
    "sidebar.org": "조직",
    "sidebar.costs": "비용",
    "sidebar.activity": "활동",
    "sidebar.settings": "설정",

    "issues.breadcrumb": "이슈",
    "issues.selectCompany": "이슈를 보려면 회사를 선택하세요.",
    "goals.breadcrumb": "목표",
    "goals.selectCompany": "목표를 보려면 회사를 선택하세요.",
    "goals.empty": "아직 목표가 없습니다.",
    "goals.add": "목표 추가",
    "goals.new": "새 목표",

    "settings.company": "회사",
    "settings.breadcrumb": "설정",
    "settings.title": "회사 설정",
    "settings.general": "일반",
    "settings.companyName": "회사 이름",
    "settings.companyNameHint": "회사 표시 이름입니다.",
    "settings.description": "설명",
    "settings.descriptionHint": "회사 프로필에 표시되는 선택 설명입니다.",
    "settings.descriptionPlaceholder": "회사 설명(선택)",
    "settings.appearance": "외형",
    "settings.brandColor": "브랜드 색상",
    "settings.brandColorHint": "회사 아이콘 색조를 설정합니다. 비워두면 자동 생성 색상을 사용합니다.",
    "settings.clear": "지우기",
    "settings.saveChanges": "변경사항 저장",
    "settings.saving": "저장 중...",
    "settings.saved": "저장됨",
    "settings.saveFailed": "저장 실패",

    "onboarding.getStarted": "시작하기",
    "onboarding.stepOf": "총 4단계 중 {step}단계",
    "onboarding.nameCompany": "회사 이름 정하기",
    "onboarding.nameCompanyDesc": "에이전트가 일할 조직 이름입니다.",
    "onboarding.companyName": "회사 이름",
    "onboarding.missionOptional": "미션 / 목표 (선택)",
    "onboarding.missionPlaceholder": "이 회사가 이루려는 목표는 무엇인가요?",
    "onboarding.createFirstAgent": "첫 에이전트 만들기",
    "onboarding.createFirstAgentDesc": "이 에이전트가 작업을 수행할 방식을 선택하세요.",
    "onboarding.giveTask": "할 일을 부여하세요",
    "onboarding.giveTaskDesc": "버그 수정, 리서치, 스크립트 작성처럼 작은 작업부터 시작해보세요.",
    "onboarding.taskTitle": "작업 제목",
    "onboarding.taskDescriptionOptional": "설명 (선택)",
    "onboarding.ready": "출시 준비 완료",
    "onboarding.readyDesc": "모든 설정이 끝났습니다. 할당된 작업이 이미 에이전트를 깨웠으니 바로 이슈로 이동할 수 있습니다.",
    "onboarding.company": "회사",
    "onboarding.task": "작업",
    "onboarding.back": "뒤로",
    "onboarding.next": "다음",
    "onboarding.creating": "생성 중...",
    "onboarding.openIssue": "이슈 열기",
    "onboarding.opening": "여는 중...",

    "inbox.breadcrumb": "받은함",
    "inbox.tabNew": "새 항목",
    "inbox.tabAll": "전체",
    "inbox.allCategories": "모든 카테고리",
    "inbox.myRecentIssues": "내 최근 이슈",
    "inbox.joinRequests": "참여 요청",
    "inbox.approvals": "승인",
    "inbox.failedRuns": "실패 실행",
    "inbox.alerts": "알림",
    "inbox.staleWork": "정체 작업",
    "inbox.emptyNew": "아직 내가 관여한 이슈가 없습니다.",
    "inbox.emptyFiltered": "필터에 맞는 받은함 항목이 없습니다.",
    "inbox.approvalsNeedAction": "조치 필요한 승인",

    "dashboard.breadcrumb": "대시보드",
    "dashboard.welcome": "Paperclip에 오신 것을 환영합니다. 시작하려면 첫 회사와 에이전트를 설정하세요.",
    "dashboard.getStarted": "시작하기",
    "dashboard.selectCompany": "대시보드를 보려면 회사를 생성하거나 선택하세요.",

    "activity.breadcrumb": "활동",
    "activity.selectCompany": "활동을 보려면 회사를 선택하세요.",
    "activity.empty": "아직 활동이 없습니다.",
    "activity.filterPlaceholder": "유형으로 필터",
    "activity.allTypes": "모든 유형",

    "costs.breadcrumb": "비용",
    "costs.selectCompany": "비용을 보려면 회사를 선택하세요.",

    "org.breadcrumb": "조직도",
    "org.selectCompany": "조직도를 보려면 회사를 선택하세요.",
    "org.empty": "정의된 조직 계층이 없습니다.",
  },
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function isLocale(value: string | null): value is Locale {
  return value === "en" || value === "ko";
}

function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Ignore local storage read failures in restricted environments.
  }

  const browserLocale = navigator.language.toLowerCase();
  if (browserLocale.startsWith("ko")) return "ko";
  return "en";
}

function formatMessage(locale: Locale, key: string, vars?: Record<string, string>): string {
  let value = messages[locale][key] ?? messages.en[key] ?? key;
  if (!vars) return value;
  for (const [varKey, varValue] of Object.entries(vars)) {
    value = value.replaceAll(`{${varKey}}`, varValue);
  }
  return value;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => resolveInitialLocale());

  const setLocale = useCallback((nextLocale: Locale) => {
    setLocaleState(nextLocale);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((current) => (current === "en" ? "ko" : "en"));
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>) => {
      return formatMessage(locale, key, vars);
    },
    [locale],
  );

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [locale]);

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      toggleLocale,
      t,
    }),
    [locale, setLocale, toggleLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}

