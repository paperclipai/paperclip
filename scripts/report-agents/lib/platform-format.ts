import type { TokenRow } from "./metabase-queries.js";
import { moneySmart, growthBadge, acqBadge } from "./formatters.js";

export function buildPlatformHtml(tokens: TokenRow[], topN = 10): string {
  tokens.sort((a, b) => (b.total_value_24h ?? 0) - (a.total_value_24h ?? 0));

  const dateStr = new Date().toLocaleDateString("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit", month: "short", year: "numeric",
  });

  const totalAll = tokens.reduce((s, t) => s + (Number(t.total_value_all) || 0), 0);
  const filled24h = tokens.reduce((s, t) => s + (Number(t.total_value_24h) || 0), 0);
  const growthPct = totalAll > 0 ? (filled24h / totalAll) * 100 : 0;

  const dpTot24h = tokens.reduce((s, t) => s + (Number(t.total_exit_volume_24h) || 0), 0);
  const dpFil24h = tokens.reduce((s, t) => s + (Number(t.total_exit_volume_filled_24h) || 0), 0);
  const dpRate24h = dpTot24h > 0 ? (dpFil24h / dpTot24h) * 100 : 0;

  const wNew = tokens.reduce((s, t) => s + (Number(t.num_new_wallets_24h) || 0), 0);
  const wOld = tokens.reduce((s, t) => s + (Number(t.num_old_wallets_24h) || 0), 0);
  const wTot = wNew + wOld;
  const acqRate = wTot > 0 ? (wNew / wTot) * 100 : 0;

  const feesSpot = Math.max(filled24h - dpFil24h, 0) * 0.025;
  const feesRs = dpFil24h * 0.05;
  const feesTotal = feesSpot + feesRs;

  const out: string[] = [];

  // Header
  out.push(`<b>TODAY</b>  ·  ${dateStr}`);
  out.push(``);

  // KPI summary line
  out.push(`${moneySmart(filled24h)} vol  ·  ${wTot} wallets  ·  ${moneySmart(feesTotal)} fees`);
  out.push(``);

  // Metrics
  out.push(`Volume       ${moneySmart(filled24h)}  ${growthBadge(growthPct)}`);
  out.push(`Wallets      ${wTot}  (${wNew} new · ${acqBadge(acqRate)})`);
  out.push(`Resale       ${moneySmart(dpFil24h)} / ${moneySmart(dpTot24h)}  (${Math.round(dpRate24h)}% filled)`);
  out.push(`Fees         ${moneySmart(feesTotal)}  (spot ${moneySmart(feesSpot)} · rs ${moneySmart(feesRs)})`);
  out.push(``);

  // Top tokens
  out.push(`<b>TOKENS</b>`);
  tokens.slice(0, topN).forEach((t, i) => {
    const sym = t.token_symbol || "?";
    const chain = t.network_name || "";
    const wN = Number(t.num_new_wallets_24h) || 0;
    const wO = Number(t.num_old_wallets_24h) || 0;
    const wT = wN + wO;

    out.push(`${i + 1}. <b>$${sym}</b>${chain ? ` <i>${chain}</i>` : ""}  —  ${moneySmart(t.total_value_24h)}  ·  ${wT}w (${wN} new)`);
  });

  return out.join("\n");
}
