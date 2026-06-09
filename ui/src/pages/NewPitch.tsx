import { useEffect, useState } from "react";
import { useNavigate, Link } from "@/lib/router";
import { ArrowLeft } from "lucide-react";
import { agnbPitchApi, type PitchAnswers } from "../api/agnbPitch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SELECTS: Record<string, Array<{ v: string; l: string }>> = {
  clientType: [
    { v: "enterprise", l: "Enterprise buyer" },
    { v: "smb", l: "SMB" },
    { v: "investor", l: "Investor" },
  ],
  useCase: [
    { v: "inbound_support", l: "Inbound support" },
    { v: "receptionist", l: "Receptionist / front desk" },
    { v: "outbound_sales", l: "Outbound sales" },
    { v: "collections", l: "Collections / recovery" },
    { v: "scheduling", l: "Scheduling / reminders" },
    { v: "qualification", l: "Lead qualification" },
    { v: "renewals", l: "Renewals / retention" },
    { v: "surveys", l: "Surveys / feedback" },
  ],
  region: [
    { v: "india", l: "India (INR)" },
    { v: "intl", l: "US & Intl (USD)" },
  ],
  format: [
    { v: "live", l: "Live pitch (sparse, I present)" },
    { v: "leavebehind", l: "Leave-behind (dense, reads alone)" },
  ],
  length: [
    { v: "short", l: "Short (~10 min)" },
    { v: "standard", l: "Standard (~20 min)" },
    { v: "deep", l: "Deep dive (~30 min)" },
  ],
  stage: [
    { v: "cold", l: "Cold intro / first meeting" },
    { v: "eval", l: "Active evaluation" },
    { v: "closing", l: "Final decision / closing" },
  ],
};

const FIELD = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";

export function NewPitch() {
  const nav = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(
    () => setBreadcrumbs([{ label: "Pitch decks", href: "/pitch" }, { label: "New" }]),
    [setBreadcrumbs],
  );

  const [a, setA] = useState<PitchAnswers>({
    clientName: "",
    clientWebsite: "",
    clientType: "enterprise",
    useCase: "inbound_support",
    industry: "",
    region: "intl",
    format: "live",
    length: "standard",
    primaryMetric: "",
    monthlyCalls: "",
    competitor: "",
    stage: "eval",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof PitchAnswers, v: string) => setA((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!a.clientName.trim()) {
      setErr("Client name required");
      return;
    }
    if (!a.industry.trim()) {
      setErr("Industry required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const id = await agnbPitchApi.generate({ ...a, clientName: a.clientName.trim() });
      nav(`/pitch/${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
      setBusy(false);
    }
  };

  const Sel = ({ k }: { k: keyof typeof SELECTS }) => (
    <select value={a[k as keyof PitchAnswers]} onChange={(e) => set(k as keyof PitchAnswers, e.target.value)} className={FIELD}>
      {SELECTS[k].map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
  const lbl = (s: string) => <label className="text-xs text-muted-foreground">{s}</label>;

  return (
    <div className="space-y-4">
      <Link to="/pitch" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to pitch decks
      </Link>
      <h1 className="text-lg font-semibold">New pitch deck</h1>
      <div className="grid max-w-2xl gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Client / company name")}<Input value={a.clientName} onChange={(e) => set("clientName", e.target.value)} placeholder="Acme Logistics" /></div>
          <div>{lbl("Company website (optional)")}<Input value={a.clientWebsite} onChange={(e) => set("clientWebsite", e.target.value)} placeholder="acme.com" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Audience")}<Sel k="clientType" /></div>
          <div>{lbl("Primary use case")}<Sel k="useCase" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Industry / vertical")}<Input value={a.industry} onChange={(e) => set("industry", e.target.value)} placeholder="3PL / logistics" /></div>
          <div>{lbl("Region")}<Sel k="region" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Format")}<Sel k="format" /></div>
          <div>{lbl("Length")}<Sel k="length" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Primary metric")}<Input value={a.primaryMetric} onChange={(e) => set("primaryMetric", e.target.value)} placeholder="cost/call, pickup rate, CSAT…" /></div>
          <div>{lbl("Monthly call volume")}<Input value={a.monthlyCalls} onChange={(e) => set("monthlyCalls", e.target.value)} placeholder="8000" inputMode="numeric" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>{lbl("Competitor evaluated (optional)")}<Input value={a.competitor} onChange={(e) => set("competitor", e.target.value)} placeholder="blank if none" /></div>
          <div>{lbl("Decision stage")}<Sel k="stage" /></div>
        </div>
        <div>{lbl("Anything else to weave in? (optional)")}<textarea value={a.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={FIELD} /></div>

        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={busy}>{busy ? "Generating… (~30–60s)" : "Generate deck"}</Button>
          {busy && <span className="text-xs text-muted-foreground">Calling local Claude — keep this tab open.</span>}
        </div>
        <p className="text-[11px] text-muted-foreground/70">
          Generation runs on your machine via the Claude CLI. On the deployed server it returns a notice instead.
        </p>
      </div>
    </div>
  );
}
