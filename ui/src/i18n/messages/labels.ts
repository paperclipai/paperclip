import type { ActiveLocale, MessageTree } from "../types";

export const labelsMessages: Record<ActiveLocale, MessageTree> = {
  en: {
    labels: {
      status: {
        active: "Active",
        running: "Running",
        paused: "Paused",
        idle: "Idle",
        archived: "Archived",
        planned: "Planned",
        achieved: "Achieved",
        completed: "Completed",
        failed: "Failed",
        timed_out: "Timed out",
        succeeded: "Succeeded",
        error: "Error",
        pending_approval: "Pending approval",
        backlog: "Backlog",
        todo: "Todo",
        in_progress: "In progress",
        in_review: "In review",
        blocked: "Blocked",
        done: "Done",
        terminated: "Terminated",
        cancelled: "Cancelled",
        pending: "Pending",
        revision_requested: "Revision requested",
        approved: "Approved",
        rejected: "Rejected"
      },
      priority: {
        critical: "Critical",
        high: "High",
        medium: "Medium",
        low: "Low"
      },
      invocation: {
        timer: "Timer",
        assignment: "Assignment",
        on_demand: "On demand",
        automation: "Automation"
      }
    }
  },
  ko: {
    labels: {
      status: {
        active: "활성",
        running: "실행 중",
        paused: "일시중지",
        idle: "대기",
        archived: "보관됨",
        planned: "예정",
        achieved: "달성됨",
        completed: "완료",
        failed: "실패",
        timed_out: "시간 초과",
        succeeded: "성공",
        error: "오류",
        pending_approval: "승인 대기",
        backlog: "백로그",
        todo: "할 일",
        in_progress: "진행 중",
        in_review: "검토 중",
        blocked: "차단됨",
        done: "완료됨",
        terminated: "종료됨",
        cancelled: "취소됨",
        pending: "대기 중",
        revision_requested: "수정 요청",
        approved: "승인됨",
        rejected: "거절됨"
      },
      priority: {
        critical: "치명",
        high: "높음",
        medium: "보통",
        low: "낮음"
      },
      invocation: {
        timer: "타이머",
        assignment: "할당",
        on_demand: "수동 실행",
        automation: "자동화"
      }
    }
  },
  ja: {
    labels: {
      status: {
        active: "アクティブ",
        running: "実行中",
        paused: "一時停止",
        idle: "待機中",
        archived: "アーカイブ済み",
        planned: "予定",
        achieved: "達成済み",
        completed: "完了",
        failed: "失敗",
        timed_out: "タイムアウト",
        succeeded: "成功",
        error: "エラー",
        pending_approval: "承認待ち",
        backlog: "バックログ",
        todo: "Todo",
        in_progress: "進行中",
        in_review: "レビュー中",
        blocked: "ブロック中",
        done: "完了済み",
        terminated: "終了済み",
        cancelled: "キャンセル済み",
        pending: "保留中",
        revision_requested: "修正依頼",
        approved: "承認済み",
        rejected: "却下"
      },
      priority: {
        critical: "重大",
        high: "高",
        medium: "中",
        low: "低"
      },
      invocation: {
        timer: "タイマー",
        assignment: "割り当て",
        on_demand: "オンデマンド",
        automation: "自動化"
      }
    }
  }
};
