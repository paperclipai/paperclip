import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import type { ReactNode } from "react";
import { Clock, Pencil, ShieldCheck } from "lucide-react";
import type { ToolRiskLevel } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { CapabilityBadges, DecisionBadge, RiskBadge } from "@/pages/tools/shared";

/**
 * Action approval card (PAP-10787 / PAP-10778, surfaces 11/12/99).
 *
 * The card an agent's run posts into the issue thread when a governed tool
 * call needs human approval. Two hard requirements from the PAP-10400 security
 * hardening must never regress:
 *
 *  1. The **signed payload sha256 + expiry** are always surfaced, so a reviewer
 *     approves exactly the bytes that were signed and can see when the request
 *     lapses.
 *  2. The server-driven **stale** variant disables Approve and shows the
 *     catalog-hash mismatch (previous hash struck through next to current), so
 *     re-issuance is visibly required — an approval can never be granted
 *     against a catalog the orchestrator no longer trusts.
 */

export type ActionCardVariant = "pending" | "stale";

/** One key/value row in the {@link BindingsTable}. */
export interface BindingRow {
  label: string;
  value: ReactNode;
  /** Render the value in the mono catalog/hash treatment. */
  mono?: boolean;
}

/**
 * Two-column key/value block with mono values. Lives inside {@link ActionCard}
 * and is reused in the audit row drilldown, so it takes raw rows rather than a
 * baked-in binding shape. `labelWidth` narrows to 70px on mobile (surface 99).
 */
export function BindingsTable({
  rows,
  labelWidth = 132,
  className,
}: {
  rows: BindingRow[];
  labelWidth?: number;
  className?: string;
}) {
  useTranslation();
  return (
    <dl className={cn("divide-y divide-border rounded-md border border-border text-sm", className)}>
      {rows.map((row) => (
        <div key={row.label} className="flex gap-3 px-3 py-2">
          <dt
            className="shrink-0 pt-0.5 text-xs font-medium uppercase tracking-normal text-muted-foreground"
            style={{ width: labelWidth }}
          >
            {actionBindingLabel(row.label)}
          </dt>
          <dd className={cn("min-w-0 flex-1 break-all text-foreground", row.mono && "font-mono text-xs")}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function actionBindingLabel(label: string): string {
  const keys: Record<string, string> = {
    "Application": "localizationIssueAux.ui_Application_9mg0rp",
    "Connection": "localizationIssueAux.ui_Connection_2r1h4p",
    "Catalog": "localizationIssueAux.ui_Catalog_1a8eq48",
    "Payload": "localizationIssueAux.ui_Payload_18i2xc5",
  };
  return keys[label] ? t(keys[label]) : label;
}

/** Truncate a sha to the standard `sha256:abcd…1234` review form. */
export function shortSha(sha: string): string {
  const hex = sha.replace(/^sha256:/, "");
  if (hex.length <= 16) return `sha256:${hex}`;
  return `sha256:${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

export interface ActionCardBinding {
  /** Application the tool belongs to. */
  application: string;
  /** Manifest version the catalog was discovered at. */
  manifestVersion: string;
  /** Connection label (mono URL / command). */
  connection: string;
  /** Current catalog sha256 the gateway will enforce against. */
  catalogSha256: string;
  /** sha256 of the signed argument payload — never elided. */
  payloadSha256: string;
  /**
   * Previous catalog sha256, only present on the stale variant. Rendered struck
   * through next to {@link catalogSha256} so the mismatch is obvious.
   */
  previousCatalogSha256?: string;
}

export interface ActionCardProps {
  /** Requesting agent — defaults to "Coder" to match the spec copy. */
  agentName?: string;
  agentAvatarUrl?: string | null;
  /** Tool the agent is asking to call, e.g. `slack.post_message`. */
  toolName: string;
  risk: ToolRiskLevel;
  isReadOnly?: boolean;
  isWrite?: boolean;
  isDestructive?: boolean;
  binding: ActionCardBinding;
  /** Raw tool input, rendered as pretty JSON in a mono block. */
  input: unknown;
  /** Free-form "why I'm asking" explanation. */
  reason: ReactNode;
  /** Policy number the explanation references, e.g. `7` → "Policy #7". */
  policyNumber?: number | string;
  /** Footrow expiry copy, e.g. "expires in 23h 51m". */
  expiresInLabel?: string;
  variant?: ActionCardVariant;
  /** Mobile (390×844) layout: stacked full-width buttons + 70px label column. */
  mobile?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  onEditResign?: () => void;
  className?: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function bindingRows(binding: ActionCardBinding, isStale: boolean): BindingRow[] {
  const catalogValue = isStale && binding.previousCatalogSha256 ? (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground line-through decoration-amber-500" title={t("localizationIssueAux.ui_Previous_catalog_hash_51c775")}>
        {shortSha(binding.previousCatalogSha256)}
      </span>
      <span className="text-amber-600 dark:text-amber-400" title={t("localizationIssueAux.ui_Current_catalog_hash_1nnqbfz")}>
        {shortSha(binding.catalogSha256)}
      </span>
    </span>
  ) : (
    shortSha(binding.catalogSha256)
  );

  return [
    {
      label: "Application",
      value: (
        <span>
          {binding.application}
          <span className="ml-1.5 text-xs text-muted-foreground">{t("localizationIssueAux.manifestVersion", { version: binding.manifestVersion })}</span>
        </span>
      ),
    },
    { label: "Connection", value: binding.connection, mono: true },
    { label: "Catalog", value: catalogValue, mono: !isStale },
    {
      label: "Payload",
      value: (
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{shortSha(binding.payloadSha256)}</span>
          <span className="font-sans text-(length:--text-micro) uppercase tracking-normal text-muted-foreground">{t("localizationIssueAux.ui_signed_1ecdes5")}</span>
        </span>
      ),
      mono: true,
    },
  ];
}

export function ActionCard({
  agentName = "Coder",
  agentAvatarUrl,
  toolName,
  risk,
  isReadOnly,
  isWrite,
  isDestructive,
  binding,
  input,
  reason,
  policyNumber,
  expiresInLabel,
  variant = "pending",
  mobile = false,
  onApprove,
  onDeny,
  onEditResign,
  className,
}: ActionCardProps) {
  const { t } = useTranslation();
  const isStale = variant === "stale";
  const json = typeof input === "string" ? input : JSON.stringify(input, null, 2);

  // Surface 99: buttons stack full-width in the order Approve / Deny /
  // Edit & re-sign; desktop keeps them inline as Edit & re-sign / Deny / Approve.
  const approveButton = (
    <Button
      size="sm"
      onClick={onApprove}
      disabled={isStale}
      className={mobile ? "w-full" : undefined}
      title={isStale ? t("localizationIssueAux.ui_Re_issue_the_request_before_approving_the_catalog_hash_changed_1y3awhn") : undefined}
    >
      {t("localizationIssueAux.ui_Approve_1s2ov2y")}
    </Button>
  );
  const denyButton = (
    <Button size="sm" variant="outline" onClick={onDeny} className={mobile ? "w-full" : undefined}>
      {t("localizationIssueAux.ui_Deny_269q4n")}
    </Button>
  );
  const editButton = (
    <Button size="sm" variant="outline" onClick={onEditResign} className={mobile ? "w-full" : undefined}>
      <Pencil className="mr-1 h-3.5 w-3.5" />
      {t("localizationIssueAux.ui_Edit_re_sign_12cfqfe")}
    </Button>
  );

  return (
    <Card
      className={cn(
        "gap-0 py-0",
        isStale && "border-amber-500/50 dark:border-amber-500/40",
        className,
      )}
      data-variant={variant}
    >
      <CardContent className="space-y-3 p-4">
        {/* Header: avatar + request line + outcome pill */}
        <div className="flex items-start gap-3">
          <Avatar size="sm" className="shrink-0">
            {agentAvatarUrl ? <AvatarImage src={agentAvatarUrl} alt={agentName} /> : null}
            <AvatarFallback>{initials(agentName)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">
              <Trans i18nKey="localizationIssueAux.requestedApproval" values={{ agent: agentName }} components={{ agent: <span className="font-medium" /> }} />
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground break-all">{toolName}</p>
          </div>
          <div className="shrink-0">
            <DecisionBadge decision="require_approval" />
          </div>
        </div>

        {/* Body: tool name + risk / capability pills */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-foreground">{toolName}</span>
          <RiskBadge risk={risk} />
          <CapabilityBadges isReadOnly={isReadOnly} isWrite={isWrite} isDestructive={isDestructive} />
        </div>

        {/* Stale banner (PAP-10400 hardening) */}
        {isStale ? (
          <EnforcementBanner
            tone="warning"
            title={t("localizationIssueAux.ui_Catalog_changed_since_this_request_was_signed_gaojy0")}
            body={t("localizationIssueAux.ui_The_application_s_tool_catalog_hash_no_longer_matches_the_one_thi_118f5r2")}
          />
        ) : null}

        {/* Bindings table */}
        <BindingsTable rows={bindingRows(binding, isStale)} labelWidth={mobile ? 70 : 132} />

        {/* JSON input */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{t("localizationIssueAux.ui_Input_189z5sr")}</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
            {json}
          </pre>
        </div>

        {/* Why I'm asking */}
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{t("localizationIssueAux.ui_Why_I_m_asking_1h8qd6d")}</p>
          <p className="text-sm text-muted-foreground">
            {reason}
            {policyNumber != null ? (
              <>
                {" "}
                <Trans i18nKey="localizationIssueAux.policyApproval" values={{ policy: policyNumber }} components={{ policy: <span className="font-medium text-foreground" /> }} />
              </>
            ) : null}
          </p>
        </div>
      </CardContent>

      {/* Footrow: expiry + actions */}
      <div
        className={cn(
          "flex gap-2 border-t border-border p-4",
          mobile ? "flex-col" : "flex-wrap items-center justify-between",
        )}
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {expiresInLabel ?? t("localizationIssueAux.ui_no_expiry_set_xzs75x")}
        </span>
        {mobile ? (
          <div className="flex flex-col gap-2">
            {approveButton}
            {denyButton}
            {editButton}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {editButton}
            {denyButton}
            {approveButton}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Mobile (390×844) presentation of {@link ActionCard}. */
export function ActionCardMobile(props: Omit<ActionCardProps, "mobile">) {
  return <ActionCard {...props} mobile />;
}
