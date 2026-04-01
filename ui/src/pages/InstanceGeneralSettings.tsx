import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { useI18n } from "../i18n";

export function InstanceGeneralSettings() {
  const { locale } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const copy = locale === "ko"
    ? {
        instanceSettings: "인스턴스 설정",
        general: "일반",
        updateFailed: "일반 설정을 업데이트하지 못했습니다.",
        loading: "일반 설정을 불러오는 중...",
        loadFailed: "일반 설정을 불러오지 못했습니다.",
        title: "일반",
        description: "운영자에게 보이는 로그 표시 방식에 영향을 주는 인스턴스 기본값을 설정합니다.",
        censorTitle: "로그에서 사용자명 가리기",
        censorDescription: "홈 디렉터리 경로와 비슷한 운영자용 로그 출력에서 사용자명 구간을 숨깁니다. 경로 밖의 독립적인 사용자명 표시는 라이브 트랜스크립트 뷰에서 아직 마스킹되지 않습니다. 기본값은 꺼짐입니다.",
        toggleAria: "로그 사용자명 가리기 전환",
      }
    : locale === "ja"
      ? {
          instanceSettings: "インスタンス設定",
          general: "一般",
          updateFailed: "一般設定を更新できませんでした。",
          loading: "一般設定を読み込み中...",
          loadFailed: "一般設定を読み込めませんでした。",
          title: "一般",
          description: "オペレーターに表示されるログの見え方に影響するインスタンス全体の既定値を設定します。",
          censorTitle: "ログ内のユーザー名を伏せる",
          censorDescription: "ホームディレクトリのパスなど、オペレーター向けログ出力に含まれるユーザー名部分を隠します。パス外に単独で現れるユーザー名は、ライブ transcript view ではまだ伏せられません。既定ではオフです。",
          toggleAria: "ログ内ユーザー名マスキングを切り替える",
        }
      : {
          instanceSettings: "Instance Settings",
          general: "General",
          updateFailed: "Failed to update general settings.",
          loading: "Loading general settings...",
          loadFailed: "Failed to load general settings.",
          title: "General",
          description: "Configure instance-wide defaults that affect how operator-visible logs are displayed.",
          censorTitle: "Censor username in logs",
          censorDescription: "Hide the username segment in home-directory paths and similar operator-visible log output. Standalone username mentions outside of paths are not yet masked in the live transcript view. This is off by default.",
          toggleAria: "Toggle username log censoring",
        };

  useEffect(() => {
    setBreadcrumbs([
      { label: copy.instanceSettings },
      { label: copy.general },
    ]);
  }, [copy.general, copy.instanceSettings, setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateGeneral({ censorUsernameInLogs: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : copy.updateFailed);
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{copy.loading}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : copy.loadFailed}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{copy.title}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {copy.description}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{copy.censorTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {copy.censorDescription}
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label={copy.toggleAria}
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate(!censorUsernameInLogs)}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>
    </div>
  );
}
