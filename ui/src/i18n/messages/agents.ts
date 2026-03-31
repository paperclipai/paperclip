import type { ActiveLocale, MessageTree } from "../types";

export const agentsMessages: Record<ActiveLocale, MessageTree> = {
  en: {
    agents: {
      title: "Agents",
      selectCompany: "Select a company to view agents.",
      tabs: {
        all: "All",
        active: "Active",
        paused: "Paused",
        error: "Error",
      },
      filters: "Filters",
      showTerminated: "Show terminated",
      newAgent: "New Agent",
      count: "{{count}} agent{{suffix}}",
      empty: "Create your first agent to get started.",
    },
  },
  ko: {
    agents: {
      title: "에이전트",
      selectCompany: "에이전트를 보려면 회사를 선택하세요.",
      tabs: {
        all: "전체",
        active: "활성",
        paused: "일시중지",
        error: "오류",
      },
      filters: "필터",
      showTerminated: "종료된 에이전트 표시",
      newAgent: "새 에이전트",
      count: "에이전트 {{count}}명",
      empty: "첫 에이전트를 만들어 시작하세요.",
    },
  },
  ja: {
    agents: {
      title: "エージェント",
      selectCompany: "エージェントを見るには会社を選択してください。",
      tabs: {
        all: "すべて",
        active: "有効",
        paused: "停止",
        error: "エラー",
      },
      filters: "フィルター",
      showTerminated: "終了済みを表示",
      newAgent: "新しいエージェント",
      count: "エージェント {{count}} 件",
      empty: "最初のエージェントを作成して始めましょう。",
    },
  },
};
