import { useState, type CSSProperties } from "react";
import {
  Spinner,
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { AdminCompanyRow } from "../service.js";
import { ActionRow, Button, Callout, Card, EmptyState, LoadingBlock, Mono, PageHeading, Stack, tokens } from "./kit.js";

export function BillingAdminPage(_props: PluginSettingsPageProps) {
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  // NOTE: no companyId in the data params — the bridge call without a company
  // scope is what makes the host assert instance admin.
  const { data: rows, loading, error: loadError } = usePluginData<AdminCompanyRow[]>("admin-overview", { tick });
  const setPrice = usePluginAction("admin-set-price-override");
  const extendTrial = usePluginAction("admin-extend-trial");
  const resync = usePluginAction("admin-force-resync");

  if (loading && !rows) return <LoadingBlock><Spinner /></LoadingBlock>;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      setTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const thStyle: CSSProperties = {
    textAlign: "left",
    padding: "10px 14px",
    fontSize: 11,
    fontWeight: 600,
    color: tokens.muted,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    borderBottom: `1px solid ${tokens.border}`,
    whiteSpace: "nowrap",
  };
  const tdStyle: CSSProperties = {
    padding: "10px 14px",
    fontSize: 13,
    verticalAlign: "top",
  };

  return (
    <Stack style={{ maxWidth: 1080 }}>
      <PageHeading>Billing — all companies</PageHeading>
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted, maxWidth: 640 }}>
        Instance configuration (currency, default price, trial and grace policy) lives in the auto-generated config form for this plugin.
      </p>

      {error && <Callout tone="danger" role="alert"><span>{error}</span></Callout>}
      {loadError && !rows && (
        <Callout tone="danger" role="alert"><span>Could not load companies: {loadError.message}</span></Callout>
      )}

      <Card>
        {rows && rows.length === 0 ? (
          <EmptyState>No companies yet.</EmptyState>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Company</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Payer</th>
                  <th style={thStyle}>Price</th>
                  <th style={thStyle}>Trial ends</th>
                  <th style={thStyle}>Period end</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => (
                  <tr key={row.companyId} style={{ borderBottom: `1px solid ${tokens.border}` }}>
                    <td style={tdStyle}><Mono>{row.companyId}</Mono></td>
                    <td style={tdStyle}>{row.status}{row.cancelAtPeriodEnd ? " (ends at period end)" : ""}</td>
                    <td style={tdStyle}>{row.ownerUserId}</td>
                    <td style={{ ...tdStyle, minWidth: 260 }}>
                      <Stack gap={6}>
                        <span>{row.status === "complimentary" ? "Complimentary" : `${formatAmount(row.priceCents, row.currency)}/mo`}</span>
                        <ActionRow style={{ gap: 6 }}>
                          <input
                            aria-label={`Price override for ${row.companyId} (cents; 0 = complimentary; empty = default)`}
                            value={overrideDrafts[row.companyId] ?? (row.priceCentsOverride === null ? "" : String(row.priceCentsOverride))}
                            onChange={(event) => setOverrideDrafts((drafts) => ({ ...drafts, [row.companyId]: event.target.value }))}
                            style={{
                              width: 90,
                              background: "var(--input, transparent)",
                              color: tokens.fg,
                              border: `1px solid ${tokens.border}`,
                              borderRadius: 6,
                              padding: "4px 8px",
                              fontSize: 12,
                            }}
                          />
                          <Button
                            onClick={() => void run(() => {
                              const draft = (overrideDrafts[row.companyId] ?? "").trim();
                              return setPrice({ targetCompanyId: row.companyId, priceCents: draft === "" ? null : Number(draft) });
                            })}
                          >
                            Set price
                          </Button>
                        </ActionRow>
                      </Stack>
                    </td>
                    <td style={tdStyle}>{row.trialEndsAt ? row.trialEndsAt.slice(0, 10) : "—"}</td>
                    <td style={tdStyle}>{row.currentPeriodEnd ? row.currentPeriodEnd.slice(0, 10) : "—"}</td>
                    <td style={tdStyle}>
                      <ActionRow style={{ gap: 6 }}>
                        <Button onClick={() => void run(() => extendTrial({ targetCompanyId: row.companyId, days: 7 }))}>Extend trial +7d</Button>
                        <Button onClick={() => void run(() => resync({ targetCompanyId: row.companyId }))}>Force re-sync</Button>
                      </ActionRow>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Stack>
  );
}
