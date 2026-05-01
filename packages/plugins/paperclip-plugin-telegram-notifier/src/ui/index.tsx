/**
 * Telegram Notifier — settings page.
 *
 * One Telegram chat is paired *per company*. The page shows a list of
 * companies with per-row pairing controls (start, confirm with code,
 * unpair, send test, pick operate-as user). Single-company instances see a
 * collapsed single-row view that auto-targets the only company.
 *
 * The plugin's auto-generated config form (rendered by the host above this
 * component) handles the bot token via the `secret-ref` field type and masks
 * it after save. This component only handles the dynamic, per-company
 * controls that the JSON-schema form can't express.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

// Plugin instance config shape — mirrors instanceConfigSchema in manifest.ts.
// Editing happens via the host's `/api/plugins/{pluginId}/config` endpoint
// because Paperclip suppresses the auto-generated form whenever a custom
// settings-page slot is declared, so the plugin must surface every field it
// declares itself.
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

function getPluginIdFromPath(): string | null {
  if (typeof window === "undefined") return null;
  // Settings route is `/plugins/:pluginId` (or possibly nested under company);
  // the plugin DB id is the last segment that isn't "settings".
  const segments = window.location.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last !== "settings" ? last : (segments[segments.length - 2] ?? null);
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

export function TelegramNotifierSettings(_: PluginSettingsPageProps) {
  const { data, loading, error, refresh } = usePluginData<StatusData>("status");
  const { data: companiesData, refresh: refreshCompanies } =
    usePluginData<CompaniesData>("companies");
  const startPairing = usePluginAction("startPairing");
  const confirmPairing = usePluginAction("confirmPairing");
  const unpair = usePluginAction("unpair");
  const sendTest = usePluginAction("sendTest");
  const setOperateAs = usePluginAction("setOperateAsForCompany");

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);

  // Auto-refresh while a handshake is in flight.
  const handshakeStage = data?.handshake?.stage;
  useEffect(() => {
    if (!handshakeStage) return;
    const timer = setInterval(() => {
      refresh();
      refreshCompanies();
    }, 3000);
    return () => clearInterval(timer);
  }, [handshakeStage, refresh, refreshCompanies]);

  // Independent 1-second tick so the "Expires in M:SS" countdown updates
  // smoothly between data-refresh cycles (refresh polls every 3s).
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!handshakeStage) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [handshakeStage]);

  const wrap = useCallback(
    (label: string, fn: () => Promise<unknown>) => async () => {
      setBusy(label);
      setActionError(null);
      setActionInfo(null);
      try {
        const res = (await fn()) as { content?: string } | undefined;
        if (res && typeof res.content === "string") setActionInfo(res.content);
        await Promise.all([refresh(), refreshCompanies()]);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh, refreshCompanies],
  );

  // Recomputed on every render — the 1-second tick effect above guarantees
  // we re-render once per second while a handshake is in flight, and
  // useMemo on a stable ISO string would have frozen the countdown.
  const expiresInSec = (() => {
    if (!data?.handshake?.expiresAt) return null;
    const left = Date.parse(data.handshake.expiresAt) - Date.now();
    return left > 0 ? Math.floor(left / 1000) : 0;
  })();

  return (
    <section style={{ display: "grid", gap: 16, maxWidth: 720 }}>
      <header>
        <h2 style={{ margin: 0, color: "var(--foreground)" }}>Telegram pairing</h2>
        <p style={{ margin: "4px 0 0", color: "var(--muted-foreground)", fontSize: 14 }}>
          Pair one Telegram chat per company in this Paperclip instance. Each
          chat receives notifications and accepts commands only for its own
          company. The handshake requires control of both this dashboard and
          the Telegram chat.
        </p>
      </header>

      {loading && <div style={p}>Loading status…</div>}
      {error && (
        <div style={errBox}>Failed to load status: {String(error.message)}</div>
      )}

      {data && (
        <>
          <ConfigSection
            tokenConfigured={data.tokenConfigured}
            tokenMasked={data.tokenMasked}
            onSaved={() => {
              refresh();
              refreshCompanies();
            }}
          />

          {/* Code-entry banner appears whenever a handshake reaches code_sent,
              regardless of which company-row we're currently looking at. */}
          {data.handshake?.stage === "code_sent" && (
            <Card
              title={`Code sent to ${data.handshake.candidateChatLabel ?? "your chat"}`}
            >
              <p style={p}>
                Paste the 6-character verification code the bot just sent in
                Telegram to finish pairing for{" "}
                <code>
                  {data.handshake.targetCompanyName ??
                    data.handshake.targetCompanyId}
                </code>
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
              <ExpiryBadge seconds={expiresInSec} />
            </Card>
          )}
          {data.handshake?.stage === "awaiting_chat" && (
            <Card title="Waiting for your message in Telegram">
              <p style={p}>
                Send a message to your bot
                {data.botUsername && (
                  <>
                    {" "}
                    (
                    <a href={data.telegramUrl} target="_blank" rel="noreferrer">
                      @{data.botUsername}
                    </a>
                    )
                  </>
                )}{" "}
                from the chat you want to pair with{" "}
                <code>
                  {data.handshake.targetCompanyName ??
                    data.handshake.targetCompanyId}
                </code>
                . The bot will reply there with a 6-character code.
              </p>
              <p style={hintBox}>
                <strong>In a private DM:</strong> any message works.
                <br />
                <strong>In a group or channel:</strong> Telegram bots have
                privacy mode on by default and only receive commands or
                mentions in groups. Send <code>/start</code> (or
                <code>@{data.botUsername ?? "your_bot"} pair</code>) — plain
                text like "hello" will be invisible to the bot.
                <br />
                <strong>Pairing a second company?</strong> Telegram allows only
                one DM per bot per account, so additional chats must be groups
                or channels with this bot added.
              </p>
              <ExpiryBadge seconds={expiresInSec} />
            </Card>
          )}

          <CompaniesSection
            companies={companiesData?.items ?? []}
            tokenConfigured={data.tokenConfigured}
            handshake={data.handshake}
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

          {actionInfo && <div style={infoBox}>{actionInfo}</div>}
          {actionError && <div style={errBox}>{actionError}</div>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function CompaniesSection(props: {
  companies: CompanyRow[];
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
  const { companies } = props;

  if (companies.length === 0) {
    return (
      <Card title="Companies">
        <p style={p}>No companies in this Paperclip instance yet.</p>
      </Card>
    );
  }

  // Single-company view — collapsed, no per-row noise.
  if (companies.length === 1) {
    return (
      <Card title="Pairing">
        <CompanyRow {...props} company={companies[0]} compact />
      </Card>
    );
  }

  return (
    <Card title="Companies">
      <p style={p}>
        Pair a separate Telegram chat for each company you want to receive
        notifications and run commands from.
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        {companies.map((company) => (
          <div key={company.id} style={rowCard}>
            <CompanyRow {...props} company={company} compact={false} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function CompanyRow(props: {
  company: CompanyRow;
  tokenConfigured: boolean;
  handshake?: StatusData["handshake"];
  busy: string | null;
  compact: boolean;
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
  const isHandshakingThis =
    handshake?.targetCompanyId === company.id;
  const startKey = `startPairing-${company.id}`;
  const unpairKey = `unpair-${company.id}`;
  const testKey = `sendTest-${company.id}`;
  const operateAsKey = `operateAs-${company.id}`;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={rowHeader}>
        <span style={rowTitle}>{company.name}</span>
        <span style={statusBadgeFor(company, isHandshakingThis)}>
          {company.paired
            ? `✅ ${company.chatLabel ?? "paired"}`
            : isHandshakingThis
              ? `⏳ ${handshake?.stage === "awaiting_chat" ? "awaiting message" : "awaiting code"}`
              : "not paired"}
        </span>
      </div>

      {!company.paired && !isHandshakingThis && (
        <div style={btnRow}>
          <button
            style={primaryBtn}
            disabled={!tokenConfigured || busy !== null}
            onClick={() => props.onStart(company.id)}
          >
            {busy === startKey ? "Starting…" : "Start pairing"}
          </button>
          {!tokenConfigured && (
            <span style={fieldHint}>Save the bot token first.</span>
          )}
        </div>
      )}

      {company.paired && (
        <>
          <OperateAsPicker
            company={company}
            busy={busy === operateAsKey}
            onSet={(agentId, agentLabel) =>
              props.onSetOperateAs(company.id, agentId, agentLabel)
            }
          />
          <div style={btnRow}>
            <button
              style={secondaryBtn}
              disabled={busy !== null}
              onClick={() => props.onSendTest(company.id)}
            >
              {busy === testKey ? "Sending…" : "Send test"}
            </button>
            <button
              style={dangerBtn}
              disabled={busy !== null}
              onClick={() => props.onUnpair(company.id)}
            >
              {busy === unpairKey ? "Unpairing…" : "Unpair"}
            </button>
          </div>
          <p style={muted}>
            Paired{" "}
            {company.pairedAt
              ? new Date(company.pairedAt).toLocaleString()
              : ""}
          </p>
        </>
      )}
    </div>
  );
}

function OperateAsPicker(props: {
  company: CompanyRow;
  busy: boolean;
  onSet: (agentId: string | undefined, agentLabel: string | undefined) => void;
}) {
  const { company, busy } = props;
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
  // Reset pending when saved value changes (e.g. after another tab saves).
  useEffect(() => {
    setPendingId(company.operateAsAgentId);
    setPendingLabel(company.operateAsAgentLabel);
  }, [company.operateAsAgentId, company.operateAsAgentLabel]);

  const dirty = pendingId !== company.operateAsAgentId;

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <span style={fieldLabelText}>
        Operate-as agent (for `/new`, `/inbox`, digest)
      </span>
      <select
        value={pendingId ?? ""}
        onChange={(e) => {
          const opt = agents.find((a) => a.id === e.target.value);
          setPendingId(opt?.id);
          setPendingLabel(opt?.label);
        }}
        style={selectInput}
        disabled={busy || agentsLoading || agents.length === 0}
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
        <span style={fieldHint}>Loading agents…</span>
      ) : agents.length === 0 ? (
        <span style={fieldHint}>
          No agents in this company yet. Hire one (e.g. CEO) before configuring
          commands.
        </span>
      ) : null}
      <div style={btnRow}>
        <button
          style={smallPrimaryBtn}
          disabled={!dirty || busy}
          onClick={() => props.onSet(pendingId, pendingLabel)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {company.operateAsAgentId && !dirty && (
          <span style={muted}>
            Current:{" "}
            <code>
              {company.operateAsAgentLabel ?? company.operateAsAgentId}
            </code>
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConfigSection — fetches and writes the plugin's instance config.
//
// We can't rely on Paperclip's auto-rendered JSON-schema form because the
// host suppresses it whenever a `settingsPage` slot is declared. Instead,
// we read and write the same `/api/plugins/{pluginId}/config` endpoint the
// auto-form would have used, with a deliberately minimal field surface.
// ---------------------------------------------------------------------------

function ConfigSection({
  tokenConfigured,
  tokenMasked,
  onSaved,
}: {
  tokenConfigured: boolean;
  tokenMasked: string | null;
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<InstanceConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const pluginId = useMemo(() => getPluginIdFromPath(), []);

  useEffect(() => {
    if (!pluginId) {
      setLoadError(
        "Could not determine plugin ID from URL — open the settings page from the Plugins list.",
      );
      return;
    }
    let cancelled = false;
    (async () => {
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
        if (cancelled) return;
        const next =
          body && typeof body === "object" && "configJson" in body
            ? (body.configJson ?? {})
            : ((body ?? {}) as InstanceConfig);
        setConfig(next);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  const update = useCallback(
    (patch: (prev: InstanceConfig) => InstanceConfig) => {
      setSaveOk(false);
      setSaveError(null);
      setConfig((prev) => patch(prev ?? {}));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!pluginId || !config) return;
    setSaving(true);
    setSaveOk(false);
    setSaveError(null);
    try {
      const res = await fetch(`/api/plugins/${pluginId}/config`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson: config }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        setSaveError(`Save failed: HTTP ${res.status} ${errBody}`);
        return;
      }
      setSaveOk(true);
      setTokenRevealed(false);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [pluginId, config, onSaved]);

  if (loadError) {
    return <div style={errBox}>{loadError}</div>;
  }
  if (config === null) {
    return <div style={p}>Loading config…</div>;
  }

  const notify = config.notifyOn ?? {};
  const digest = config.morningDigest ?? {};

  return (
    <Card title="Plugin configuration">
      <div style={{ display: "grid", gap: 12 }}>
        <label style={fieldLabel}>
          <span style={fieldLabelText}>Telegram bot token</span>
          <div style={{ position: "relative" }}>
            <input
              type={tokenRevealed ? "text" : "password"}
              value={config.botToken ?? ""}
              onChange={(e) =>
                update((c) => ({ ...c, botToken: e.target.value || undefined }))
              }
              placeholder={
                tokenConfigured
                  ? (tokenMasked ?? "••••")
                  : "1234567890:AAEX..."
              }
              style={{ ...textInput, paddingRight: 64, width: "100%" }}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setTokenRevealed((v) => !v)}
              style={tokenRevealBtn}
            >
              {tokenRevealed ? "Hide" : "Show"}
            </button>
          </div>
          <span style={fieldHint}>
            Bot API token from{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              @BotFather
            </a>
            . Either the literal token or the name of a Paperclip secret.
          </span>
        </label>

        <label style={fieldLabel}>
          <span style={fieldLabelText}>Paperclip dashboard base URL</span>
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
            style={textInput}
          />
          <span style={fieldHint}>Used to build deep links in notifications.</span>
        </label>

        <fieldset style={fieldset}>
          <legend style={fieldLabelText}>Notification triggers</legend>
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
                    notifyOn: { ...(c.notifyOn ?? {}), [key]: e.target.checked },
                  }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset style={fieldset}>
          <legend style={fieldLabelText}>Morning digest</legend>
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
            <span>Enabled</span>
          </label>
          <label style={inlineFieldLabel}>
            <span style={fieldLabelText}>Hour (0–23, server local time)</span>
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
                    hour: Number.isFinite(n)
                      ? Math.max(0, Math.min(23, n))
                      : 8,
                  },
                }));
              }}
              style={{ ...textInput, width: 90 }}
            />
          </label>
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
        </fieldset>

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

        <div style={btnRow}>
          <button
            type="button"
            style={primaryBtn}
            disabled={saving}
            onClick={handleSave}
          >
            {saving ? "Saving…" : "Save configuration"}
          </button>
          {saveOk && <span style={infoBox}>Saved.</span>}
          {saveError && <span style={errBox}>{saveError}</span>}
        </div>
      </div>
    </Card>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={card}>
      <h3 style={cardTitle}>{title}</h3>
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
    <span style={badge}>
      Expires in {min}:{String(sec).padStart(2, "0")}
    </span>
  );
}

function statusBadgeFor(
  company: CompanyRow,
  isHandshakingThis: boolean,
): React.CSSProperties {
  if (company.paired) return { ...badge, color: "var(--foreground)" };
  if (isHandshakingThis) return { ...badge, color: "var(--foreground)" };
  return { ...badge, opacity: 0.7 };
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 16,
  background: "var(--card)",
  color: "var(--card-foreground)",
};
const cardTitle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 16,
  fontWeight: 600,
  color: "var(--card-foreground)",
};
const rowCard: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 12,
  background: "var(--secondary)",
};
const rowHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
const rowTitle: React.CSSProperties = {
  fontWeight: 500,
  color: "var(--foreground)",
};
const p: React.CSSProperties = {
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: 14,
  lineHeight: 1.5,
};
const muted: React.CSSProperties = {
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: 12,
};
const mutedRow: React.CSSProperties = {
  fontSize: 14,
  color: "var(--muted-foreground)",
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
const dangerBtn: React.CSSProperties = {
  ...baseBtn,
  background: "transparent",
  border: "1px solid var(--destructive)",
  color: "var(--destructive)",
};
const fieldLabel: React.CSSProperties = {
  display: "grid",
  gap: 6,
  fontSize: 14,
  color: "var(--card-foreground)",
};
const inlineFieldLabel: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  fontSize: 14,
  color: "var(--card-foreground)",
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
const fieldset: React.CSSProperties = {
  display: "grid",
  gap: 6,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 12,
};
const checkboxRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  fontSize: 14,
  color: "var(--foreground)",
};
const tokenRevealBtn: React.CSSProperties = {
  position: "absolute",
  right: 6,
  top: "50%",
  transform: "translateY(-50%)",
  padding: "4px 10px",
  fontSize: 12,
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  cursor: "pointer",
};
const fieldLabelText: React.CSSProperties = {
  fontWeight: 500,
  fontSize: 13,
  color: "var(--card-foreground)",
};
const fieldHint: React.CSSProperties = {
  fontSize: 12,
  color: "var(--muted-foreground)",
};
const selectInput: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--input, var(--background))",
  color: "var(--foreground)",
  fontSize: 14,
};
const textInput: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--input, var(--background))",
  color: "var(--foreground)",
  fontSize: 14,
  fontFamily: "monospace",
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
const badge: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 12,
  background: "var(--secondary)",
  color: "var(--secondary-foreground)",
  fontSize: 12,
};
const badgeWarn: React.CSSProperties = {
  ...badge,
  background: "color-mix(in srgb, var(--destructive) 14%, transparent)",
  color: "var(--destructive)",
};
