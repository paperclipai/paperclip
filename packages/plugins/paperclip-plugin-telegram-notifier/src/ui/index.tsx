/**
 * Telegram Notifier — settings page.
 *
 * Layout mirrors paperclip-plugin-jira-sync: one `card` per company plus a
 * shared "Plugin configuration" card for instance-level settings (token,
 * notifications, digest, silent push). Each company card carries its own
 * pairing status, operate-as agent, and plan-approval workflow config.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface InstanceConfig {
  botToken?: string;
  paperclipBaseUrl?: string;
  notifyOn?: {
    approvals?: boolean;
    assignedToYou?: boolean;
    comments?: boolean;
    runFailures?: boolean;
    budgetIncidents?: boolean;
    wakeRequests?: boolean;
  };
  morningDigest?: {
    enabled?: boolean;
    hour?: number;
    weekdaysOnly?: boolean;
  };
  silent?: boolean;
}

interface StatusData {
  tokenConfigured: boolean;
  tokenMasked: string | null;
  botUsername?: string;
  telegramUrl?: string;
  handshake?: {
    stage: "awaiting_chat" | "code_sent";
    targetCompanyId: string;
    targetCompanyName?: string;
    expiresAt: string;
    candidateChatLabel?: string;
  };
}

interface CompanyRow {
  id: string;
  name: string;
  paired: boolean;
  chatLabel?: string;
  operateAsAgentId?: string;
  operateAsAgentLabel?: string;
  pairedAt?: string;
}

interface CompaniesData {
  items: CompanyRow[];
}

interface AgentOption {
  id: string;
  label: string;
  role?: string;
  title?: string | null;
}
interface AgentsData {
  items: AgentOption[];
}

interface ApprovalAgentRow {
  requiresApproval: boolean;
  template?: string;
}
interface ApprovalCfg {
  enabled: boolean;
  approverAgentId: string | null;
  agents: Record<string, ApprovalAgentRow>;
}
interface ApprovalData {
  config: ApprovalCfg | null;
  agents: Array<{ id: string; label: string; role?: string }>;
  resolvedApprover: { id: string; name: string } | null;
  defaultTemplate: string;
  snippetWrapper: string;
  companyPrefix: string | null;
  dashboardBaseUrl: string;
}

function getPluginIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  const segments = window.location.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== "settings" ? last : (segments[segments.length - 2] ?? null);
}

// ---------------------------------------------------------------------------
// TelegramNotifierSettings — page entrypoint
// ---------------------------------------------------------------------------

export function TelegramNotifierSettings(_: PluginSettingsPageProps) {
  const { data: status, loading, error, refresh: refreshStatus } =
    usePluginData<StatusData>("status");
  const { data: companiesData, refresh: refreshCompanies } =
    usePluginData<CompaniesData>("companies");
  const startPairing = usePluginAction("startPairing");
  const confirmPairing = usePluginAction("confirmPairing");
  const unpair = usePluginAction("unpair");
  const sendTest = usePluginAction("sendTest");
  const setOperateAs = usePluginAction("setOperateAsForCompany");

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalInfo, setGlobalInfo] = useState<string | null>(null);

  // Auto-refresh while a handshake is in flight.
  const handshakeStage = status?.handshake?.stage;
  useEffect(() => {
    if (!handshakeStage) return;
    const timer = setInterval(() => {
      refreshStatus();
      refreshCompanies();
    }, 3000);
    return () => clearInterval(timer);
  }, [handshakeStage, refreshStatus, refreshCompanies]);

  // 1-second tick so the expiry countdown updates between data refreshes.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!handshakeStage) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [handshakeStage]);

  const wrap = useCallback(
    (label: string, fn: () => Promise<unknown>) => async () => {
      setBusy(label);
      setGlobalError(null);
      setGlobalInfo(null);
      try {
        const res = (await fn()) as { content?: string } | undefined;
        if (res && typeof res.content === "string") setGlobalInfo(res.content);
        await Promise.all([refreshStatus(), refreshCompanies()]);
      } catch (err) {
        setGlobalError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refreshStatus, refreshCompanies],
  );

  const expiresInSec = (() => {
    if (!status?.handshake?.expiresAt) return null;
    const left = Date.parse(status.handshake.expiresAt) - Date.now();
    return left > 0 ? Math.floor(left / 1000) : 0;
  })();

  return (
    <section style={{ display: "grid", gap: 16, maxWidth: 820 }}>
      {loading && <div style={p}>Loading status…</div>}
      {error && (
        <div style={errBox}>Failed to load status: {String(error.message)}</div>
      )}

      {status && (
        <>
          <BotCredentialsCard
            tokenConfigured={status.tokenConfigured}
            tokenMasked={status.tokenMasked}
            onSaved={() => {
              refreshStatus();
              refreshCompanies();
            }}
          />

          {status.handshake?.stage === "code_sent" && (
            <HandshakeBanner
              title={`Code sent to ${status.handshake.candidateChatLabel ?? "your chat"}`}
              expiresInSec={expiresInSec}
            >
              <p style={p}>
                Paste the 6-character verification code the bot just sent in
                Telegram to finish pairing for{" "}
                <strong>
                  {status.handshake.targetCompanyName ??
                    status.handshake.targetCompanyId}
                </strong>
                .
              </p>
              <div style={btnRow}>
                <input
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\s/g, "").toUpperCase())
                  }
                  maxLength={6}
                  placeholder="K7MN3X"
                  style={codeInput}
                  autoFocus
                />
                <button
                  style={primaryBtn}
                  disabled={code.length !== 6 || busy !== null}
                  onClick={wrap("confirmPairing", () =>
                    confirmPairing({ code }),
                  )}
                >
                  {busy === "confirmPairing" ? "Confirming…" : "Confirm pairing"}
                </button>
              </div>
            </HandshakeBanner>
          )}
          {status.handshake?.stage === "awaiting_chat" && (
            <HandshakeBanner
              title="Waiting for your message in Telegram"
              expiresInSec={expiresInSec}
            >
              <p style={p}>
                Send a message to your bot
                {status.botUsername && (
                  <>
                    {" "}
                    (
                    <a href={status.telegramUrl} target="_blank" rel="noreferrer">
                      @{status.botUsername}
                    </a>
                    )
                  </>
                )}{" "}
                from the chat you want to pair with{" "}
                <strong>
                  {status.handshake.targetCompanyName ??
                    status.handshake.targetCompanyId}
                </strong>
                . The bot will reply there with a 6-character code.
              </p>
              <p style={hintBox}>
                <strong>Private DM:</strong> any message works.
                <br />
                <strong>Group / channel:</strong> Telegram bots only see
                commands or mentions in groups by default. Send{" "}
                <code>/start</code> (or{" "}
                <code>@{status.botUsername ?? "your_bot"} pair</code>) — plain
                text like "hello" will be invisible to the bot.
              </p>
            </HandshakeBanner>
          )}

          {(companiesData?.items ?? []).length === 0 && (
            <div style={warnBox}>No companies in this Paperclip instance yet.</div>
          )}

          <div style={{ display: "grid", gap: 14 }}>
            {(companiesData?.items ?? []).map((company) => (
              <CompanyCard
                key={company.id}
                company={company}
                tokenConfigured={status.tokenConfigured}
                handshake={status.handshake}
                busy={busy}
                onStart={(companyId) =>
                  wrap(`startPairing-${companyId}`, () =>
                    startPairing({ companyId }),
                  )()
                }
                onUnpair={(companyId) =>
                  wrap(`unpair-${companyId}`, () => unpair({ companyId }))()
                }
                onSendTest={(companyId) =>
                  wrap(`sendTest-${companyId}`, () => sendTest({ companyId }))()
                }
                onSetOperateAs={(companyId, agentId, agentLabel) =>
                  wrap(`operateAs-${companyId}`, () =>
                    setOperateAs({ companyId, agentId, agentLabel }),
                  )()
                }
              />
            ))}
          </div>

          {globalInfo && <div style={infoBox}>{globalInfo}</div>}
          {globalError && <div style={errBox}>{globalError}</div>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CompanyCard — one card per Paperclip company
// ---------------------------------------------------------------------------

function CompanyCard(props: {
  company: CompanyRow;
  tokenConfigured: boolean;
  handshake?: StatusData["handshake"];
  busy: string | null;
  onStart: (companyId: string) => void;
  onUnpair: (companyId: string) => void;
  onSendTest: (companyId: string) => void;
  onSetOperateAs: (
    companyId: string,
    agentId: string | undefined,
    agentLabel: string | undefined,
  ) => void;
}) {
  const { company, handshake, busy, tokenConfigured } = props;
  const isHandshakingThis = handshake?.targetCompanyId === company.id;
  const startKey = `startPairing-${company.id}`;
  const unpairKey = `unpair-${company.id}`;
  const testKey = `sendTest-${company.id}`;

  // Lifted approval-config fetch so the summary can describe the gate state
  // without the Section being expanded.
  const { data: approval } = usePluginData<ApprovalData>("approvalConfig", {
    companyId: company.id,
  });

  const [editing, setEditing] = useState(false);

  const approvalSummaryText = (() => {
    if (!approval) return "loading…";
    const cfg = approval.config;
    if (!cfg || !cfg.enabled) return "disabled";
    const agentCount = Object.values(cfg.agents ?? {}).filter(
      (a) => a.requiresApproval,
    ).length;
    const approverName = approval.resolvedApprover?.name ?? "(no approver)";
    return `enabled · ${agentCount} agent${agentCount === 1 ? "" : "s"} gate · approver: ${approverName}`;
  })();

  const headerMetaContent = (
    <>
      {company.paired && company.pairedAt && (
        <span style={metaPill}>
          Paired: {new Date(company.pairedAt).toLocaleString()}
        </span>
      )}
      {company.paired ? (
        <span style={badgeOk}>✅ {company.chatLabel ?? "paired"}</span>
      ) : isHandshakingThis ? (
        <span style={badgeWarn}>
          ⏳{" "}
          {handshake?.stage === "awaiting_chat"
            ? "awaiting message"
            : "awaiting code"}
        </span>
      ) : (
        <span style={badgeMuted}>not paired</span>
      )}
    </>
  );

  return (
    <div style={card}>
      <div style={rowHeader}>
        <span style={{ ...rowTitle, fontSize: 16 }}>{company.name}</span>
        <div style={headerMeta}>{headerMetaContent}</div>
      </div>

      {company.paired && !editing && (
        <PairedSummary
          company={company}
          approvalSummaryText={approvalSummaryText}
        />
      )}

      {company.paired && editing && (
        <CompanyEditPanel
          company={company}
          onClose={() => setEditing(false)}
        />
      )}

      {!company.paired && !isHandshakingThis && (
        <div style={btnRow}>
          <button
            style={{ ...primaryBtn, ...(!tokenConfigured && disabledStyle) }}
            disabled={!tokenConfigured || busy !== null}
            onClick={() => props.onStart(company.id)}
          >
            {busy === startKey ? "Starting…" : "Start pairing"}
          </button>
          {!tokenConfigured && (
            <span style={hint}>Save the bot token first.</span>
          )}
        </div>
      )}

      {!company.paired && isHandshakingThis && (
        <p style={hint}>
          Pairing handshake for this company is in flight — see the banner
          above.
        </p>
      )}

      {company.paired && !editing && (
        <div style={btnRow}>
          <button
            style={{ ...primaryBtn, ...(busy !== null && disabledStyle) }}
            onClick={() => setEditing(true)}
            disabled={busy !== null}
          >
            Edit
          </button>
          <button
            style={{ ...secondaryBtn, ...(busy !== null && disabledStyle) }}
            disabled={busy !== null}
            onClick={() => props.onSendTest(company.id)}
          >
            {busy === testKey ? "Sending…" : "Send test"}
          </button>
          <button
            style={{ ...dangerBtn, ...(busy !== null && disabledStyle) }}
            disabled={busy !== null}
            onClick={() => props.onUnpair(company.id)}
          >
            {busy === unpairKey ? "Unpairing…" : "Unpair"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompanyEditPanel — wraps the three editable sections and a single Save row
//
// Each section receives a `saveSlot` ref that it populates with its current
// `save()` closure on every render. The parent calls every slot's current
// fn on a single Save click. Plain ref-slots are used instead of
// `useImperativeHandle`, which Paperclip's plugin React shim doesn't expose.
// ---------------------------------------------------------------------------

type SaveSlot = MutableRefObject<(() => Promise<void>) | null>;

function CompanyEditPanel({
  company,
  onClose,
}: {
  company: CompanyRow;
  onClose: () => void;
}) {
  const operateAsSlot = useRef<(() => Promise<void>) | null>(null);
  const approvalSlot = useRef<(() => Promise<void>) | null>(null);
  const notifSlot = useRef<(() => Promise<void>) | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSaveAll = async () => {
    setSaving(true);
    setError(null);
    try {
      const tasks = [
        operateAsSlot.current?.(),
        approvalSlot.current?.(),
        notifSlot.current?.(),
      ].filter((t): t is Promise<void> => !!t);
      await Promise.all(tasks);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <OperateAsSection saveSlot={operateAsSlot} company={company} />
      <ApprovalSection saveSlot={approvalSlot} companyId={company.id} />
      <NotificationConfigSection saveSlot={notifSlot} />

      <div style={btnRow}>
        <button
          type="button"
          style={{ ...primaryBtn, ...(saving && disabledStyle) }}
          disabled={saving}
          onClick={handleSaveAll}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          style={{ ...secondaryBtn, ...(saving && disabledStyle) }}
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
        {error && <span style={errBox}>{error}</span>}
      </div>
    </>
  );
}

function PairedSummary({
  company,
  approvalSummaryText,
}: {
  company: CompanyRow;
  approvalSummaryText: string;
}) {
  return (
    <div style={summary}>
      <div>
        <strong>Chat:</strong> {company.chatLabel ?? "(unknown)"}
      </div>
      <div>
        <strong>Operate-as:</strong>{" "}
        {company.operateAsAgentLabel ? (
          <code>{company.operateAsAgentLabel}</code>
        ) : (
          <em>not set</em>
        )}
      </div>
      <div>
        <strong>Paired:</strong>{" "}
        {company.pairedAt
          ? new Date(company.pairedAt).toLocaleString()
          : "(unknown)"}
      </div>
      <div>
        <strong>Plan approval:</strong> {approvalSummaryText}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OperateAsSection — picker for the agent the bot impersonates
// ---------------------------------------------------------------------------

function OperateAsSection({
  saveSlot,
  company,
}: {
  saveSlot: SaveSlot;
  company: CompanyRow;
}) {
  const setOperateAs = usePluginAction("setOperateAsForCompany");
  const { data: agentsData, loading: agentsLoading } = usePluginData<AgentsData>(
    "agents",
    { companyId: company.id },
  );
  const agents = agentsData?.items ?? [];

  const [pendingId, setPendingId] = useState<string | undefined>(
    company.operateAsAgentId,
  );
  const [pendingLabel, setPendingLabel] = useState<string | undefined>(
    company.operateAsAgentLabel,
  );
  useEffect(() => {
    setPendingId(company.operateAsAgentId);
    setPendingLabel(company.operateAsAgentLabel);
  }, [company.operateAsAgentId, company.operateAsAgentLabel]);

  const dirty = pendingId !== company.operateAsAgentId;

  // Re-bind on every render so the closure captures the latest pending state.
  saveSlot.current = async () => {
    if (!dirty) return;
    await setOperateAs({
      companyId: company.id,
      agentId: pendingId,
      agentLabel: pendingLabel,
    });
  };
  useEffect(() => {
    return () => {
      saveSlot.current = null;
    };
  }, [saveSlot]);

  return (
    <Section
      title="Operate-as agent"
      description="The persona the bot impersonates when it creates issues from /new and what /inbox and the morning digest are scoped to. Also serves as the default plan-approval approver."
    >
      <Field label="Agent">
        <select
          value={pendingId ?? ""}
          onChange={(e) => {
            const opt = agents.find((a) => a.id === e.target.value);
            setPendingId(opt?.id);
            setPendingLabel(opt?.label);
          }}
          style={selectInput}
          disabled={agentsLoading || agents.length === 0}
        >
          <option value="">— Select an agent —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.title ? ` — ${a.title}` : ""}
            </option>
          ))}
        </select>
        {agentsLoading ? (
          <span style={hint}>Loading agents…</span>
        ) : agents.length === 0 ? (
          <span style={hint}>
            No agents in this company yet. Hire one (e.g. CEO) before
            configuring commands.
          </span>
        ) : null}
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// ApprovalSection — plan-approval workflow per company
// ---------------------------------------------------------------------------

function ApprovalSection({
  saveSlot,
  companyId,
}: {
  saveSlot: SaveSlot;
  companyId: string;
}) {
  const { data, loading, refresh } = usePluginData<ApprovalData>(
    "approvalConfig",
    { companyId },
  );
  const setApproval = usePluginAction("setApprovalConfig");

  const [draft, setDraft] = useState<ApprovalCfg | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft(
      data.config ?? {
        enabled: false,
        approverAgentId: null,
        agents: {},
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, data?.config]);

  const dirty =
    !!data &&
    !!draft &&
    JSON.stringify(draft) !==
      JSON.stringify(
        data.config ?? { enabled: false, approverAgentId: null, agents: {} },
      );

  saveSlot.current = async () => {
    if (!dirty || !draft) return;
    await setApproval({ companyId, config: draft });
    await refresh();
  };
  useEffect(() => {
    return () => {
      saveSlot.current = null;
    };
  }, [saveSlot]);

  if (loading || !data || !draft) {
    return (
      <Section title="Plan-approval workflow">
        <span style={hint}>Loading…</span>
      </Section>
    );
  }

  const updateAgent = (agentId: string, patch: Partial<ApprovalAgentRow>) => {
    setDraft((d) => {
      if (!d) return d;
      const prev = d.agents[agentId] ?? { requiresApproval: false };
      return {
        ...d,
        agents: { ...d.agents, [agentId]: { ...prev, ...patch } },
      };
    });
  };

  // The resolved approver is whatever the worker computed (operate-as agent
  // takes priority over explicit approverAgentId — see resolveApprover).
  // Filter the approver out of the gating list so they don't gate themselves.
  const approverId = data.resolvedApprover?.id ?? null;
  const eligibleAgents = data.agents.filter((a) => a.id !== approverId);

  const buildSnippet = (agentId: string): string => {
    const tpl =
      (draft.agents[agentId]?.template?.trim().length
        ? draft.agents[agentId]?.template
        : data.defaultTemplate) ?? data.defaultTemplate;
    const approverMention = data.resolvedApprover
      ? `@${data.resolvedApprover.name}`
      : "@<approver>";
    const filled = tpl
      .replaceAll("{ticketId}", "<ticket-id>")
      .replaceAll("{approverMention}", approverMention);
    return data.snippetWrapper.replace("{template}", filled);
  };

  const copySnippet = async (agentId: string) => {
    const text = buildSnippet(agentId);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(agentId);
      setTimeout(() => setCopied((c) => (c === agentId ? null : c)), 1800);
    } catch {
      setExpandedAgent(agentId);
    }
  };

  return (
    <Section
      title="Plan-approval workflow"
      description={
        <>
          When enabled, checked agents must post a plan and call{" "}
          <code>request_confirmation</code> before acting. The approver
          decides via [Approve] / [Decline] buttons in Telegram.
        </>
      }
    >
      <label style={checkboxRow}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) =>
            setDraft((d) => (d ? { ...d, enabled: e.target.checked } : d))
          }
        />
        <span style={fieldLabelText}>Enabled</span>
      </label>

      {draft.enabled && (
        <>
          <div style={{ fontSize: 13 }}>
            <strong>Approver:</strong>{" "}
            {data.resolvedApprover ? (
              <code>{data.resolvedApprover.name}</code>
            ) : (
              <em style={errInline}>
                no approver — set Operate-as agent above, or hire an agent
                with role <code>ceo</code> (or any role containing{" "}
                <code>lead</code>)
              </em>
            )}{" "}
            <span style={hint}>
              (uses the Operate-as agent — change it above to switch
              approver)
            </span>
          </div>

          <Field label="Agents requiring approval">
            {eligibleAgents.length === 0 ? (
              <span style={hint}>
                No eligible agents (the approver is excluded from gating).
              </span>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {eligibleAgents.map((a) => {
                  const row = draft.agents[a.id] ?? {
                    requiresApproval: false,
                  };
                  const instructionsUrl = data.companyPrefix
                    ? `${data.dashboardBaseUrl}/${data.companyPrefix}/agents/${a.id}/instructions`
                    : null;
                  return (
                    <div key={a.id} style={agentRow}>
                      <label style={checkboxRow}>
                        <input
                          type="checkbox"
                          checked={row.requiresApproval}
                          onChange={(e) =>
                            updateAgent(a.id, {
                              requiresApproval: e.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>{a.label}</strong>
                          {a.role ? (
                            <span style={hint}> — {a.role}</span>
                          ) : null}
                        </span>
                      </label>
                      {row.requiresApproval && (
                        <>
                          <span style={hint}>
                            Copy the snippet, then open the agent's
                            instructions and paste it into{" "}
                            <code>AGENTS.md</code> as a new{" "}
                            <code>## Plan-approval gate</code> section
                            (replacing any existing gate section).
                          </span>
                          <div style={btnRow}>
                            <button
                              type="button"
                              style={smallPrimaryBtn}
                              onClick={() => copySnippet(a.id)}
                            >
                              {copied === a.id ? "Copied ✓" : "Copy snippet"}
                            </button>
                            {instructionsUrl && (
                              <a
                                href={instructionsUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={smallSecondaryBtnAsLink}
                              >
                                Open instructions ↗
                              </a>
                            )}
                            <button
                              type="button"
                              style={smallSecondaryBtn}
                              onClick={() =>
                                setExpandedAgent((cur) =>
                                  cur === a.id ? null : a.id,
                                )
                              }
                            >
                              {expandedAgent === a.id
                                ? "Hide template"
                                : "Edit template"}
                            </button>
                          </div>
                        </>
                      )}
                      {expandedAgent === a.id && row.requiresApproval && (
                        <div style={{ display: "grid", gap: 6 }}>
                          <span style={hint}>
                            Plan template (leave blank to use the default).
                            Placeholders: <code>{"{ticketId}"}</code>,{" "}
                            <code>{"{approverMention}"}</code>.
                          </span>
                          <textarea
                            value={row.template ?? ""}
                            placeholder={data.defaultTemplate}
                            onChange={(e) =>
                              updateAgent(a.id, {
                                template: e.target.value || undefined,
                              })
                            }
                            rows={8}
                            style={textareaInput}
                          />
                          <details style={{ fontSize: 12 }}>
                            <summary style={hint}>
                              Preview the AGENTS.md snippet
                            </summary>
                            <pre style={preBox}>{buildSnippet(a.id)}</pre>
                          </details>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Field>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// useGlobalConfig — small hook around /api/plugins/{pluginId}/config
//
// Both the bot-credentials card (always visible at top) and the per-company
// notification/digest section (inside Edit mode) read from and write to the
// same global config endpoint. Sharing the endpoint via a hook keeps the
// load/save semantics consistent without hoisting state to the page.
// ---------------------------------------------------------------------------

function useGlobalConfig() {
  const pluginId = useMemo(() => getPluginIdFromPath(), []);
  const [config, setConfig] = useState<InstanceConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!pluginId) {
      setLoadError(
        "Could not determine plugin ID from URL — open the settings page from the Plugins list.",
      );
      return;
    }
    try {
      const res = await fetch(`/api/plugins/${pluginId}/config`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        setLoadError(`Failed to load config: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as
        | { configJson?: InstanceConfig }
        | InstanceConfig
        | null;
      const next =
        body && typeof body === "object" && "configJson" in body
          ? (body.configJson ?? {})
          : ((body ?? {}) as InstanceConfig);
      setConfig(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [pluginId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (next: InstanceConfig): Promise<void> => {
      if (!pluginId) throw new Error("plugin id unresolved");
      const res = await fetch(`/api/plugins/${pluginId}/config`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson: next }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Save failed: HTTP ${res.status} ${errBody}`);
      }
      setConfig(next);
    },
    [pluginId],
  );

  const update = useCallback(
    (patch: (prev: InstanceConfig) => InstanceConfig) => {
      setConfig((prev) => patch(prev ?? {}));
    },
    [],
  );

  return { config, loadError, reload, save, update };
}

// ---------------------------------------------------------------------------
// BotCredentialsCard — global card, always visible at the top of the page
// ---------------------------------------------------------------------------

function BotCredentialsCard({
  tokenConfigured,
  tokenMasked,
  onSaved,
}: {
  tokenConfigured: boolean;
  tokenMasked: string | null;
  onSaved: () => void;
}) {
  const { config, loadError, save, update } = useGlobalConfig();
  const testConn = usePluginAction("testBotConnection");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [tokenRevealed, setTokenRevealed] = useState(false);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setSaveOk(null);
    setSaveError(null);
    try {
      await save(config);
      setSaveOk("Saved.");
      setTokenRevealed(false);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [config, save, onSaved]);

  const handleTest = useCallback(async () => {
    setBusy("test");
    setSaveOk(null);
    setSaveError(null);
    try {
      const res = (await testConn({})) as { content?: string } | undefined;
      setSaveOk(res?.content ?? "Connection OK.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [testConn]);

  const handleDisconnect = useCallback(async () => {
    if (!config) return;
    if (
      !confirm(
        "Clear the bot token? Notifications will stop until a new token is saved.",
      )
    ) {
      return;
    }
    setBusy("disconnect");
    setSaveOk(null);
    setSaveError(null);
    try {
      const next = { ...config };
      delete next.botToken;
      await save(next);
      setSaveOk("Token cleared.");
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [config, save, onSaved]);

  if (loadError) {
    return <div style={errBox}>{loadError}</div>;
  }
  if (config === null) {
    return <div style={p}>Loading config…</div>;
  }

  const anyBusy = saving || busy !== null;

  return (
    <div style={card}>
      <div style={rowHeader}>
        <span style={{ ...rowTitle, fontSize: 16 }}>Bot credentials</span>
        <div style={headerMeta}>
          <span style={tokenConfigured ? badgeOk : badgeMuted}>
            {tokenConfigured ? "✅ token saved" : "no token"}
          </span>
        </div>
      </div>

      <Section
        title="Telegram bot"
        description={
          <>
            Bot API token from{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              @BotFather
            </a>
            . Either the literal token or the name of a Paperclip secret. One
            token applies to every paired company.
          </>
        }
      >
        <Field
          label={
            tokenConfigured
              ? "Telegram bot token (leave blank to keep current)"
              : "Telegram bot token"
          }
        >
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              type={tokenRevealed ? "text" : "password"}
              value={config.botToken ?? ""}
              onChange={(e) =>
                update((c) => ({
                  ...c,
                  botToken: e.target.value || undefined,
                }))
              }
              placeholder={
                tokenConfigured
                  ? `current: ${tokenMasked ?? "••••"}`
                  : "1234567890:AAEX..."
              }
              style={{ ...input, flex: 1, minWidth: 0 }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setTokenRevealed((v) => !v)}
              style={revealBtn}
            >
              {tokenRevealed ? "Hide" : "Show"}
            </button>
          </div>
        </Field>
        <Field label="Paperclip dashboard base URL">
          <input
            type="text"
            value={config.paperclipBaseUrl ?? ""}
            placeholder="http://localhost:3100"
            onChange={(e) =>
              update((c) => ({
                ...c,
                paperclipBaseUrl: e.target.value || undefined,
              }))
            }
            style={input}
          />
          <span style={hint}>
            Used to build deep links into the dashboard from notifications.
          </span>
        </Field>
      </Section>

      <div style={btnRow}>
        <button
          type="button"
          style={{ ...primaryBtn, ...(anyBusy && disabledStyle) }}
          disabled={anyBusy}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          style={{ ...secondaryBtn, ...(anyBusy && disabledStyle) }}
          disabled={anyBusy || !tokenConfigured}
          onClick={handleTest}
        >
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          style={{ ...dangerBtn, ...(anyBusy && disabledStyle) }}
          disabled={anyBusy || !tokenConfigured}
          onClick={handleDisconnect}
        >
          {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
        </button>
        {saveOk && <span style={infoBox}>{saveOk}</span>}
        {saveError && <span style={errBox}>{saveError}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationConfigSection — global notification/digest/display config,
// rendered inside each company's Edit mode (since these knobs decide what
// the paired chat actually receives, even though they're stored globally).
// ---------------------------------------------------------------------------

function NotificationConfigSection({ saveSlot }: { saveSlot: SaveSlot }) {
  const { config, loadError, save, update } = useGlobalConfig();
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (config !== null && baseline === null) {
      setBaseline(JSON.stringify(globalConfigForDirty(config)));
    }
  }, [config, baseline]);

  const dirty =
    config !== null &&
    baseline !== null &&
    JSON.stringify(globalConfigForDirty(config)) !== baseline;

  saveSlot.current = async () => {
    if (!dirty || !config) return;
    await save(config);
    setBaseline(JSON.stringify(globalConfigForDirty(config)));
  };
  useEffect(() => {
    return () => {
      saveSlot.current = null;
    };
  }, [saveSlot]);

  if (loadError) {
    return <div style={errBox}>{loadError}</div>;
  }
  if (config === null) {
    return <span style={hint}>Loading config…</span>;
  }

  const notify = config.notifyOn ?? {};
  const digest = config.morningDigest ?? {};

  return (
      <>
        <Section
          title="Notification triggers"
          description="Each event class pushes a Telegram message to the paired chat. Settings here apply to every paired company."
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 6,
            }}
          >
            {[
              ["approvals", "Approvals"],
              ["assignedToYou", "Issue assigned to you"],
              ["comments", "New comments"],
              ["runFailures", "Agent run failed"],
              ["budgetIncidents", "Budget incidents"],
              ["wakeRequests", "Wake requests"],
            ].map(([key, label]) => (
              <label key={key} style={checkboxRow}>
                <input
                  type="checkbox"
                  checked={notify[key as keyof typeof notify] !== false}
                  onChange={(e) =>
                    update((c) => ({
                      ...c,
                      notifyOn: {
                        ...(c.notifyOn ?? {}),
                        [key]: e.target.checked,
                      },
                    }))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section
          title="Morning digest"
          description="Daily summary of yesterday's completed work and today's queue. Scoped to each company's operate-as agent."
        >
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={digest.enabled === true}
              onChange={(e) =>
                update((c) => ({
                  ...c,
                  morningDigest: {
                    ...(c.morningDigest ?? {}),
                    enabled: e.target.checked,
                  },
                }))
              }
            />
            <span style={fieldLabelText}>Enabled</span>
          </label>
          <Field label="Hour (0–23, server local time)">
            <input
              type="number"
              min={0}
              max={23}
              value={digest.hour ?? 8}
              onChange={(e) => {
                const n = Number(e.target.value);
                update((c) => ({
                  ...c,
                  morningDigest: {
                    ...(c.morningDigest ?? {}),
                    hour: Number.isFinite(n) ? Math.max(0, Math.min(23, n)) : 8,
                  },
                }));
              }}
              style={{ ...input, width: 90 }}
            />
          </Field>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={digest.weekdaysOnly !== false}
              onChange={(e) =>
                update((c) => ({
                  ...c,
                  morningDigest: {
                    ...(c.morningDigest ?? {}),
                    weekdaysOnly: e.target.checked,
                  },
                }))
              }
            />
            <span>Weekdays only (Mon–Fri)</span>
          </label>
        </Section>

        <Section title="Display">
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={config.silent === true}
              onChange={(e) =>
                update((c) => ({ ...c, silent: e.target.checked }))
              }
            />
            <span style={fieldLabelText}>Silent push (no sound)</span>
          </label>
        </Section>
      </>
    );
}

/**
 * Subset of InstanceConfig used to detect dirtiness inside the company-card
 * Edit panel — excludes botToken/paperclipBaseUrl since those are owned by
 * the BotCredentialsCard and saving the whole config blob from here would
 * stomp on token edits in flight.
 */
function globalConfigForDirty(config: InstanceConfig): InstanceConfig {
  return {
    notifyOn: config.notifyOn,
    morningDigest: config.morningDigest,
    silent: config.silent,
  };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <fieldset style={fieldset}>
      <legend style={legend}>{title}</legend>
      {description && <p style={sectionDescription}>{description}</p>}
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={fieldLabel}>
      <span style={fieldLabelText}>{label}</span>
      {children}
    </label>
  );
}

function HandshakeBanner({
  title,
  expiresInSec,
  children,
}: {
  title: string;
  expiresInSec: number | null;
  children: React.ReactNode;
}) {
  return (
    <div style={banner}>
      <div style={rowHeader}>
        <span style={{ ...rowTitle, fontSize: 15 }}>{title}</span>
        <ExpiryBadge seconds={expiresInSec} />
      </div>
      <div style={{ display: "grid", gap: 10 }}>{children}</div>
    </div>
  );
}

function ExpiryBadge({ seconds }: { seconds: number | null }) {
  if (seconds === null) return null;
  if (seconds === 0) {
    return <span style={badgeWarn}>Expired</span>;
  }
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return (
    <span style={badgeOk}>
      Expires in {min}:{String(sec).padStart(2, "0")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (paired with shadcn-style theme tokens)
// ---------------------------------------------------------------------------

const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 16,
  background: "var(--card)",
  color: "var(--card-foreground)",
  display: "grid",
  gap: 12,
};
const banner: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 14,
  background: "color-mix(in srgb, var(--primary) 8%, var(--card))",
  color: "var(--card-foreground)",
  display: "grid",
  gap: 10,
};
const rowHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
const rowTitle: React.CSSProperties = {
  fontWeight: 600,
  color: "var(--foreground)",
};
const headerMeta: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  justifyContent: "flex-end",
};
const metaPill: React.CSSProperties = {
  fontSize: 12,
  color: "var(--muted-foreground)",
  whiteSpace: "nowrap",
};
const summary: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
  gap: "4px 14px",
  padding: "10px 12px",
  borderRadius: 6,
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  fontSize: 13,
  wordBreak: "break-word",
  overflowWrap: "anywhere",
};
const p: React.CSSProperties = {
  margin: "4px 0 0",
  color: "var(--muted-foreground)",
  fontSize: 14,
  lineHeight: 1.5,
};
const btnRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};
const baseBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  border: "1px solid transparent",
};
const disabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};
const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: "var(--primary)",
  color: "var(--primary-foreground)",
};
const smallPrimaryBtn: React.CSSProperties = {
  ...primaryBtn,
  padding: "6px 10px",
  fontSize: 13,
};
const secondaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: "var(--secondary)",
  border: "1px solid var(--border)",
  color: "var(--secondary-foreground)",
};
const smallSecondaryBtn: React.CSSProperties = {
  ...secondaryBtn,
  padding: "4px 10px",
  fontSize: 12,
};
const smallSecondaryBtnAsLink: React.CSSProperties = {
  ...smallSecondaryBtn,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
};
const dangerBtn: React.CSSProperties = {
  ...baseBtn,
  background: "transparent",
  border: "1px solid var(--destructive)",
  color: "var(--destructive)",
};
const revealBtn: React.CSSProperties = {
  flexShrink: 0,
  padding: "0 14px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  cursor: "pointer",
};
const fieldset: React.CSSProperties = {
  display: "grid",
  gap: 10,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 12,
  background: "var(--card)",
};
const legend: React.CSSProperties = {
  fontWeight: 600,
  padding: "0 6px",
};
const sectionDescription: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 12,
  color: "var(--muted-foreground)",
  lineHeight: 1.45,
};
const fieldLabel: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 14,
  color: "var(--card-foreground)",
};
const fieldLabelText: React.CSSProperties = {
  fontWeight: 500,
  fontSize: 13,
};
const input: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--input, var(--background))",
  color: "var(--foreground)",
  fontSize: 14,
};
const selectInput: React.CSSProperties = {
  ...input,
};
const textareaInput: React.CSSProperties = {
  ...input,
  fontFamily: "monospace",
  fontSize: 13,
  width: "100%",
  resize: "vertical",
};
const codeInput: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 18,
  letterSpacing: 4,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--input, var(--background))",
  color: "var(--foreground)",
  width: 140,
  textAlign: "center" as const,
};
const checkboxRow: React.CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  fontSize: 13,
};
const hint: React.CSSProperties = {
  fontSize: 12,
  color: "var(--muted-foreground)",
};
const hintBox: React.CSSProperties = {
  margin: 0,
  padding: 10,
  borderRadius: 6,
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  fontSize: 13,
  lineHeight: 1.5,
};
const errInline: React.CSSProperties = {
  fontSize: 12,
  color: "var(--destructive)",
};
const errBox: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: "color-mix(in srgb, var(--destructive) 12%, transparent)",
  border: "1px solid var(--destructive)",
  color: "var(--destructive)",
  fontSize: 13,
};
const infoBox: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: "color-mix(in srgb, var(--primary) 8%, transparent)",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  fontSize: 13,
};
const warnBox: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: "color-mix(in srgb, var(--destructive) 8%, transparent)",
  border: "1px solid var(--border)",
  color: "var(--foreground)",
  fontSize: 13,
};
const badgeOk: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 12,
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  fontSize: 12,
};
const badgeMuted: React.CSSProperties = {
  ...badgeOk,
  opacity: 0.6,
};
const badgeWarn: React.CSSProperties = {
  ...badgeOk,
  background: "color-mix(in srgb, var(--destructive) 14%, transparent)",
  color: "var(--destructive)",
};
const agentRow: React.CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "8px 10px",
  borderRadius: 6,
  background: "var(--secondary)",
};
const preBox: React.CSSProperties = {
  padding: 8,
  borderRadius: 4,
  background: "var(--background)",
  color: "var(--foreground)",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 240,
  overflow: "auto",
  border: "1px solid var(--border)",
};
