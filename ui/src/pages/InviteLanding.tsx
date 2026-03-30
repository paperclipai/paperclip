import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import type { AgentAdapterType, JoinRequest } from "@paperclipai/shared";

type JoinType = "human" | "agent";
const joinAdapterOptions: AgentAdapterType[] = [...AGENT_ADAPTER_TYPES];

const adapterLabels: Record<string, string> = {
  claude_local: "Claude (local)",
  codex_local: "Codex (local)",
  gemini_local: "Gemini CLI (local)",
  opencode_local: "OpenCode (local)",
  openclaw_gateway: "OpenClaw Gateway",
  cursor: "Cursor (local)",
  process: "Process",
  http: "HTTP",
};

const ENABLED_INVITE_ADAPTERS = new Set(["claude_local", "codex_local", "gemini_local", "opencode_local", "cursor"]);

function dateTime(value: string) {
  return new Date(value).toLocaleString();
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

export function InviteLandingPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [joinType, setJoinType] = useState<JoinType>("human");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<AgentAdapterType>("claude_local");
  const [capabilities, setCapabilities] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const invite = inviteQuery.data;
  const allowedJoinTypes = invite?.allowedJoinTypes ?? "both";
  const availableJoinTypes = useMemo(() => {
    if (invite?.inviteType === "bootstrap_ceo") return ["human"] as JoinType[];
    if (allowedJoinTypes === "both") return ["human", "agent"] as JoinType[];
    return [allowedJoinTypes] as JoinType[];
  }, [invite?.inviteType, allowedJoinTypes]);

  useEffect(() => {
    if (!availableJoinTypes.includes(joinType)) {
      setJoinType(availableJoinTypes[0] ?? "human");
    }
  }, [availableJoinTypes, joinType]);

  const requiresAuthForHuman =
    joinType === "human" &&
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (invite.inviteType === "bootstrap_ceo") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      if (joinType === "human") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      const asBootstrap =
        payload && typeof payload === "object" && "bootstrapAccepted" in (payload as Record<string, unknown>);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "초대 수락 실패");
    },
  });

  if (!token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">유효하지 않은 초대 토큰입니다.</div>;
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">초대 로드 중...</div>;
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">사용할 수 없는 초대</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            이 초대는 만료, 취소 또는 이미 사용되었을 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">부트스트랩 완료</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            첫 인스턴스 관리자가 구성되었습니다. 보드로 계속 진행할 수 있습니다.
          </p>
          <Button asChild className="mt-4">
            <Link to="/">보드 열기</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
      diagnostics?: Array<{
        code: string;
        level: "info" | "warn";
        message: string;
        hint?: string;
      }>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingSkillUrl = readNestedString(payload.onboarding, ["skill", "url"]);
    const onboardingSkillPath = readNestedString(payload.onboarding, ["skill", "path"]);
    const onboardingInstallPath = readNestedString(payload.onboarding, ["skill", "installPath"]);
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const onboardingTextPath = readNestedString(payload.onboarding, ["textInstructions", "path"]);
    const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">참여 요청 제출됨</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            요청이 관리자 승인 대기 중입니다. 승인될 때까지 액세스할 수 없습니다.
          </p>
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            요청 ID: <span className="font-mono">{payload.id}</span>
          </div>
          {claimSecret && claimApiKeyPath && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">일회용 청구 비밀 (지금 저장)</p>
              <p className="font-mono break-all">{claimSecret}</p>
              <p className="font-mono break-all">POST {claimApiKeyPath}</p>
            </div>
          )}
          {(onboardingSkillUrl || onboardingSkillPath || onboardingInstallPath) && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Paperclip 스킬 부트스트랩</p>
              {onboardingSkillUrl && <p className="font-mono break-all">GET {onboardingSkillUrl}</p>}
              {!onboardingSkillUrl && onboardingSkillPath && <p className="font-mono break-all">GET {onboardingSkillPath}</p>}
              {onboardingInstallPath && <p className="font-mono break-all">설치 대상: {onboardingInstallPath}</p>}
            </div>
          )}
          {(onboardingTextUrl || onboardingTextPath) && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">에이전트 판독 온보딩 텍스트</p>
              {onboardingTextUrl && <p className="font-mono break-all">GET {onboardingTextUrl}</p>}
              {!onboardingTextUrl && onboardingTextPath && <p className="font-mono break-all">GET {onboardingTextPath}</p>}
            </div>
          )}
          {diagnostics.length > 0 && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">연결성 진단</p>
              {diagnostics.map((diag, idx) => (
                <div key={`${diag.code}:${idx}`} className="space-y-0.5">
                  <p className={diag.level === "warn" ? "text-amber-600 dark:text-amber-400" : undefined}>
                    [{diag.level}] {diag.message}
                  </p>
                  {diag.hint && <p className="font-mono break-all">{diag.hint}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {invite.inviteType === "bootstrap_ceo" ? "Paperclip 인스턴스 부트스트랩" : "이 Paperclip 회사에 참여"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Invite expires {dateTime(invite.expiresAt)}.</p>

        {invite.inviteType !== "bootstrap_ceo" && (
          <div className="mt-5 flex gap-2">
            {availableJoinTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setJoinType(type)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  joinType === type
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground"
                }`}
              >
                Join as {type}
              </button>
            ))}
          </div>
        )}

        {joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">에이전트 이름</span>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">어댑터 유형</span>
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={adapterType}
                onChange={(event) => setAdapterType(event.target.value as AgentAdapterType)}
              >
                {joinAdapterOptions.map((type) => (
                  <option key={type} value={type} disabled={!ENABLED_INVITE_ADAPTERS.has(type)}>
                    {adapterLabels[type]}{!ENABLED_INVITE_ADAPTERS.has(type) ? " (곧 출시 예정)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">기능 (선택사항)</span>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                rows={4}
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
              />
            </label>
          </div>
        )}

        {requiresAuthForHuman && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
            참여 요청을 제출하기 전에 로그인하거나 계정을 만드세요.
            <div className="mt-2">
              <Button asChild size="sm" variant="outline">
                <Link to={`/auth?next=${encodeURIComponent(`/invite/${token}`)}`}>로그인 / 계정 만들기</Link>
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <Button
          className="mt-5"
          disabled={
            acceptMutation.isPending ||
            (joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && agentName.trim().length === 0) ||
            requiresAuthForHuman
          }
          onClick={() => acceptMutation.mutate()}
        >
          {acceptMutation.isPending
            ? "제출 중…"
            : invite.inviteType === "bootstrap_ceo"
              ? "부트스트랩 초대 수락"
              : "참여 요청 제출"}
        </Button>
      </div>
    </div>
  );
}
