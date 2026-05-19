// LET-501 follow-on C — Blueprint detail workbench.
//
// Backend contract: GET /api/companies/:companyId/blueprints/:ref from
// LET-498 / PR #92 returns the version detail with configSchema,
// systemPromptTemplate, source, etc.
//
// Tabs (LET-497 §5/§7):
//   * Overview     — title, ref, category, description, runtime defaults,
//                    budget, validation contract.
//   * Capabilities — required skills, MCP bundles, secret inputs,
//                    provider keys, permission policies, system prompt
//                    template (redacted).
//   * Versions     — single canonical version per ref today; explicit
//                    no-history state when a different :version is
//                    requested in the URL.
//   * Instances    — backend instance index endpoint is the LET-501 D
//                    lane; explicit no-data state until then.
//   * Audit        — backend audit endpoint is the LET-501 E lane;
//                    explicit no-data state until then.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  blueprintsApi,
  type BlueprintCatalogDetail,
} from "@/api/blueprints";
import { EaosStateChip } from "../EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "../state-labels";
import { redactSecretLikeText } from "../secret-redact";
import {
  BLUEPRINT_CATEGORY_LABEL,
  summarizePermissionPosture,
} from "./blueprint-helpers";

export type BlueprintDetailTab =
  | "overview"
  | "capabilities"
  | "versions"
  | "instances"
  | "audit";

const TAB_LABEL: Record<BlueprintDetailTab, string> = {
  overview: "Overview",
  capabilities: "Capabilities",
  versions: "Versions",
  instances: "Instances",
  audit: "Audit",
};

const TAB_ORDER: readonly BlueprintDetailTab[] = [
  "overview",
  "capabilities",
  "versions",
  "instances",
  "audit",
];

export function resolveActiveTab(pathname: string): BlueprintDetailTab {
  if (/\/versions(\/|$)/.test(pathname)) return "versions";
  if (/\/instances(\/|$)/.test(pathname)) return "instances";
  if (/\/audit(\/|$)/.test(pathname)) return "audit";
  if (/\/capabilities(\/|$)/.test(pathname)) return "capabilities";
  return "overview";
}

export function BlueprintDetailPage() {
  const params = useParams<{ blueprintRef?: string; version?: string }>();
  const location = useLocation();
  const { selectedCompanyId, selectedCompany } = useCompany();

  const blueprintRef = params.blueprintRef ?? "";
  const requestedVersionParam = params.version ?? null;
  const activeTab = resolveActiveTab(location.pathname);

  const detailQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.blueprints.detail(selectedCompanyId, blueprintRef)
      : (["blueprints", "detail", "__no-company__", blueprintRef] as const),
    queryFn: () => blueprintsApi.get(selectedCompanyId!, blueprintRef),
    enabled: Boolean(selectedCompanyId) && blueprintRef.length > 0,
    retry: false,
  });

  const detail = detailQuery.data;
  const isLoading = Boolean(selectedCompanyId) && detailQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && detailQuery.isError;
  const hasData = !isLoading && !isError && detailQuery.isSuccess && Boolean(detail);
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-blueprint-detail-title"
      className="flex flex-col gap-5"
      data-testid="eaos-blueprint-detail-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
      data-active-tab={activeTab}
      data-blueprint-ref={blueprintRef}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-blueprint-detail-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Data"
              title="Detail sourced from /api/companies/:companyId/blueprints/:ref (LET-498)"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-blueprint-detail-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            <Link
              to="/eaos/blueprints"
              className="underline-offset-2 hover:underline"
              data-testid="eaos-blueprint-detail-back-link"
            >
              ← Back to blueprint catalog
            </Link>
          </p>
          <h1
            id="eaos-blueprint-detail-title"
            className="text-2xl font-semibold tracking-tight text-foreground"
            data-testid="eaos-blueprint-detail-title"
          >
            {hasData && detail ? redactSecretLikeText(detail.title) : "Blueprint detail"}
          </h1>
          <p className="text-xs text-muted-foreground" data-testid="eaos-blueprint-detail-ref">
            {blueprintRef ? redactSecretLikeText(blueprintRef) : "(no ref)"}
          </p>
        </div>
      </header>

      {!selectedCompanyId ? (
        <NoCompanyState />
      ) : isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={readErrorMessage(detailQuery.error)} />
      ) : !hasData || !detail ? (
        <NotFoundState />
      ) : (
        <DetailBody
          detail={detail}
          activeTab={activeTab}
          requestedVersionParam={requestedVersionParam}
        />
      )}
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load blueprint detail.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprint-detail-no-company"
    >
      Select a company scope from the top bar to load this blueprint detail. The catalog is
      always scoped to the currently selected company.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprint-detail-loading"
    >
      Loading blueprint detail…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-blueprint-detail-error"
    >
      <p className="font-medium">Could not load this blueprint.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">
        The detail workbench is hidden because no backend-backed read is available. Retry by
        refreshing or return to the catalog.
      </p>
    </div>
  );
}

function NotFoundState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprint-detail-not-found"
    >
      No blueprint matches the requested ref. It may have been deprecated, the catalog feature
      flag may be off, or the link may be stale.
    </div>
  );
}

function DetailBody({
  detail,
  activeTab,
  requestedVersionParam,
}: {
  detail: BlueprintCatalogDetail;
  activeTab: BlueprintDetailTab;
  requestedVersionParam: string | null;
}) {
  const posture = useMemo(() => summarizePermissionPosture(detail), [detail]);
  return (
    <div className="flex flex-col gap-4">
      <SummaryRow detail={detail} posture={posture} />
      <Tabs detail={detail} active={activeTab} />
      <div data-testid="eaos-blueprint-detail-tabpanel" data-tab={activeTab}>
        {activeTab === "overview" ? <OverviewTab detail={detail} posture={posture} /> : null}
        {activeTab === "capabilities" ? <CapabilitiesTab detail={detail} /> : null}
        {activeTab === "versions" ? (
          <VersionsTab detail={detail} requestedVersionParam={requestedVersionParam} />
        ) : null}
        {activeTab === "instances" ? <InstancesTab /> : null}
        {activeTab === "audit" ? <AuditTab /> : null}
      </div>
    </div>
  );
}

function SummaryRow({
  detail,
  posture,
}: {
  detail: BlueprintCatalogDetail;
  posture: ReturnType<typeof summarizePermissionPosture>;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="eaos-blueprint-detail-summary"
    >
      <EaosStateChip
        label={detail.status === "published" ? "BACKEND-BACKED" : "PREVIEW"}
        prefix={`Status · ${detail.status}`}
        title={`Blueprint version status from backend: ${detail.status}`}
      />
      <span
        className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        data-testid="eaos-blueprint-detail-category"
      >
        {BLUEPRINT_CATEGORY_LABEL[detail.category]}
      </span>
      <span
        className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        data-testid="eaos-blueprint-detail-version"
      >
        v{redactSecretLikeText(detail.version)}
      </span>
      <span
        className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        data-testid="eaos-blueprint-detail-runtime"
      >
        {redactSecretLikeText(detail.runtimeDefaults.adapter)} · {redactSecretLikeText(detail.runtimeDefaults.modelProfile)}
      </span>
      {posture.hasLiveExternalActionRisk ? (
        <EaosStateChip
          label="APPROVAL REQUIRED"
          prefix="Risk"
          title="At least one permission policy gates a live-external-action capability."
        />
      ) : null}
    </div>
  );
}

function Tabs({ detail, active }: { detail: BlueprintCatalogDetail; active: BlueprintDetailTab }) {
  return (
    <nav
      aria-label="Blueprint detail sections"
      data-testid="eaos-blueprint-detail-tabs"
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {TAB_ORDER.map((tab) => {
        const isActive = tab === active;
        const to = tabHref(detail.ref, tab);
        return (
          <Link
            key={tab}
            to={to}
            role="tab"
            aria-selected={isActive}
            data-testid={`eaos-blueprint-detail-tab-${tab}`}
            data-active={isActive}
            className={
              "border-b-2 px-3 py-1.5 text-xs font-medium uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
              (isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {TAB_LABEL[tab]}
          </Link>
        );
      })}
    </nav>
  );
}

function tabHref(blueprintRef: string, tab: BlueprintDetailTab): string {
  const base = `/eaos/blueprints/${encodeURIComponent(blueprintRef)}`;
  switch (tab) {
    case "overview":
      return base;
    case "capabilities":
      return `${base}/capabilities`;
    case "versions":
      return `${base}/versions/latest`;
    case "instances":
      return `${base}/instances`;
    case "audit":
      return `${base}/audit`;
  }
}

function OverviewTab({
  detail,
  posture,
}: {
  detail: BlueprintCatalogDetail;
  posture: ReturnType<typeof summarizePermissionPosture>;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      data-testid="eaos-blueprint-detail-overview"
    >
      <Section title="Description">
        <p className="text-sm text-muted-foreground" data-testid="eaos-blueprint-detail-description">
          {redactSecretLikeText(detail.description)}
        </p>
      </Section>
      <Section title="Identity">
        <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <Field label="Ref">{redactSecretLikeText(detail.ref)}</Field>
          <Field label="Key">{redactSecretLikeText(detail.key)}</Field>
          <Field label="Category">{BLUEPRINT_CATEGORY_LABEL[detail.category]}</Field>
          <Field label="Status">{detail.status}</Field>
          <Field label="Source kind">{detail.source.kind}</Field>
          {detail.source.kind === "ready_agent_pool" ? (
            <Field label="Source key">{redactSecretLikeText(detail.source.key)}</Field>
          ) : (
            <Field label="Source ref">{redactSecretLikeText(detail.source.ref)}</Field>
          )}
        </dl>
      </Section>
      <Section title="Runtime defaults">
        <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <Field label="Adapter">{redactSecretLikeText(detail.runtimeDefaults.adapter)}</Field>
          <Field label="Model profile">{redactSecretLikeText(detail.runtimeDefaults.modelProfile)}</Field>
        </dl>
      </Section>
      <Section title="Budget (defaults)">
        <dl className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <Field label="Max runs / day">{String(detail.budget.maxRunsPerDay)}</Field>
          <Field label="Max spend / day (cents)">{String(detail.budget.maxSpendCentsPerDay)}</Field>
        </dl>
      </Section>
      <Section title="Validation contract">
        {detail.validationContract.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No validation contract bullets declared for this blueprint version.
          </p>
        ) : (
          <ul
            className="list-disc space-y-1 pl-4 text-xs text-muted-foreground"
            data-testid="eaos-blueprint-detail-validation-contract"
          >
            {detail.validationContract.map((line) => (
              <li key={line}>{redactSecretLikeText(line)}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Posture summary">
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>{posture.totalPolicies} permission policy(ies) declared.</li>
          <li>
            {posture.hasBoardGate
              ? "At least one board-gated capability."
              : "No board-gated capabilities declared."}
          </li>
          <li>
            {posture.hasLeadGate
              ? "At least one lead-gated capability."
              : "No lead-gated capabilities declared."}
          </li>
          <li>
            {posture.hasLiveExternalActionRisk
              ? "Live-external-action risk surfaced; instantiate flow remains approval-gated."
              : "No live-external-action capability detected in declared policies."}
          </li>
        </ul>
      </Section>
    </div>
  );
}

function CapabilitiesTab({ detail }: { detail: BlueprintCatalogDetail }) {
  return (
    <div
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      data-testid="eaos-blueprint-detail-capabilities"
    >
      <Section title="Required skills">
        <RefList
          items={detail.requiredSkillRefs}
          emptyLabel="No skill refs declared. Instantiate will not require any skill inventory."
          testId="eaos-blueprint-detail-skills"
        />
      </Section>
      <Section title="MCP bundles">
        <RefList
          items={detail.mcpBundleRefs}
          emptyLabel="No MCP bundles declared. The blueprint does not require any MCP wiring."
          testId="eaos-blueprint-detail-mcp"
        />
      </Section>
      <Section title="Required secret inputs">
        <RefList
          items={detail.requiredSecretInputs}
          emptyLabel="No secret inputs required. The blueprint does not need any secret bindings to instantiate."
          testId="eaos-blueprint-detail-secret-inputs"
        />
      </Section>
      <Section title="Required provider keys">
        <RefList
          items={detail.requiredProviderKeys}
          emptyLabel="No provider keys required. The blueprint declares no provider dependency."
          testId="eaos-blueprint-detail-provider-keys"
        />
      </Section>
      <Section title="Permission policies">
        {detail.permissionPolicies.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No permission policies declared. Instantiate flow defaults to the standard
            approval-only posture (no live apply, execution, or external action).
          </p>
        ) : (
          <ul
            className="space-y-2 text-xs text-muted-foreground"
            data-testid="eaos-blueprint-detail-permissions"
          >
            {detail.permissionPolicies.map((policy) => (
              <li
                key={policy.key}
                className="rounded-md border border-border bg-background p-2"
                data-policy-key={policy.key}
                data-policy-gate={policy.gate}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
                    {redactSecretLikeText(policy.key)}
                  </code>
                  <EaosStateChip
                    label="APPROVAL REQUIRED"
                    prefix={`Gate · ${policy.gate}`}
                    title={`This capability is gated at ${policy.gate} approval level.`}
                  />
                </div>
                <p className="mt-1 text-[11px]">{redactSecretLikeText(policy.reason)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="System prompt template">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Read-only declaration · redaction applied
        </p>
        <pre
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 text-xs text-foreground"
          data-testid="eaos-blueprint-detail-system-prompt"
        >
          {redactSecretLikeText(detail.systemPromptTemplate)}
        </pre>
      </Section>
      <Section title="Config schema">
        {detail.configSchema.fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No config fields declared. Instantiate flow uses defaults only.
          </p>
        ) : (
          <ul
            className="space-y-1 text-xs text-muted-foreground"
            data-testid="eaos-blueprint-detail-config-schema"
          >
            {detail.configSchema.fields.map((field) => (
              <li key={field.key} className="rounded-md border border-border bg-background p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
                    {redactSecretLikeText(field.key)}
                  </code>
                  <span className="text-[10px] uppercase tracking-wide">{field.type}</span>
                  {field.required ? (
                    <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                      required
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px]">{redactSecretLikeText(field.label)}</p>
                {field.description ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {redactSecretLikeText(field.description)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function VersionsTab({
  detail,
  requestedVersionParam,
}: {
  detail: BlueprintCatalogDetail;
  requestedVersionParam: string | null;
}) {
  // The LET-498 backend exposes one canonical version per blueprint ref.
  // Multi-version history is intentionally deferred — we surface this as
  // a truthful "no history" state when the URL targets a version that
  // does not exist, instead of inferring rows.
  const requestedMatchesCanonical =
    requestedVersionParam == null ||
    requestedVersionParam === "latest" ||
    requestedVersionParam === detail.version;
  return (
    <div className="flex flex-col gap-3" data-testid="eaos-blueprint-detail-versions">
      <p className="text-xs text-muted-foreground">
        The catalog backend currently exposes one canonical version per blueprint ref.
        Multi-version history is deferred to a later lane; this tab will surface a row per
        version once the read model is wired.
      </p>
      <ul className="space-y-2">
        <li
          className="rounded-md border border-border bg-card p-3"
          data-testid="eaos-blueprint-detail-version-row"
          data-version={detail.version}
        >
          <div className="flex flex-wrap items-center gap-2">
            <EaosStateChip
              label={detail.status === "published" ? "BACKEND-BACKED" : "PREVIEW"}
              prefix={`Status · ${detail.status}`}
            />
            <span className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              v{redactSecretLikeText(detail.version)}
            </span>
            <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              canonical
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Single canonical version published for this ref. No deprecated or draft history.
          </p>
        </li>
      </ul>
      {!requestedMatchesCanonical ? (
        <div
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          data-testid="eaos-blueprint-detail-version-not-found"
        >
          <p className="font-medium">No matching version row.</p>
          <p className="mt-1">
            URL requested version <code>{redactSecretLikeText(requestedVersionParam ?? "")}</code>,
            but the catalog only exposes <code>v{redactSecretLikeText(detail.version)}</code>.
            This is a backend gap, not a leak —
            the LET-501 D / E lanes will expose multi-version history.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function InstancesTab() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprint-detail-instances-empty"
    >
      <p className="font-medium text-foreground">No instance index available yet.</p>
      <p className="mt-1 text-xs">
        The backend instance roster endpoint for this blueprint is deferred to a later LET-501
        lane (D / E). Until it lands, this tab shows a truthful gap state rather than inventing
        rows. Existing instantiate approvals can be reviewed in <Link
          to="/eaos/approvals"
          className="underline-offset-2 hover:underline"
          data-testid="eaos-blueprint-detail-instances-approvals-link"
        >Approvals / Risk</Link>.
      </p>
    </div>
  );
}

function AuditTab() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprint-detail-audit-empty"
    >
      <p className="font-medium text-foreground">No blueprint audit feed available yet.</p>
      <p className="mt-1 text-xs">
        Per-blueprint audit entries (instantiate requests, decisions, deprecations) are deferred
        to a later LET-501 lane. The activity stream remains accessible via the Kernel/Admin
        activity page until this surface is wired.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 rounded-md border border-border bg-card p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="uppercase tracking-wide">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function RefList({
  items,
  emptyLabel,
  testId,
}: {
  items: readonly string[];
  emptyLabel: string;
  testId: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {items.map((item) => (
        <li
          key={item}
          className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
        >
          <code>{redactSecretLikeText(item)}</code>
        </li>
      ))}
    </ul>
  );
}
