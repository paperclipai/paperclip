import { useState } from "react";
import type { OpenclawCronJob } from "../api/heartbeats";

// ─── COLOURS ─────────────────────────────────────────────────────────────────
const PURPLE = { bg: "#EEEDFE", stroke: "#534AB7", text: "#3C3489" };
const TEAL   = { bg: "#E1F5EE", stroke: "#0F6E56", text: "#085041" };
const AMBER  = { bg: "#FAEEDA", stroke: "#854F0B", text: "#633806" };
const GRAY   = { bg: "#F1EFE8", stroke: "#5F5E5A", text: "#444441" };
const BLUE   = { bg: "#E6F1FB", stroke: "#185FA5", text: "#0C447C" };
const RED    = { bg: "#FCEBEB", stroke: "#A32D2D", text: "#791F1F" };

// ─── TYPES ───────────────────────────────────────────────────────────────────
type DotStatus = "ok" | "warn" | "error" | "dead";

export interface AgentStatuses {
  felix?: DotStatus;
  katya?: DotStatus;
}

export interface PelergyDiagramsProps {
  cronJobs?: OpenclawCronJob[];
  agentStatuses?: AgentStatuses;
}

// ─── LIVE DATA HELPERS ────────────────────────────────────────────────────────
function cronDotStatus(job: OpenclawCronJob): DotStatus {
  if (!job.enabled) return "dead";
  if (job.consecutiveErrors >= 2) return "error";
  if (job.consecutiveErrors >= 1 || job.lastRunStatus === "error" || job.lastRunStatus === "failed")
    return "warn";
  return "ok";
}

function lookupCron(
  baseName: string,
  cronJobs: OpenclawCronJob[] | undefined,
): { status: DotStatus; consecutiveErrors: number } {
  if (!cronJobs?.length) return { status: "ok", consecutiveErrors: 0 };
  const needle = baseName.toLowerCase().replace(/\s+/g, "-");
  const match = cronJobs.find((j) => {
    const jn = j.name.toLowerCase();
    return jn.includes(needle) || needle.includes(jn.replace(/^(felix|katya)-/, ""));
  });
  if (!match) return { status: "ok", consecutiveErrors: 0 };
  return { status: cronDotStatus(match), consecutiveErrors: match.consecutiveErrors };
}

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
function LiveDot({ status }: { status: DotStatus }) {
  const colors = { ok: "#1D9E75", warn: "#EF9F27", error: "#E24B4A", dead: "#888780" };
  return (
    <circle
      r={5}
      fill={colors[status]}
      style={status !== "dead" ? { animation: "pulse 1.8s ease-in-out infinite" } : {}}
    />
  );
}

function Arrow({
  d,
  color = "#888780",
  animated = false,
}: {
  d: string;
  color?: string;
  animated?: boolean;
}) {
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={0.8}
      strokeDasharray={animated ? "5 3" : undefined}
      style={animated ? { animation: "dash 1.2s linear infinite" } : undefined}
      markerEnd="url(#arrowHead)"
    />
  );
}

// ─── ORG DIAGRAM ─────────────────────────────────────────────────────────────
function OrgDiagram({ agentStatuses }: { agentStatuses?: AgentStatuses }) {
  const felixStatus = agentStatuses?.felix ?? "ok";
  const katyaStatus = agentStatuses?.katya ?? "ok";

  return (
    <svg width="100%" viewBox="0 0 680 400" style={{ overflow: "visible" }}>
      <defs>
        <marker
          id="arrowHead"
          viewBox="0 0 10 10"
          refX={8}
          refY={5}
          markerWidth={6}
          markerHeight={6}
          orient="auto-start-reverse"
        >
          <path
            d="M2 1L8 5L2 9"
            fill="none"
            stroke="context-stroke"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}} @keyframes dash{to{stroke-dashoffset:-14}}`}</style>

      {/* Mike */}
      <rect x={240} y={16} width={200} height={52} rx={8} fill={GRAY.bg} stroke={GRAY.stroke} strokeWidth={0.5} />
      <text x={340} y={37} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={GRAY.text}>Mike</text>
      <text x={340} y={55} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={GRAY.stroke}>Human operator — all instructions</text>

      <line x1={340} y1={68} x2={340} y2={108} stroke="#378ADD" strokeWidth={1} markerEnd="url(#arrowHead)" />

      {/* Felix */}
      <rect x={230} y={108} width={220} height={60} rx={8} fill={PURPLE.bg} stroke={PURPLE.stroke} strokeWidth={0.5} />
      <g transform="translate(250,124)"><LiveDot status={felixStatus} /></g>
      <text x={352} y={130} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={PURPLE.text}>Felix</text>
      <text x={352} y={150} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={PURPLE.stroke}>CEO &amp; Chief of Staff · Topic 1</text>

      <Arrow d="M250 168 L130 210" color="#1D9E75" animated />
      <Arrow d="M430 168 L550 210" color="#888780" />
      <Arrow d="M305 168 L285 210" color="#1D9E75" animated />
      <Arrow d="M375 168 L395 210" color="#888780" />

      {/* Katya */}
      <rect x={50} y={210} width={160} height={60} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <g transform="translate(68,226)"><LiveDot status={katyaStatus} /></g>
      <text x={140} y={232} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Katya</text>
      <text x={140} y={252} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>Marketing · Topic 104</text>

      {/* handoffs.md */}
      <rect x={250} y={210} width={180} height={60} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={340} y={232} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={AMBER.text}>handoffs.md</text>
      <text x={340} y={252} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={AMBER.stroke}>Shared coordination layer</text>

      {/* Quant (future) */}
      <rect x={460} y={210} width={160} height={60} rx={8} fill={GRAY.bg} stroke={GRAY.stroke} strokeWidth={0.5} strokeDasharray="5 3" opacity={0.4} />
      <g transform="translate(478,226)"><LiveDot status="dead" /></g>
      <text x={548} y={232} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={GRAY.text}>Quant</text>
      <text x={548} y={252} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={GRAY.stroke}>Not deployed</text>

      <Arrow d="M130 270 L250 312" color="#1D9E75" animated />
      <Arrow d="M340 270 L340 312" color="#1D9E75" animated />
      <path d="M210 240 L248 240" fill="none" stroke="#1D9E75" strokeWidth={0.5} strokeDasharray="3 2" markerEnd="url(#arrowHead)" />

      {/* Approvals board */}
      <rect x={100} y={312} width={150} height={44} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={175} y={334} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={AMBER.text}>Approvals board</text>

      {/* Builder (future) */}
      <rect x={270} y={312} width={140} height={44} rx={8} fill={GRAY.bg} stroke={GRAY.stroke} strokeWidth={0.5} strokeDasharray="5 3" opacity={0.4} />
      <text x={340} y={334} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={GRAY.text}>Builder</text>

      {/* Legend */}
      <g transform="translate(546,314)"><LiveDot status="ok" /></g>
      <text x={558} y={318} dominantBaseline="central" fontSize={12} fill={GRAY.text}>live</text>
      <circle cx={600} cy={318} r={5} fill="#888780" />
      <text x={612} y={318} dominantBaseline="central" fontSize={12} fill={GRAY.text}>offline</text>

      <text x={340} y={385} textAnchor="middle" fontSize={12} fill="#888780">
        Talk only to Felix — he coordinates Katya and future agents via handoffs.md
      </text>
    </svg>
  );
}

// ─── PIPELINE DIAGRAM ────────────────────────────────────────────────────────
function PipelineDiagram() {
  return (
    <svg width="100%" viewBox="0 0 680 560" style={{ overflow: "visible" }}>
      <defs>
        <marker id="arrowHead" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <style>{`@keyframes dash{to{stroke-dashoffset:-14}}`}</style>

      {/* Column headers */}
      {(
        [
          ["Sources", 75],
          ["Katya drafts", 235],
          ["Mike approves", 415],
          ["Publishes", 590],
        ] as [string, number][]
      ).map(([label, x]) => (
        <text key={String(x)} x={x} y={20} textAnchor="middle" fontSize={12} fill="#888780">{label}</text>
      ))}
      <line x1={120} y1={24} x2={155} y2={24} stroke="#ccc" strokeWidth={0.5} />
      <line x1={305} y1={24} x2={345} y2={24} stroke="#ccc" strokeWidth={0.5} />
      <line x1={500} y1={24} x2={545} y2={24} stroke="#ccc" strokeWidth={0.5} />

      {/* Sources */}
      {(
        [
          ["Mike's ideas", 38],
          ["RSS feeds", 82],
          ["SQL hero projects", 126],
          ["Keyword gaps", 170],
          ["Competitor gaps", 214],
        ] as [string, number][]
      ).map(([label, y]) => (
        <g key={String(y)}>
          <rect x={10} y={y} width={120} height={36} rx={6} fill={GRAY.bg} stroke={GRAY.stroke} strokeWidth={0.5} />
          <text x={70} y={y + 18} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={GRAY.text}>{label}</text>
        </g>
      ))}

      {/* Arrows from sources to tiers */}
      {([[38 + 18, 130], [82 + 18, 140], [126 + 18, 150], [170 + 18, 230], [214 + 18, 240]] as [number, number][]).map(([sy, ty], i) => (
        <Arrow key={i} d={`M130 ${sy} L165 ${ty}`} color="#888780" animated />
      ))}
      {([[38 + 18, 310], [82 + 18, 318], [126 + 18, 326]] as [number, number][]).map(([sy, ty], i) => (
        <Arrow key={"t2" + i} d={`M130 ${sy} L165 ${ty}`} color="#888780" animated />
      ))}
      {([[170 + 18, 398], [214 + 18, 406]] as [number, number][]).map(([sy, ty], i) => (
        <Arrow key={"t3" + i} d={`M130 ${sy} L165 ${ty}`} color="#888780" animated />
      ))}

      {/* Tier 1 */}
      <rect x={165} y={116} width={120} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={225} y={137} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Tier 1</text>
      <text x={225} y={156} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>Blog post</text>
      <Arrow d="M285 144 L345 144" color="#0F6E56" animated />
      <rect x={345} y={116} width={110} height={56} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={400} y={137} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={AMBER.text}>Mike</text>
      <text x={400} y={156} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={AMBER.stroke}>Approves</text>
      <Arrow d="M455 144 L515 144" color="#854F0B" animated />
      <rect x={515} y={116} width={130} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={580} y={137} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Publishes</text>
      <text x={580} y={156} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>pelergy.com</text>

      {/* Tier 2 */}
      <rect x={165} y={296} width={120} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={225} y={317} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Tier 2</text>
      <text x={225} y={336} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>LinkedIn + X posts</text>
      <Arrow d="M285 324 L345 324" color="#0F6E56" animated />
      <rect x={345} y={296} width={110} height={56} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={400} y={317} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={AMBER.text}>Mike</text>
      <text x={400} y={336} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={AMBER.stroke}>Approves</text>
      <Arrow d="M455 324 L515 324" color="#854F0B" animated />
      <rect x={515} y={296} width={130} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={580} y={317} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Publishes</text>
      <text x={580} y={336} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>LinkedIn + X</text>

      {/* Tier 3 */}
      <rect x={165} y={376} width={120} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={225} y={397} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Tier 3</text>
      <text x={225} y={416} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>Outreach emails</text>
      <Arrow d="M285 404 L345 404" color="#0F6E56" animated />
      <rect x={345} y={376} width={110} height={56} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={400} y={397} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={AMBER.text}>Mike</text>
      <text x={400} y={416} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={AMBER.stroke}>Each individually</text>
      <Arrow d="M455 404 L515 404" color="#854F0B" animated />
      <rect x={515} y={376} width={130} height={56} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={580} y={397} textAnchor="middle" dominantBaseline="central" fontSize={14} fontWeight={500} fill={TEAL.text}>Sends</text>
      <text x={580} y={416} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>On approval only</text>

      {/* LinkedIn future source */}
      <rect x={10} y={376} width={120} height={36} rx={6} fill={GRAY.bg} stroke={GRAY.stroke} strokeWidth={0.5} strokeDasharray="4 3" opacity={0.5} />
      <text x={70} y={394} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={GRAY.text}>LinkedIn (future)</text>
      <Arrow d="M130 394 L163 404" color="#888780" />

      {/* Divider */}
      <line x1={20} y1={454} x2={660} y2={454} stroke="#ccc" strokeWidth={0.5} strokeDasharray="6 4" />
      <text x={340} y={468} textAnchor="middle" fontSize={12} fill="#888780">
        DB campaign — additive track, parallel to evergreen, does not displace primary schedule
      </text>

      {/* DB Campaign */}
      <rect x={10} y={480} width={120} height={48} rx={8} fill={BLUE.bg} stroke={BLUE.stroke} strokeWidth={0.5} />
      <text x={70} y={500} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={500} fill={BLUE.text}>DB-CAMPAIGN</text>
      <text x={70} y={516} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={BLUE.stroke}>6 blogs + 12 social</text>
      <Arrow d="M130 504 L163 504" color="#185FA5" animated />
      <rect x={165} y={480} width={120} height={48} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} />
      <text x={225} y={500} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={500} fill={TEAL.text}>Katya drafts</text>
      <text x={225} y={516} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={TEAL.stroke}>3-week cadence</text>
      <Arrow d="M285 504 L345 504" color="#0F6E56" animated />
      <rect x={345} y={480} width={110} height={48} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
      <text x={400} y={500} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={500} fill={AMBER.text}>Mike</text>
      <text x={400} y={516} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={AMBER.stroke}>One per asset</text>
      <Arrow d="M455 504 L515 504" color="#854F0B" animated />
      <rect x={515} y={480} width={130} height={48} rx={8} fill={BLUE.bg} stroke={BLUE.stroke} strokeWidth={0.5} />
      <text x={580} y={500} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={500} fill={BLUE.text}>Publishes</text>
      <text x={580} y={516} textAnchor="middle" dominantBaseline="central" fontSize={12} fill={BLUE.stroke}>DB-CAMPAIGN prefix</text>
    </svg>
  );
}

// ─── CRON DIAGRAM ─────────────────────────────────────────────────────────────
// Static metadata: display names (base, without error annotation) + schedule time
const FELIX_CRON_DEFS = [
  { baseName: "daily-note-seed",        time: "06:50" },
  { baseName: "morning-notes-audit",    time: "08:05" },
  { baseName: "publish-handoff-sweep",  time: "08:30" },
  { baseName: "blocker-triage",         time: "08:30" },
  { baseName: "sprint-checkin",         time: "09:00+17:00 UK" },
  { baseName: "memory-integrity",       time: "10:00+15:00" },
  { baseName: "nightly-memory-dive",    time: "21:00" },
  { baseName: "nightly-improvement",    time: "22:30" },
] as const;

const KATYA_CRON_DEFS = [
  { baseName: "daily-note-seed-midnight",    time: "00:00" },
  { baseName: "rss-check-0700",             time: "07:00" },
  { baseName: "cron-watchdog",              time: "08:07" },
  { baseName: "content-calendar-autonomy",  time: "08:00" },
  { baseName: "memory-integrity",           time: "10:00+15:00" },
  { baseName: "pelergy-marketing",          time: "*/30" },
  { baseName: "approval-guard",             time: "hourly" },
  { baseName: "nightly-memory-dive",        time: "21:30" },
  { baseName: "nightly-improvement",        time: "23:05" },
  { baseName: "daily-notes",               time: "23:10" },
  { baseName: "weekly-voice-kpi",           time: "Fri 16:30" },
] as const;

function CronDiagram({ cronJobs }: { cronJobs?: OpenclawCronJob[] }) {
  // Resolve live status for each cron entry
  const felixCrons = FELIX_CRON_DEFS.map((def) => {
    const { status, consecutiveErrors } = lookupCron(def.baseName, cronJobs);
    const name =
      consecutiveErrors > 0
        ? `${def.baseName} ⚠ ${consecutiveErrors}err`
        : def.baseName;
    return { name, time: def.time, status };
  });

  const katyaCrons = KATYA_CRON_DEFS.map((def) => {
    const { status, consecutiveErrors } = lookupCron(def.baseName, cronJobs);
    const name =
      consecutiveErrors > 0
        ? `${def.baseName} ⚠ ${consecutiveErrors}err`
        : def.baseName;
    return { name, time: def.time, status };
  });

  // Top erroring jobs for status alert panel
  const topErrors = cronJobs
    ? [...cronJobs]
        .filter((j) => j.consecutiveErrors >= 2)
        .sort((a, b) => b.consecutiveErrors - a.consecutiveErrors)
        .slice(0, 2)
    : null;

  const dotColors = { ok: "#1D9E75", warn: "#EF9F27", error: "#E24B4A", dead: "#888780" };
  const rowH = 22;
  const felixH = felixCrons.length * rowH + 20;
  const katyaH = katyaCrons.length * rowH + 20;
  const sharedOutputs = ["Daily notes", "handoffs.md", "~/life/ PARA", "Approvals board", "summary.md"];
  const totalH = Math.max(felixH, katyaH) + 200;

  return (
    <svg width="100%" viewBox={`0 0 680 ${totalH}`} style={{ overflow: "visible" }}>
      <defs>
        <marker id="arrowHead" viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}} @keyframes dash{to{stroke-dashoffset:-14}}`}</style>

      {/* Column headers */}
      <text x={150} y={18} textAnchor="middle" fontSize={12} fill="#888780">Felix crons</text>
      <text x={380} y={18} textAnchor="middle" fontSize={12} fill="#888780">Katya crons</text>
      <text x={590} y={18} textAnchor="middle" fontSize={12} fill="#888780">Shared outputs</text>
      <line x1={230} y1={22} x2={260} y2={22} stroke="#ccc" strokeWidth={0.5} />
      <line x1={480} y1={22} x2={520} y2={22} stroke="#ccc" strokeWidth={0.5} />

      {/* Felix container */}
      <rect x={10} y={28} width={230} height={felixH} rx={8} fill={PURPLE.bg} stroke={PURPLE.stroke} strokeWidth={0.5} opacity={0.6} />
      {felixCrons.map((c, i) => (
        <g key={c.name}>
          <circle
            cx={26}
            cy={28 + 14 + i * rowH}
            r={4}
            fill={dotColors[c.status]}
            style={c.status !== "dead" ? { animation: "pulse 1.8s ease-in-out infinite" } : {}}
          />
          <text x={36} y={28 + 14 + i * rowH} dominantBaseline="central" fontSize={11} fill={PURPLE.text}>
            {c.name}
          </text>
          <text x={230} y={28 + 14 + i * rowH} textAnchor="end" dominantBaseline="central" fontSize={10} fill={PURPLE.stroke}>
            {c.time}
          </text>
        </g>
      ))}

      {/* Katya container */}
      <rect x={255} y={28} width={240} height={katyaH} rx={8} fill={TEAL.bg} stroke={TEAL.stroke} strokeWidth={0.5} opacity={0.6} />
      {katyaCrons.map((c, i) => (
        <g key={c.name}>
          <circle
            cx={271}
            cy={28 + 14 + i * rowH}
            r={4}
            fill={dotColors[c.status]}
            style={c.status !== "dead" ? { animation: "pulse 1.8s ease-in-out infinite" } : {}}
          />
          <text
            x={281}
            y={28 + 14 + i * rowH}
            dominantBaseline="central"
            fontSize={11}
            fill={c.status === "error" ? RED.text : TEAL.text}
          >
            {c.name}
          </text>
          <text x={488} y={28 + 14 + i * rowH} textAnchor="end" dominantBaseline="central" fontSize={10} fill={TEAL.stroke}>
            {c.time}
          </text>
        </g>
      ))}

      {/* Shared outputs */}
      {sharedOutputs.map((label, i) => {
        const y = 36 + i * 44;
        return (
          <g key={label}>
            <rect x={520} y={y} width={150} height={36} rx={8} fill={AMBER.bg} stroke={AMBER.stroke} strokeWidth={0.5} />
            <text x={595} y={y + 18} textAnchor="middle" dominantBaseline="central" fontSize={13} fontWeight={500} fill={AMBER.text}>
              {label}
            </text>
            <path
              d={`M496 ${28 + 14 + i * 35} L518 ${y + 18}`}
              fill="none"
              stroke="#888780"
              strokeWidth={0.5}
              strokeDasharray="3 2"
              markerEnd="url(#arrowHead)"
            />
          </g>
        );
      })}

      {/* Overlap + status alerts */}
      {(() => {
        const y = Math.max(felixH, katyaH) + 50;

        // Dynamic error alert text
        const alert1 =
          topErrors && topErrors[0]
            ? `${topErrors[0].name}: ${topErrors[0].consecutiveErrors} consecutive errors`
            : cronJobs
            ? "No critical cron errors"
            : "Loading cron status…";
        const alert2 =
          topErrors && topErrors[1]
            ? `${topErrors[1].name}: ${topErrors[1].consecutiveErrors} errors — fix first`
            : "";
        const hasErrors = (topErrors?.length ?? 0) > 0;

        return (
          <>
            <line x1={10} y1={y} x2={670} y2={y} stroke="#ccc" strokeWidth={0.5} strokeDasharray="6 4" />
            <text x={340} y={y + 18} textAnchor="middle" fontSize={12} fill="#888780">
              Overlap: 3 jobs watch for the same Paperclip failures — consolidate when stable
            </text>

            {(
              [
                ["katya-cron-watchdog", 30, AMBER],
                ["approval-integrity-guard", 220, RED],
                ["felix-paperclip-blocker-triage", 420, AMBER],
              ] as [string, number, typeof AMBER][]
            ).map(([label, x, col]) => (
              <g key={label}>
                <rect
                  x={x}
                  y={y + 30}
                  width={x === 220 ? 190 : 180}
                  height={32}
                  rx={6}
                  fill={col.bg}
                  stroke={col.stroke}
                  strokeWidth={0.5}
                />
                <text
                  x={x + (x === 220 ? 95 : 90)}
                  y={y + 46}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fill={col.text}
                >
                  {label}
                </text>
              </g>
            ))}

            {/* Live error summary */}
            <rect
              x={10}
              y={y + 76}
              width={310}
              height={44}
              rx={6}
              fill={hasErrors ? RED.bg : TEAL.bg}
              stroke={hasErrors ? RED.stroke : TEAL.stroke}
              strokeWidth={0.5}
            />
            <text
              x={165}
              y={y + 93}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={12}
              fill={hasErrors ? RED.text : TEAL.text}
            >
              {alert1}
            </text>
            {alert2 && (
              <text
                x={165}
                y={y + 109}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fill={RED.text}
              >
                {alert2}
              </text>
            )}

            <rect x={330} y={y + 76} width={340} height={44} rx={6} fill="#FAEEDA" stroke="#854F0B" strokeWidth={0.5} />
            <text x={500} y={y + 93} textAnchor="middle" dominantBaseline="central" fontSize={12} fill="#633806">
              4 Katya jobs misassigned to Felix agent
            </text>
            <text x={500} y={y + 109} textAnchor="middle" dominantBaseline="central" fontSize={12} fill="#633806">
              reassign agentId to katya once P1 resolved
            </text>
          </>
        );
      })()}
    </svg>
  );
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
type Tab = "org" | "pipeline" | "crons";

export default function PelergyDiagrams({ cronJobs, agentStatuses }: PelergyDiagramsProps) {
  const [tab, setTab] = useState<Tab>("org");

  // Error count: jobs with 2+ consecutive errors (consistent with ragForCronJob in OpsHealth)
  const errorCount = cronJobs
    ? cronJobs.filter((j) => j.consecutiveErrors >= 2).length
    : 0;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "1rem" }}>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes dash{to{stroke-dashoffset:-14}}
        button:hover{opacity:.8}
      `}</style>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {(["org", "pipeline", "crons"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "7px 14px",
              fontSize: 13,
              border: `0.5px solid ${tab === t ? "#5F5E5A" : "#ccc"}`,
              background: tab === t ? "#F1EFE8" : "transparent",
              borderRadius: 8,
              color: tab === t ? "#2C2C2A" : "#888780",
              cursor: "pointer",
            }}
          >
            {t === "org" ? (
              "Org"
            ) : t === "pipeline" ? (
              "Content pipeline"
            ) : (
              <>
                Cron interactions{" "}
                {errorCount > 0 && (
                  <span
                    style={{
                      background: "#FCEBEB",
                      color: "#A32D2D",
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 6,
                      marginLeft: 4,
                    }}
                  >
                    {errorCount}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      <div style={{ width: "50%" }}>
        {tab === "org"      && <OrgDiagram agentStatuses={agentStatuses} />}
        {tab === "pipeline" && <PipelineDiagram />}
        {tab === "crons"    && <CronDiagram cronJobs={cronJobs} />}
      </div>
    </div>
  );
}
