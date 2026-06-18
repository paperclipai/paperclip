import { Router } from "express";

const ACTIONS: Record<string, { approval_status: string; status: string }> = {
  approve: { approval_status: "approved", status: "approved_human_review" },
  reject: { approval_status: "rejected", status: "rejected_human_review" },
  mark_uploaded: { approval_status: "uploaded_manual", status: "uploaded_manual" },
};

function base(raw: string | undefined) {
  const v = raw?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}
function cfg() {
  return { url: base(process.env.SUPABASE_URL), key: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? null };
}
function headers(key: string, prefer?: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) };
}
function str(v: unknown) { return typeof v === "string" && v.trim() ? v.trim() : null; }
function rec(v: unknown): Record<string, unknown> { return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
function arr(v: unknown): Array<Record<string, unknown>> { return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []; }
function safeJobId(v: unknown) { const id = str(v); return id && /^[A-Za-z0-9._:-]{6,96}$/.test(id) ? id : null; }
function fileUrl(files: Array<Record<string, unknown>>, name: string) {
  const found = files.find((f) => JSON.stringify(f).toLowerCase().includes(name));
  return str(found?.absoluteUrl) ?? str(found?.url);
}

async function readJobs(limit: number) {
  const { url, key } = cfg();
  if (!url || !key) throw new Error("Supabase is not configured.");
  const r = await fetch(`${url}/rest/v1/sink_dink_jobs?select=*&order=created_at.desc&limit=${limit}`, { headers: headers(key) });
  const t = await r.text();
  if (!r.ok) throw new Error(t);
  return JSON.parse(t) as Array<Record<string, unknown>>;
}

async function updateJob(jobId: string, action: string) {
  const selected = ACTIONS[action];
  if (!selected) throw new Error("Invalid action.");
  const { url, key } = cfg();
  if (!url || !key) throw new Error("Supabase is not configured.");
  const update = await fetch(`${url}/rest/v1/sink_dink_jobs?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: headers(key, "return=representation"),
    body: JSON.stringify(selected),
  });
  const updateText = await update.text();
  if (!update.ok) throw new Error(updateText);
  await fetch(`${url}/rest/v1/sink_dink_audit_log`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({
      event_type: "artifact_human_review_action",
      payload: { jobId, action, ...selected, publishingBlocked: true, autoPublished: false, at: new Date().toISOString() },
      created_at: new Date().toISOString(),
    }),
  });
  return updateText ? JSON.parse(updateText) : [];
}

function mapJob(row: Record<string, unknown>) {
  const files = arr(row.files);
  const qa = rec(row.qa);
  return {
    jobId: str(row.job_id) ?? str(row.jobId),
    topic: str(row.topic) ?? "SINK/DINK artifact",
    status: str(row.status) ?? "unknown",
    approvalStatus: str(row.approval_status) ?? "pending_human_approval",
    qaScore: typeof qa.score === "number" ? qa.score : null,
    mp4: fileUrl(files, "final_reel.mp4") ?? fileUrl(files, "mp4"),
    cover: fileUrl(files, "cover.png") ?? fileUrl(files, "cover.svg"),
    caption: fileUrl(files, "caption.txt"),
    hashtags: fileUrl(files, "hashtags.txt"),
    script: fileUrl(files, "script.txt"),
    qaReport: fileUrl(files, "qa_report.md"),
    mediaPack: fileUrl(files, "media_pack.json"),
    storyboard: fileUrl(files, "storyboard.json"),
    publishingBlocked: true,
  };
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SINK DINK Review</title><style>
body{margin:0;background:#090b10;color:#f8fafc;font-family:Inter,system-ui,sans-serif;padding:22px}.wrap{max-width:1200px;margin:auto}.top{display:flex;justify-content:space-between;gap:16px;align-items:center}h1{margin:0;font-size:28px}.sub,.status{color:#94a3b8;font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:18px;margin-top:18px}.card{background:#101827;border:1px solid #273449;border-radius:22px;overflow:hidden}.phone{aspect-ratio:9/16;background:#000;display:grid;place-items:center}video{width:100%;height:100%;object-fit:cover}.meta{padding:14px}.topic{font-weight:800;font-size:16px}.badges{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.badge{font-size:11px;padding:5px 8px;border-radius:999px;background:#14351f;color:#86efac}.warn{background:#3a2d0d;color:#fde68a}.links,.actions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.actions{grid-template-columns:repeat(3,1fr);margin-top:10px}a,button{border:1px solid #334155;border-radius:12px;padding:9px;text-align:center;background:#0f172a;color:#dbeafe;text-decoration:none;font-size:12px}button{cursor:pointer;font-weight:700}.ok{color:#bbf7d0}.bad{color:#fecaca}.job{color:#94a3b8;font-size:12px;margin-top:8px;overflow-wrap:anywhere}
</style></head><body><main class="wrap"><div class="top"><div><h1>SINK DINK Review Dashboard</h1><div class="sub">Preview, download, approve, reject, or mark manually uploaded. No auto-posting.</div></div><button id="refresh">Refresh</button></div><div id="status" class="status">Loading...</div><section id="grid" class="grid"></section></main><script>
const grid=document.getElementById('grid'),statusEl=document.getElementById('status');
function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function link(label,url){return url?'<a href="'+encodeURI(url)+'" target="_blank" rel="noopener" download>'+label+'</a>':''}
async function act(jobId,action){statusEl.textContent='Saving action...';const r=await fetch('/api/sink-dink/artifacts/review/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId,action})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Action failed');statusEl.textContent='Saved: '+action;await load();}
function card(x){const v=x.mp4?'<video controls preload="metadata" playsinline src="'+encodeURI(x.mp4)+'"></video>':'No MP4';return '<article class="card"><div class="phone">'+v+'</div><div class="meta"><div class="topic">'+esc(x.topic)+'</div><div class="badges"><span class="badge">QA '+esc(x.qaScore??'-')+'</span><span class="badge">'+esc(x.approvalStatus)+'</span><span class="badge warn">Publishing blocked</span></div><div class="links">'+link('MP4',x.mp4)+link('Cover',x.cover)+link('Caption',x.caption)+link('Hashtags',x.hashtags)+link('Script',x.script)+link('QA Report',x.qaReport)+link('Media Pack',x.mediaPack)+link('Storyboard',x.storyboard)+'</div><div class="actions"><button class="ok" onclick="act(\''+esc(x.jobId)+'\',\'approve\').catch(e=>alert(e.message))">Approve</button><button class="bad" onclick="act(\''+esc(x.jobId)+'\',\'reject\').catch(e=>alert(e.message))">Reject</button><button onclick="act(\''+esc(x.jobId)+'\',\'mark_uploaded\').catch(e=>alert(e.message))">Uploaded</button></div><div class="job">Job: '+esc(x.jobId)+'</div></div></article>'}
async function load(){statusEl.textContent='Loading artifacts...';grid.innerHTML='';try{const r=await fetch('/api/sink-dink/artifacts/review/latest?limit=12');const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Load failed');statusEl.textContent='Loaded '+d.artifacts.length+' artifact(s).';grid.innerHTML=d.artifacts.map(card).join('')||'<p>No artifacts yet.</p>'}catch(e){statusEl.textContent='Failed: '+e.message}}
document.getElementById('refresh').onclick=load;load();
</script></body></html>`;
}

export function sinkDinkArtifactReviewRoutes() {
  const router = Router();
  router.get("/sink-dink/artifacts/review/latest", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "12"), 10) || 12, 1), 50);
      const artifacts = (await readJobs(limit)).map(mapJob);
      res.json({ ok: true, service: "sink-dink-artifact-review", artifacts, publishingBlocked: true, humanApprovalRequired: true });
    } catch (error) {
      res.status(502).json({ ok: false, service: "sink-dink-artifact-review", error: error instanceof Error ? error.message : String(error), publishingBlocked: true });
    }
  });
  router.post("/sink-dink/artifacts/review/action", async (req, res) => {
    try {
      const jobId = safeJobId(req.body?.jobId);
      const action = str(req.body?.action);
      if (!jobId || !action || !ACTIONS[action]) throw new Error("Invalid job/action.");
      const rows = await updateJob(jobId, action);
      res.json({ ok: true, service: "sink-dink-artifact-review", jobId, action, rows, publishingBlocked: true, humanApprovalRequired: true, autoPublished: false });
    } catch (error) {
      res.status(400).json({ ok: false, service: "sink-dink-artifact-review", error: error instanceof Error ? error.message : String(error), publishingBlocked: true });
    }
  });
  router.get("/sink-dink/artifacts/review", (_req, res) => { res.type("html").send(html()); });
  return router;
}
