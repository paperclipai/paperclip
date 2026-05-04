import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { authApi } from "@/api/auth";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "로그아웃하지 못했습니다.");
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "RealTycoon2 설정" },
      { label: "일반" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "일반 설정을 저장하지 못했습니다.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">일반 설정을 불러오는 중입니다...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "일반 설정을 불러오지 못했습니다."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">일반 설정</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          로그 표시, 단축키, 백업 보관, 데이터 공유 등 RealTycoon2 전체 환경을 설정합니다.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">배포와 인증</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? "로컬 신뢰 모드는 로컬 운영자 환경에 맞춰져 있습니다. 브라우저 요청은 로컬 업무 보드 권한으로 실행되며 로그인이 필요 없습니다."
              : healthQuery.data?.deploymentExposure === "public"
                ? "인증된 공개 모드는 업무 보드 접근에 로그인이 필요하며 공개 URL 운영에 사용합니다."
                : "인증된 비공개 모드는 로그인이 필요하며 LAN, VPN 등 사설 네트워크 배포에 사용합니다."}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label="인증 준비"
              value={healthQuery.data?.authReady ? "준비됨" : "미완료"}
            />
            <StatusBox
              label="초기 설정"
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "설정 필요" : "준비됨"}
            />
            <StatusBox
              label="초대 상태"
              value={healthQuery.data?.bootstrapInviteActive ? "활성" : "없음"}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">로그의 사용자 이름 숨기기</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              홈 디렉터리 경로 등 운영자에게 보이는 로그에서 사용자 이름 구간을 숨깁니다. 경로 밖의 단독 사용자 이름은 아직 실시간 transcript에서 마스킹되지 않습니다. 기본값은 꺼짐입니다.
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending}
            aria-label="로그 사용자 이름 숨김 전환"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">키보드 단축키</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              받은함 이동, 업무 추가, 패널 전환 같은 RealTycoon2 단축키를 켭니다. 기본값은 꺼짐입니다.
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending}
            aria-label="키보드 단축키 전환"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">백업 보관</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              자동 데이터베이스 백업을 얼마나 오래 보관할지 설정합니다. 백업은 대략 매시간 실행되고 gzip으로 압축됩니다. 일 단위 기간에는 모든 백업을 보관하고, 이후에는 주/월 단위 대표 백업을 보존합니다.
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">일 단위</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{days}일</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">주 단위</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = `${weeks}주`;
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">월 단위</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = `${months}개월`;
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">AI 피드백 공유</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              좋아요/싫어요 피드백의 AI 출력을 RealTycoon2 Labs로 보낼 수 있는지 설정합니다. 피드백 기록은 항상 로컬에 저장됩니다.
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                이용 약관 보기
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg border border-border/70 bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              아직 기본값이 없습니다. 다음 좋아요/싫어요 선택 시 한 번 확인하고 이곳에 저장합니다.
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: "항상 허용",
                description: "피드백한 AI 출력을 자동으로 공유합니다.",
              },
              {
                value: "not_allowed",
                label: "허용하지 않음",
                description: "피드백한 AI 출력을 로컬에만 보관합니다.",
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            로컬 개발에서 첫 사용 확인을 다시 보려면{" "}
            <code>feedbackDataSharingPreference</code> key from the{" "}
            <code>instance_settings.general</code> JSON row에서 제거하거나{" "}
            <code>"prompt"</code>로 되돌리세요. 값이 없거나 <code>"prompt"</code>이면 아직 기본값을 정하지 않았다는 뜻입니다.
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">로그아웃</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              이 RealTycoon2 인스턴스에서 로그아웃합니다. 이후 로그인 화면으로 이동합니다.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? "로그아웃 중..." : "로그아웃"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-sm font-medium">{value}</div>
    </div>
  );
}
