#!/usr/bin/env bun
/**
 * Token Usage Report — Günlük ve Haftalık
 * Kullanım: bun run scripts/token-report.ts [--daily|--weekly]
 */

// @ts-ignore
import postgres from "../packages/db/node_modules/postgres/cjs/src/index.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const MODE = process.argv.includes("--weekly") ? "weekly" : "daily";
const DB_URL = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@localhost:54329/paperclip";
const VAULT_DIR = `${process.env.HOME}/Documents/EvoHaus-Vault/Hafiza/token-reports`;

const sql = postgres(DB_URL, { ssl: false, max: 3 });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function bar(value: number, max: number, width = 20) {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function weekStr(d: Date) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ─── DB Queries ───────────────────────────────────────────────────────────────

async function getCostSummary(sinceHours: number) {
  const rows = await sql`
    SELECT
      ce.model,
      ce.adapter_type,
      ce.provider,
      SUM(ce.input_tokens) as input_tokens,
      SUM(ce.cached_input_tokens) as cached_tokens,
      SUM(ce.output_tokens) as output_tokens,
      SUM(ce.cost_cents) as cost_cents,
      COUNT(*) as event_count
    FROM cost_events ce
    WHERE ce.occurred_at >= NOW() - INTERVAL '${sql.unsafe(String(sinceHours))} hours'
    GROUP BY ce.model, ce.adapter_type, ce.provider
    ORDER BY cost_cents DESC
  `;
  return rows;
}

async function getAgentCosts(sinceHours: number) {
  const rows = await sql`
    SELECT
      a.name as agent_name,
      ce.adapter_type,
      ce.model,
      SUM(ce.input_tokens) as input_tokens,
      SUM(ce.cached_input_tokens) as cached_tokens,
      SUM(ce.output_tokens) as output_tokens,
      SUM(ce.cost_cents) as cost_cents,
      COUNT(*) as run_count
    FROM cost_events ce
    JOIN agents a ON a.id = ce.agent_id
    WHERE ce.occurred_at >= NOW() - INTERVAL '${sql.unsafe(String(sinceHours))} hours'
    GROUP BY a.name, ce.adapter_type, ce.model
    ORDER BY cost_cents DESC
  `;
  return rows;
}

async function getHeartbeatStats(sinceHours: number) {
  const rows = await sql`
    SELECT
      status,
      COUNT(*) as count,
      AVG(normalized_input_tokens) as avg_tokens,
      SUM(normalized_input_tokens) as total_tokens,
      COUNT(*) FILTER (WHERE session_reused = true) as session_reused_count
    FROM heartbeat_runs
    WHERE started_at >= NOW() - INTERVAL '${sql.unsafe(String(sinceHours))} hours'
    GROUP BY status
    ORDER BY count DESC
  `;
  return rows;
}

async function getDailyTrend() {
  const rows = await sql`
    SELECT
      DATE(occurred_at AT TIME ZONE 'Europe/Istanbul') as day,
      SUM(cost_cents) as cost_cents,
      SUM(input_tokens + output_tokens) as total_tokens,
      COUNT(*) as events
    FROM cost_events
    WHERE occurred_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(occurred_at AT TIME ZONE 'Europe/Istanbul')
    ORDER BY day ASC
  `;
  return rows;
}

async function getTopExpensiveRuns(limit: number) {
  const rows = await sql`
    SELECT
      hr.id as run_id,
      a.name as agent_name,
      a.adapter_type,
      hr.started_at,
      hr.normalized_input_tokens,
      hr.prompt_chars,
      hr.session_reused,
      hr.context_fetch_mode,
      SUM(ce.cost_cents) as cost_cents,
      SUM(ce.input_tokens) as input_tokens,
      SUM(ce.output_tokens) as output_tokens
    FROM heartbeat_runs hr
    JOIN agents a ON a.id = hr.agent_id
    LEFT JOIN cost_events ce ON ce.heartbeat_run_id = hr.id
    WHERE hr.started_at >= NOW() - INTERVAL '7 days'
    GROUP BY hr.id, a.name, a.adapter_type, hr.started_at, hr.normalized_input_tokens, hr.prompt_chars, hr.session_reused, hr.context_fetch_mode
    ORDER BY cost_cents DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows;
}

async function getModelTotals(sinceHours: number) {
  const rows = await sql`
    SELECT
      model,
      SUM(input_tokens) as input_tokens,
      SUM(cached_input_tokens) as cached_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cost_cents) as cost_cents,
      COUNT(*) as events
    FROM cost_events
    WHERE occurred_at >= NOW() - INTERVAL '${sql.unsafe(String(sinceHours))} hours'
    GROUP BY model
    ORDER BY cost_cents DESC
  `;
  return rows;
}

// ─── Report Generation ────────────────────────────────────────────────────────

async function generateDailyReport(): Promise<string> {
  const now = new Date();
  const lines: string[] = [];

  lines.push(`# 📊 Günlük Token Raporu — ${isoDate(now)}`);
  lines.push(`> Oluşturulma: ${now.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`);
  lines.push("");

  // Genel özet
  const modelTotals = await getModelTotals(24);
  const totalCost = modelTotals.reduce((s: number, r: any) => s + Number(r.cost_cents), 0);
  const totalInput = modelTotals.reduce((s: number, r: any) => s + Number(r.input_tokens), 0);
  const totalCached = modelTotals.reduce((s: number, r: any) => s + Number(r.cached_tokens), 0);
  const totalOutput = modelTotals.reduce((s: number, r: any) => s + Number(r.output_tokens), 0);

  lines.push("## 💰 24 Saat Özet");
  lines.push("");
  lines.push(`| Metrik | Değer |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Toplam Maliyet | **${formatMoney(totalCost)}** |`);
  lines.push(`| Input Token | ${formatTokens(totalInput)} |`);
  lines.push(`| Cache Hit Token | ${formatTokens(totalCached)} (${totalInput > 0 ? Math.round(totalCached/totalInput*100) : 0}%) |`);
  lines.push(`| Output Token | ${formatTokens(totalOutput)} |`);
  lines.push(`| Toplam Token | ${formatTokens(totalInput + totalOutput)} |`);
  lines.push("");

  // Model dağılımı
  if (modelTotals.length > 0) {
    lines.push("## 🤖 Model Bazlı Dağılım");
    lines.push("");
    lines.push("| Model | Input | Cache | Output | Maliyet | Oran |");
    lines.push("|-------|-------|-------|--------|---------|------|");
    for (const r of modelTotals as any[]) {
      const pct = totalCost > 0 ? Math.round(Number(r.cost_cents)/totalCost*100) : 0;
      lines.push(`| ${r.model} | ${formatTokens(Number(r.input_tokens))} | ${formatTokens(Number(r.cached_tokens))} | ${formatTokens(Number(r.output_tokens))} | ${formatMoney(Number(r.cost_cents))} | ${bar(pct, 100, 10)} ${pct}% |`);
    }
    lines.push("");
  }

  // Adapter dağılımı
  const costSummary = await getCostSummary(24);
  const byAdapter: Record<string, number> = {};
  for (const r of costSummary as any[]) {
    const k = r.adapter_type ?? "unknown";
    byAdapter[k] = (byAdapter[k] ?? 0) + Number(r.cost_cents);
  }
  if (Object.keys(byAdapter).length > 0) {
    lines.push("## 🔌 Adapter Bazlı Dağılım");
    lines.push("");
    lines.push("| Adapter | Maliyet |");
    lines.push("|---------|---------|");
    for (const [k, v] of Object.entries(byAdapter).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${k} | ${formatMoney(v)} |`);
    }
    lines.push("");
  }

  // En pahalı 10 agent
  const agentCosts = await getAgentCosts(24);
  if (agentCosts.length > 0) {
    lines.push("## 🏆 En Pahalı 10 Agent");
    lines.push("");
    lines.push("| Agent | Model | Runs | Maliyet |");
    lines.push("|-------|-------|------|---------|");
    for (const r of (agentCosts as any[]).slice(0, 10)) {
      lines.push(`| ${r.agent_name} | ${r.model ?? "-"} | ${r.run_count} | ${formatMoney(Number(r.cost_cents))} |`);
    }
    lines.push("");
  }

  // Heartbeat stats
  const hbStats = await getHeartbeatStats(24);
  if (hbStats.length > 0) {
    lines.push("## ⏱️ Heartbeat İstatistikleri (24h)");
    lines.push("");
    lines.push("| Durum | Sayı | Ort. Token | Toplam Token |");
    lines.push("|-------|------|------------|-------------|");
    for (const r of hbStats as any[]) {
      lines.push(`| ${r.status} | ${r.count} | ${formatTokens(Math.round(Number(r.avg_tokens ?? 0)))} | ${formatTokens(Number(r.total_tokens ?? 0))} |`);
    }
    const total = hbStats.reduce((s: number, r: any) => s + Number(r.count), 0);
    const skipped = hbStats.find((r: any) => r.status === "skipped");
    const skipRate = total > 0 && skipped ? Math.round(Number(skipped.count)/total*100) : 0;
    lines.push(`> Skip oranı: **${skipRate}%** (${skipped?.count ?? 0}/${total} çalışma atlandı — token tasarrufu)`);
    lines.push("");
  }

  return lines.join("\n");
}

async function generateWeeklyReport(): Promise<string> {
  const now = new Date();
  const lines: string[] = [];

  lines.push(`# 📈 Haftalık Token Raporu — ${weekStr(now)}`);
  lines.push(`> Oluşturulma: ${now.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}`);
  lines.push(`> Kapsam: Son 7 gün`);
  lines.push("");

  // 7 günlük trend
  const trend = await getDailyTrend();
  if (trend.length > 0) {
    const maxCost = Math.max(...(trend as any[]).map((r: any) => Number(r.cost_cents)));
    lines.push("## 📅 7 Günlük Trend");
    lines.push("");
    lines.push("| Gün | Maliyet | Token | Grafik |");
    lines.push("|-----|---------|-------|--------|");
    for (const r of trend as any[]) {
      lines.push(`| ${r.day} | ${formatMoney(Number(r.cost_cents))} | ${formatTokens(Number(r.total_tokens))} | ${bar(Number(r.cost_cents), maxCost, 15)} |`);
    }
    const totalWeeklyCost = (trend as any[]).reduce((s: number, r: any) => s + Number(r.cost_cents), 0);
    lines.push(`> **Haftalık Toplam: ${formatMoney(totalWeeklyCost)}** | Günlük Ortalama: ${formatMoney(Math.round(totalWeeklyCost / Math.max(trend.length, 1)))}`);
    lines.push("");
  }

  // Model detayları (7 günlük)
  const modelTotals = await getModelTotals(168);
  if (modelTotals.length > 0) {
    const totalCost = modelTotals.reduce((s: number, r: any) => s + Number(r.cost_cents), 0);
    lines.push("## 🤖 Model Detayları (7 Gün)");
    lines.push("");
    lines.push("| Model | Input Token | Cache Token | Output Token | Maliyet | % |");
    lines.push("|-------|------------|------------|-------------|---------|---|");
    for (const r of modelTotals as any[]) {
      const pct = totalCost > 0 ? Math.round(Number(r.cost_cents)/totalCost*100) : 0;
      lines.push(`| ${r.model} | ${formatTokens(Number(r.input_tokens))} | ${formatTokens(Number(r.cached_tokens))} | ${formatTokens(Number(r.output_tokens))} | ${formatMoney(Number(r.cost_cents))} | ${pct}% |`);
    }
    lines.push("");
  }

  // Tüm agentlar A'dan Z'ye (haftalık)
  const agentCosts = await getAgentCosts(168);
  if (agentCosts.length > 0) {
    const totalCost = agentCosts.reduce((s: number, r: any) => s + Number(r.cost_cents), 0);
    lines.push("## 🗂️ Tüm Agentlar — Haftalık Maliyet (A'dan Z'ye)");
    lines.push("");
    lines.push("| # | Agent | Adapter | Model | Runs | Input | Output | Maliyet |");
    lines.push("|---|-------|---------|-------|------|-------|--------|---------|");
    const sorted = [...agentCosts as any[]].sort((a, b) => a.agent_name.localeCompare(b.agent_name, "tr"));
    sorted.forEach((r: any, i: number) => {
      lines.push(`| ${i+1} | ${r.agent_name} | ${r.adapter_type ?? "-"} | ${r.model ?? "-"} | ${r.run_count} | ${formatTokens(Number(r.input_tokens))} | ${formatTokens(Number(r.output_tokens))} | ${formatMoney(Number(r.cost_cents))} |`);
    });
    lines.push(`> **Toplam: ${formatMoney(totalCost)}** (${agentCosts.length} agent)`);
    lines.push("");
  }

  // En pahalı 20 run
  const topRuns = await getTopExpensiveRuns(20);
  if (topRuns.length > 0) {
    lines.push("## 💸 En Maliyetli 20 Run (7 Gün)");
    lines.push("");
    lines.push("| Agent | Adapter | Tarih | Input | Output | Maliyet | Session Reuse |");
    lines.push("|-------|---------|-------|-------|--------|---------|---------------|");
    for (const r of topRuns as any[]) {
      const date = r.started_at ? new Date(r.started_at).toLocaleString("tr-TR", {timeZone:"Europe/Istanbul"}).slice(0,16) : "-";
      lines.push(`| ${r.agent_name} | ${r.adapter_type ?? "-"} | ${date} | ${formatTokens(Number(r.input_tokens ?? 0))} | ${formatTokens(Number(r.output_tokens ?? 0))} | ${formatMoney(Number(r.cost_cents ?? 0))} | ${r.session_reused ? "✅" : "❌"} |`);
    }
    lines.push("");
  }

  // Heartbeat stats (7 günlük)
  const hbStats = await getHeartbeatStats(168);
  if (hbStats.length > 0) {
    lines.push("## ⏱️ Heartbeat İstatistikleri (7 Gün)");
    lines.push("");
    lines.push("| Durum | Sayı | Ort. Token |");
    lines.push("|-------|------|------------|");
    for (const r of hbStats as any[]) {
      lines.push(`| ${r.status} | ${r.count} | ${formatTokens(Math.round(Number(r.avg_tokens ?? 0)))} |`);
    }
    const total = hbStats.reduce((s: number, r: any) => s + Number(r.count), 0);
    const skipped = hbStats.find((r: any) => r.status === "skipped");
    const skipRate = total > 0 && skipped ? Math.round(Number(skipped.count)/total*100) : 0;
    const sessionReused = hbStats.find((r: any) => r.status === "completed");
    lines.push(`> Skip oranı: **${skipRate}%** | Toplam run: ${total}`);
    lines.push("");
  }

  // Günlük raporu da dahil et
  lines.push("---");
  lines.push("");
  lines.push(await generateDailyReport());

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔍 Token raporu oluşturuluyor (${MODE})...`);

  try {
    mkdirSync(VAULT_DIR, { recursive: true });
  } catch {}

  const now = new Date();
  let content: string;
  let filename: string;

  if (MODE === "weekly") {
    content = await generateWeeklyReport();
    filename = `${weekStr(now)}-weekly.md`;
  } else {
    content = await generateDailyReport();
    filename = `${isoDate(now)}-daily.md`;
  }

  const filepath = join(VAULT_DIR, filename);
  writeFileSync(filepath, content, "utf-8");
  console.log(`✅ Rapor kaydedildi: ${filepath}`);

  // Konsol özeti
  const lines = content.split("\n");
  const summary = lines.slice(0, Math.min(40, lines.length)).join("\n");
  console.log("\n" + summary);

  await sql.end();
}

main().catch((e) => {
  console.error("❌ Rapor hatası:", e);
  process.exit(1);
});
