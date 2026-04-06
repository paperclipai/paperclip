import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Zap,
  Pause,
  Play,
  AlertTriangle,
  XOctagon,
  MessageSquareWarning,
  ShieldAlert,
  Settings2,
} from "lucide-react";
import { runsApi, type MaximizerConfig } from "@/api/runs";

// ─── Types ──────────────────────────────────────────────────────────────

interface MaximizerAgent {
  id: string;
  name: string;
  status: string;
  maximizerEnabled: boolean;
  maximizerMaxConsecutiveFailures: number;
  maximizerMaxRunsWithoutProgress: number;
  maximizerTokenVelocityLimit: number | null;
  maximizerAutoApprove: boolean;
}

interface ActiveRun {
  id: string;
  status: string;
  pausedAt: string | null;
  interruptedAt: string | null;
  interruptMessage: string | null;
  interruptMode: string | null;
  circuitBreakerTripped: boolean;
  circuitBreakerReason: string | null;
}

interface MaximizerModePanelProps {
  companyId: string;
  agent: MaximizerAgent;
  activeRun: ActiveRun | null;
  onUpdated?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────

export function MaximizerModePanel({
  companyId,
  agent,
  activeRun,
  onUpdated,
}: MaximizerModePanelProps) {
  const queryClient = useQueryClient();

  // Local config state (mirrors agent values)
  const [enabled, setEnabled] = useState(agent.maximizerEnabled);
  const [maxFailures, setMaxFailures] = useState(String(agent.maximizerMaxConsecutiveFailures));
  const [maxNoProgress, setMaxNoProgress] = useState(String(agent.maximizerMaxRunsWithoutProgress));
  const [tokenLimit, setTokenLimit] = useState(
    agent.maximizerTokenVelocityLimit != null ? String(agent.maximizerTokenVelocityLimit) : "",
  );
  const [autoApprove, setAutoApprove] = useState(agent.maximizerAutoApprove);

  // Interrupt form state
  const [interruptMessage, setInterruptMessage] = useState("");
  const [interruptMode, setInterruptMode] = useState<"hint" | "correction" | "hard_override">("hint");

  // Mutation error/success feedback
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  function showFeedback(type: "success" | "error", text: string) {
    setFeedback({ type, text });
    setTimeout(clearFeedback, 4000);
  }

  // ─── Mutations ──────────────────────────────────────────────────────

  const configMutation = useMutation({
    mutationFn: () =>
      runsApi.updateMaximizer(companyId, agent.id, {
        enabled,
        maxConsecutiveFailures: Number(maxFailures) || 3,
        maxRunsWithoutProgress: Number(maxNoProgress) || 5,
        tokenVelocityLimit: tokenLimit ? Number(tokenLimit) : null,
        autoApprove,
      }),
    onSuccess: () => {
      showFeedback("success", "Maximizer configuration saved");
      onUpdated?.();
    },
    onError: (err: Error) => {
      showFeedback("error", err.message);
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () => runsApi.pause(companyId, activeRun!.id),
    onSuccess: () => {
      showFeedback("success", "Run paused");
      onUpdated?.();
    },
    onError: (err: Error) => showFeedback("error", err.message),
  });

  const resumeMutation = useMutation({
    mutationFn: () => runsApi.resume(companyId, activeRun!.id),
    onSuccess: () => {
      showFeedback("success", "Run resumed");
      onUpdated?.();
    },
    onError: (err: Error) => showFeedback("error", err.message),
  });

  const interruptMutation = useMutation({
    mutationFn: () =>
      runsApi.interrupt(companyId, activeRun!.id, {
        message: interruptMessage,
        mode: interruptMode,
      }),
    onSuccess: () => {
      showFeedback("success", "Interrupt delivered");
      setInterruptMessage("");
      onUpdated?.();
    },
    onError: (err: Error) => showFeedback("error", err.message),
  });

  const abortMutation = useMutation({
    mutationFn: () => runsApi.abort(companyId, activeRun!.id, "Manual abort from Maximizer panel"),
    onSuccess: () => {
      showFeedback("success", "Run aborted");
      onUpdated?.();
    },
    onError: (err: Error) => showFeedback("error", err.message),
  });

  const anyRunMutating =
    pauseMutation.isPending ||
    resumeMutation.isPending ||
    interruptMutation.isPending ||
    abortMutation.isPending;

  const isRunActive = activeRun && !["completed", "failed", "aborted"].includes(activeRun.status);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <Card className="border-orange-500/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-orange-500" />
          <CardTitle className="text-lg">MAXIMIZER MODE</CardTitle>
          {enabled && (
            <Badge variant="outline" className="ml-auto border-orange-500 text-orange-500 text-xs">
              ACTIVE
            </Badge>
          )}
          {!enabled && (
            <Badge variant="outline" className="ml-auto text-muted-foreground text-xs">
              OFF
            </Badge>
          )}
        </div>
        <CardDescription>
          Autonomous aggressive execution -- agent auto-continues without manual intervention until
          completion or failure.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Feedback ──────────────────────────────────────────── */}
        {feedback && (
          <div
            className={`rounded-md px-3 py-2 text-sm ${
              feedback.type === "success"
                ? "bg-[var(--status-active)]/10 text-[var(--status-active)] border border-[var(--status-active)]/20"
                : "bg-[var(--status-error)]/10 text-[var(--status-error)] border border-[var(--status-error)]/20"
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* ── Enable toggle ────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <Checkbox
            id="maximizer-toggle"
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <Label htmlFor="maximizer-toggle" className="font-medium cursor-pointer">
            Enable MAXIMIZER MODE for {agent.name}
          </Label>
        </div>

        {/* ── Configuration ────────────────────────────────────── */}
        <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
          <div className="flex items-center gap-2 mb-3">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Safety Guardrails</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="max-failures" className="text-xs text-muted-foreground">
                Max Consecutive Failures
              </Label>
              <Input
                id="max-failures"
                type="number"
                min={1}
                max={100}
                value={maxFailures}
                onChange={(e) => setMaxFailures(e.target.value)}
                className="h-8"
              />
              <p className="text-xs text-muted-foreground">
                Circuit breaker trips after this many consecutive failures
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="max-no-progress" className="text-xs text-muted-foreground">
                Max Runs Without Progress
              </Label>
              <Input
                id="max-no-progress"
                type="number"
                min={1}
                max={100}
                value={maxNoProgress}
                onChange={(e) => setMaxNoProgress(e.target.value)}
                className="h-8"
              />
              <p className="text-xs text-muted-foreground">
                Stops if agent spins without measurable progress
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="token-limit" className="text-xs text-muted-foreground">
                Token Velocity Limit (per run)
              </Label>
              <Input
                id="token-limit"
                type="number"
                min={0}
                placeholder="Unlimited"
                value={tokenLimit}
                onChange={(e) => setTokenLimit(e.target.value)}
                className="h-8"
              />
              <p className="text-xs text-muted-foreground">
                Max tokens consumed per run cycle; blank = unlimited
              </p>
            </div>

            <div className="flex items-center gap-3 self-center pt-4">
              <Checkbox
                id="auto-approve"
                checked={autoApprove}
                onCheckedChange={(checked) => setAutoApprove(checked === true)}
              />
              <Label htmlFor="auto-approve" className="text-xs cursor-pointer">
                Auto-approve tool calls (dangerous)
              </Label>
            </div>
          </div>

          <div className="mt-4">
            <Button
              size="sm"
              onClick={() => configMutation.mutate()}
              disabled={configMutation.isPending}
            >
              {configMutation.isPending ? "Saving..." : "Save Configuration"}
            </Button>
          </div>
        </div>

        <Separator />

        {/* ── Circuit Breaker Status ───────────────────────────── */}
        {activeRun?.circuitBreakerTripped && (
          <div className="rounded-[2px] border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 p-3 space-y-1">
            <div className="flex items-center gap-2 text-[var(--status-error)]">
              <ShieldAlert className="h-4 w-4" />
              <span className="text-sm font-[var(--font-display)] uppercase tracking-[0.06em]">Circuit Breaker TRIPPED</span>
            </div>
            {activeRun.circuitBreakerReason && (
              <p className="text-xs text-[var(--status-error)]">{activeRun.circuitBreakerReason}</p>
            )}
          </div>
        )}

        {activeRun?.interruptedAt && (
          <div className="rounded-[2px] border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 p-3 space-y-1">
            <div className="flex items-center gap-2 text-[var(--status-warning)]">
              <MessageSquareWarning className="h-4 w-4" />
              <span className="text-sm font-semibold">
                Interrupted ({activeRun.interruptMode})
              </span>
            </div>
            {activeRun.interruptMessage && (
              <p className="text-xs text-[var(--status-warning)]">{activeRun.interruptMessage}</p>
            )}
          </div>
        )}

        {/* ── Run Controls ─────────────────────────────────────── */}
        {isRunActive && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">Run Controls</span>
              <Badge variant="outline" className="text-xs">
                {activeRun.status}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-2">
              {activeRun.status === "running" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => pauseMutation.mutate()}
                  disabled={anyRunMutating}
                >
                  <Pause className="h-3.5 w-3.5 mr-1" />
                  Pause
                </Button>
              )}

              {activeRun.status === "paused" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => resumeMutation.mutate()}
                  disabled={anyRunMutating}
                >
                  <Play className="h-3.5 w-3.5 mr-1" />
                  Resume
                </Button>
              )}

              <Button
                variant="destructive"
                size="sm"
                onClick={() => abortMutation.mutate()}
                disabled={anyRunMutating}
              >
                <XOctagon className="h-3.5 w-3.5 mr-1" />
                Abort
              </Button>
            </div>

            {/* ── Interrupt Form ────────────────────────────────── */}
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-[var(--status-warning)]" />
                <span className="text-sm font-medium">Send Interrupt</span>
              </div>

              <div className="space-y-2">
                <Label htmlFor="interrupt-msg" className="text-xs text-muted-foreground">
                  Message
                </Label>
                <Input
                  id="interrupt-msg"
                  placeholder="e.g. Focus on the auth module first"
                  value={interruptMessage}
                  onChange={(e) => setInterruptMessage(e.target.value)}
                  className="h-8"
                />
              </div>

              <div className="flex gap-2">
                {(["hint", "correction", "hard_override"] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant={interruptMode === mode ? "default" : "outline"}
                    size="sm"
                    className="text-xs"
                    onClick={() => setInterruptMode(mode)}
                  >
                    {mode === "hint" && "Hint"}
                    {mode === "correction" && "Correction"}
                    {mode === "hard_override" && "Hard Override"}
                  </Button>
                ))}
              </div>

              <Button
                size="sm"
                variant="outline"
                onClick={() => interruptMutation.mutate()}
                disabled={anyRunMutating || !interruptMessage.trim()}
              >
                <MessageSquareWarning className="h-3.5 w-3.5 mr-1" />
                {interruptMutation.isPending ? "Sending..." : "Send Interrupt"}
              </Button>
            </div>
          </div>
        )}

        {!isRunActive && (
          <p className="text-xs text-muted-foreground">
            No active run. Controls will appear when an agent run is in progress.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
