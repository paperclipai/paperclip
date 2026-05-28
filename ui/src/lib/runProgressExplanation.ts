type RunProgressInput = {
  status: string;
  livenessState?: string | null;
  livenessReason?: string | null;
  error?: string | null;
};

export type RunProgressExplanation = {
  label: string;
  description: string;
  tone: "neutral" | "active" | "success" | "warning" | "danger";
};

function isKoreanLocale(locale?: string | null) {
  return locale?.toLowerCase().startsWith("ko") === true;
}

function shortReason(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}...` : trimmed;
}

function text(locale: string | null | undefined, english: string, korean: string) {
  return isKoreanLocale(locale) ? korean : english;
}

export function describeRunProgress(
  run: RunProgressInput,
  locale?: string | null,
): RunProgressExplanation {
  const status = run.status;
  const livenessState = run.livenessState ?? null;
  const reason = shortReason(run.livenessReason) ?? shortReason(run.error);

  if (status === "queued") {
    return {
      label: text(locale, "Queued", "실행 대기"),
      description: text(
        locale,
        "The run is waiting for a worker slot and has not started yet.",
        "직원 실행 슬롯을 기다리는 중이며 아직 시작되지 않았습니다.",
      ),
      tone: "neutral",
    };
  }

  if (status === "running") {
    return {
      label: text(locale, "Running", "실행 중"),
      description: text(
        locale,
        "The worker is acting now. Watch live output, silence warnings, or the final liveness result.",
        "직원이 현재 작업 중입니다. 실시간 출력, 무응답 경고, 최종 진행 판정을 확인하세요.",
      ),
      tone: "active",
    };
  }

  if (status === "scheduled_retry") {
    return {
      label: text(locale, "Retry queued", "재시도 대기"),
      description: text(
        locale,
        "Paperclip queued another attempt, so the previous run is not the final outcome yet.",
        "Paperclip이 다음 시도를 예약했으므로 이전 실행은 아직 최종 결과가 아닙니다.",
      ),
      tone: "active",
    };
  }

  if (livenessState === "blocked") {
    return {
      label: text(locale, "Blocked", "막힘"),
      description: reason ?? text(
        locale,
        "The run found a blocker. Check the named owner, approval, or dependency before continuing.",
        "실행이 차단 조건을 발견했습니다. 계속하기 전에 담당자, 승인, 의존 작업을 확인하세요.",
      ),
      tone: "warning",
    };
  }

  if (status === "failed" || livenessState === "failed") {
    return {
      label: text(locale, "Failed", "실패"),
      description: reason ?? text(
        locale,
        "The run ended unsuccessfully. Open logs or retry details to find the failure cause.",
        "실행이 실패했습니다. 로그나 재시도 정보를 열어 실패 원인을 확인하세요.",
      ),
      tone: "danger",
    };
  }

  if (status === "cancelled") {
    return {
      label: text(locale, "Cancelled", "취소됨"),
      description: reason ?? text(
        locale,
        "The run was stopped before completion.",
        "실행이 완료 전에 중단되었습니다.",
      ),
      tone: "neutral",
    };
  }

  if (livenessState === "plan_only" || livenessState === "empty_response" || livenessState === "needs_followup") {
    return {
      label: text(locale, "Needs follow-up", "후속 확인 필요"),
      description: reason ?? text(
        locale,
        "The run produced output, but Paperclip did not see enough concrete progress evidence.",
        "출력은 있었지만 Paperclip이 충분한 실제 진행 근거를 확인하지 못했습니다.",
      ),
      tone: "warning",
    };
  }

  if (status === "succeeded" || livenessState === "completed" || livenessState === "advanced") {
    return {
      label: text(locale, "Completed", "완료"),
      description: reason ?? text(
        locale,
        "The run finished and produced progress evidence.",
        "실행이 끝났고 진행 근거가 남았습니다.",
      ),
      tone: "success",
    };
  }

  return {
    label: status.replace(/_/g, " "),
    description: reason ?? text(
      locale,
      "Open the run details for the latest logs and liveness result.",
      "최근 로그와 진행 판정은 실행 상세에서 확인하세요.",
    ),
    tone: "neutral",
  };
}

