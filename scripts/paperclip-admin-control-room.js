// Paperclip Admin Control Room helper
// Usage: paste this entire file into the browser console while logged in to Paperclip.
// It creates a floating control panel that uses your current Paperclip browser session.
// It never asks for API keys and does not expose secrets.

(() => {
  const COMPANY_ID = "5b177a2c-9bba-4c57-a82c-7fbfe9e5d328";
  const CEO_ID = "67b290a8-3058-462b-b3ef-74a271cb08ac";
  const KNOWN_STOP_TASKS = ["NSD-29", "NSD-31", "NSD-32", "NSD-33", "NSD-37"];
  const boxId = "paperclip-admin-control-room";
  document.getElementById(boxId)?.remove();

  const state = { last: null };

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      ...options,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { url, method: options.method || "GET", status: res.status, ok: res.ok, data };
  }

  async function post(url, body = {}) {
    return api(url, { method: "POST", body: JSON.stringify(body) });
  }

  async function patch(url, body = {}) {
    return api(url, { method: "PATCH", body: JSON.stringify(body) });
  }

  function safeJson(value) {
    return JSON.stringify(value, null, 2)
      .replace(/sk-[A-Za-z0-9_-]+/g, "[OPENAI_KEY_HIDDEN]")
      .replace(/AIza[A-Za-z0-9_\-]+/g, "[GOOGLE_KEY_HIDDEN]")
      .replace(/hf_[A-Za-z0-9_\-]+/g, "[HF_TOKEN_HIDDEN]")
      .replace(/[A-Za-z0-9_\-]{45,}/g, "[LONG_SECRET_HIDDEN]");
  }

  function write(title, payload) {
    state.last = payload;
    const out = document.querySelector(`#${boxId} textarea`);
    if (out) out.value = `${title}\n\n${safeJson(payload)}`;
    console.log(title, payload);
  }

  async function health() {
    const result = {
      healthz: await api("/healthz"),
      ceo: await api(`/api/agents/ceo?companyId=${COMPANY_ID}`),
      dashboard: await api(`/api/companies/${COMPANY_ID}/dashboard`),
      liveRuns: await api(`/api/companies/${COMPANY_ID}/live-runs`),
    };
    write("Health check", result);
  }

  async function pauseCeo() {
    const result = await post(`/api/agents/${CEO_ID}/pause?companyId=${COMPANY_ID}`);
    write("Pause CEO", result);
  }

  async function resumeCeo() {
    const result = await post(`/api/agents/${CEO_ID}/resume?companyId=${COMPANY_ID}`);
    write("Resume CEO", result);
  }

  async function stopIssue(identifier) {
    const result = {
      before: await api(`/api/issues/${identifier}`),
      patch: await patch(`/api/issues/${identifier}`, {
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
      after: await api(`/api/issues/${identifier}`),
    };
    write(`Stop issue ${identifier}`, result);
  }

  async function stopKnownTasks() {
    const result = [];
    await pauseCeo();
    for (const identifier of KNOWN_STOP_TASKS) {
      result.push({ identifier, action: await patch(`/api/issues/${identifier}`, {
        status: "done",
        assigneeAgentId: null,
        assigneeUserId: null,
      }) });
    }
    write("Stop known auto-run tasks", result);
  }

  async function createSafeGeminiTest() {
    const repair = await api("/api/issues/NSD-9");
    if (!repair.ok || !repair.data?.companyId) {
      write("Create safe Gemini test failed", repair);
      return;
    }
    const created = await api(`/api/companies/${repair.data.companyId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "SAFE TEST — CEO free model manual run",
        description: [
          "Manual single test only.",
          "",
          "Reply only:",
          "CEO run working on free model.",
          "",
          "Rules:",
          "- Do not use OpenAI.",
          "- Do not use Codex.",
          "- Do not spend money.",
          "- Do not create files.",
          "- Do not publish anything.",
          "- Do not start other tasks.",
          "- Do not create agents.",
        ].join("\n"),
        status: "todo",
        priority: "critical",
        workMode: "standard",
        projectId: repair.data.projectId,
        goalId: repair.data.goalId,
        parentId: repair.data.id,
        assigneeAgentId: CEO_ID,
      }),
    });
    write("Created safe Gemini test. Do not auto-run; manual run once only.", created);
  }

  async function auditIssue(identifier) {
    const result = {
      issue: await api(`/api/issues/${identifier}`),
      context: await api(`/api/issues/${identifier}/heartbeat-context`),
      comments: await api(`/api/issues/${identifier}/comments`),
      liveRuns: await api(`/api/companies/${COMPANY_ID}/live-runs`),
      heartbeats: await api(`/api/companies/${COMPANY_ID}/heartbeat-runs?agentId=${CEO_ID}`),
    };
    write(`Audit issue ${identifier}`, result);
  }

  function askIssueId(action) {
    const id = prompt("Issue identifier likho, example: NSD-37");
    if (!id) return;
    action(id.trim().toUpperCase());
  }

  const wrap = document.createElement("div");
  wrap.id = boxId;
  wrap.style = [
    "position:fixed",
    "z-index:999999",
    "top:16px",
    "right:16px",
    "width:430px",
    "max-width:calc(100vw - 32px)",
    "height:78vh",
    "background:#111",
    "color:#fff",
    "border:3px solid #22c55e",
    "border-radius:12px",
    "box-shadow:0 8px 40px rgba(0,0,0,.4)",
    "padding:12px",
    "font-family:Arial,sans-serif",
  ].join(";");

  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;">
      <b style="color:#22c55e;">Paperclip Admin Control Room</b>
      <button data-action="close">×</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
      <button data-action="health">Health</button>
      <button data-action="pause">Pause CEO</button>
      <button data-action="resume">Resume CEO</button>
      <button data-action="stop-known">Stop Old Tasks</button>
      <button data-action="stop-one">Stop Issue</button>
      <button data-action="audit-one">Audit Issue</button>
      <button data-action="create-test">Create Safe Test</button>
      <button data-action="copy">Copy Output</button>
    </div>
    <textarea style="width:100%;height:calc(100% - 105px);background:#050505;color:#fff;font-size:12px;border:1px solid #333;border-radius:8px;padding:8px;">Ready. Click Health first.</textarea>
  `;

  wrap.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute("data-action");
    if (!action) return;
    if (action === "close") wrap.remove();
    if (action === "health") health();
    if (action === "pause") pauseCeo();
    if (action === "resume") resumeCeo();
    if (action === "stop-known") stopKnownTasks();
    if (action === "stop-one") askIssueId(stopIssue);
    if (action === "audit-one") askIssueId(auditIssue);
    if (action === "create-test") createSafeGeminiTest();
    if (action === "copy") navigator.clipboard.writeText(document.querySelector(`#${boxId} textarea`)?.value || "");
  });

  document.body.appendChild(wrap);
  health();
})();
