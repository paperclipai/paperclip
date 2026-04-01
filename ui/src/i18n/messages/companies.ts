import type { ActiveLocale, MessageTree } from "../types";

export const companiesMessages: Record<ActiveLocale, MessageTree> = {
  en: {
    companies: {
      title: "Companies",
      newCompany: "New Company",
      loading: "Loading companies...",
      rename: "Rename",
      deleteCompany: "Delete Company",
      agentCount: "{{count}} agent{{suffix}}",
      issueCount: "{{count}} issue{{suffix}}",
      unlimitedBudget: "Unlimited budget",
      created: "Created {{value}}",
      deleteConfirm: "Delete this company and all its data? This cannot be undone.",
      deleting: "Deleting…",
      delete: "Delete",
    },
  },
  ko: {
    companies: {
      title: "회사",
      newCompany: "새 회사",
      loading: "회사를 불러오는 중...",
      rename: "이름 변경",
      deleteCompany: "회사 삭제",
      agentCount: "에이전트 {{count}}명",
      issueCount: "이슈 {{count}}개",
      unlimitedBudget: "예산 제한 없음",
      created: "{{value}} 생성",
      deleteConfirm: "이 회사와 모든 데이터를 삭제하시겠습니까? 되돌릴 수 없습니다.",
      deleting: "삭제 중…",
      delete: "삭제",
    },
  },
  ja: {
    companies: {
      title: "会社",
      newCompany: "新しい会社",
      loading: "会社を読み込み中...",
      rename: "名前変更",
      deleteCompany: "会社を削除",
      agentCount: "エージェント {{count}} 件",
      issueCount: "Issue {{count}} 件",
      unlimitedBudget: "予算上限なし",
      created: "{{value}} に作成",
      deleteConfirm: "この会社と関連データをすべて削除しますか？元に戻せません。",
      deleting: "削除中…",
      delete: "削除",
    },
  },
};
