import type { ActiveLocale, MessageTree } from "../types";

export const bootstrapMessages: Record<ActiveLocale, MessageTree> = {
  en: {
    bootstrap: {
      loading: "Loading…",
      failedAppState: "Failed to load app state",
      instanceSetupRequired: "Instance setup required",
      bootstrapInviteActive: "No instance admin exists yet. A bootstrap invite is already active. Check your Paperclip startup logs for the first admin invite URL, or run this command to rotate it:",
      bootstrapInviteMissing: "No instance admin exists yet. Run this command in your Paperclip environment to generate the first admin invite URL:",
      createAnotherCompany: "Create another company",
      createFirstCompany: "Create your first company",
      addAnotherAgent: "Add another agent to {{companyName}}",
      addAnotherAgentDescription: "Run onboarding again to add an agent and a starter task for this company.",
      createAnotherCompanyDescription: "Run onboarding again to create another company and seed its first agent.",
      createFirstCompanyDescription: "Get started by creating a company and your first agent.",
    },
  },
  ko: {
    bootstrap: {
      loading: "불러오는 중…",
      failedAppState: "앱 상태를 불러오지 못했습니다",
      instanceSetupRequired: "인스턴스 설정 필요",
      bootstrapInviteActive: "아직 인스턴스 관리자가 없습니다. bootstrap invite가 이미 활성화되어 있습니다. Paperclip 시작 로그에서 첫 관리자 invite URL을 확인하거나, 아래 명령으로 다시 발급하세요:",
      bootstrapInviteMissing: "아직 인스턴스 관리자가 없습니다. Paperclip 환경에서 아래 명령으로 첫 관리자 invite URL을 생성하세요:",
      createAnotherCompany: "다른 회사 만들기",
      createFirstCompany: "첫 회사 만들기",
      addAnotherAgent: "{{companyName}}에 에이전트 추가",
      addAnotherAgentDescription: "이 회사에 에이전트와 시작 작업을 추가하려면 onboarding을 다시 실행하세요.",
      createAnotherCompanyDescription: "다른 회사를 만들고 첫 에이전트를 시드하려면 onboarding을 다시 실행하세요.",
      createFirstCompanyDescription: "회사와 첫 에이전트를 만들어 시작하세요.",
    },
  },
  ja: {
    bootstrap: {
      loading: "読み込み中…",
      failedAppState: "アプリ状態の読み込みに失敗しました",
      instanceSetupRequired: "インスタンス設定が必要です",
      bootstrapInviteActive: "まだインスタンス管理者がいません。bootstrap invite はすでに有効です。Paperclip の起動ログで最初の管理者 invite URL を確認するか、次のコマンドで再発行してください:",
      bootstrapInviteMissing: "まだインスタンス管理者がいません。Paperclip 環境で次のコマンドを実行し、最初の管理者 invite URL を生成してください:",
      createAnotherCompany: "別の会社を作成",
      createFirstCompany: "最初の会社を作成",
      addAnotherAgent: "{{companyName}} にエージェントを追加",
      addAnotherAgentDescription: "この会社にエージェントとスタータータスクを追加するには onboarding を再実行してください。",
      createAnotherCompanyDescription: "別の会社を作成し最初のエージェントを作るには onboarding を再実行してください。",
      createFirstCompanyDescription: "会社と最初のエージェントを作成して始めましょう。",
    },
  },
};
