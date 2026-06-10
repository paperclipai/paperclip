const $ = (id) => document.getElementById(id);
const form = $("form");
const empty = $("empty");
const loading = $("loading");
const preview = $("preview");
const frame = $("frame");
const list = $("list");

const show = (el) => { for (const e of [empty, loading, preview]) e.classList.add("hidden"); el.classList.remove("hidden"); };

async function loadRecent() {
  try {
    const decks = await (await fetch("/api/decks")).json();
    list.innerHTML = decks.length
      ? decks.map((d) => `<li class="deck-row">
          <a class="deck-name" href="${d.url}" target="_blank">${d.file.replace(/\.html$/, "")}</a>
          <span class="deck-dl">
            <a href="/api/dl/pdf/${d.file}" title="Download PDF (16:9)">PDF</a>
            <a href="/api/dl/html/${d.file}" title="Download self-contained HTML">HTML</a>
          </span></li>`).join("")
      : `<li style="color:var(--muted);font-size:12px;padding:4px 10px">None yet.</li>`;
  } catch {}
}

const MSGS = ["Planning slides…", "Calling Claude…", "Writing copy…", "Rendering deck…"];
let current = null; // last deck payload

function applyDeck(data) {
  current = data;
  $("deckTitle").textContent = data.deckTitle || data.file;
  $("openNew").href = data.url;
  $("exportPdf").href = "/api/dl/pdf/" + data.file;
  $("dlHtml").href = "/api/dl/html/" + data.file;
  $("frame").src = data.url + "?t=" + Date.now();
  buildShots(data);
}

const labelize = (id) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function buildShots(data) {
  const wrap = $("shots");
  if (!data.shots?.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = `<span class="shots-title">Screenshots</span>` + data.shots.map((sh) => {
    const opts = ['<option value="none">None</option>']
      .concat(data.allSnaps.map((s) =>
        `<option value="${s}.html"${sh.current === s + ".html" ? " selected" : ""}>${labelize(s)}</option>`))
      .join("");
    return `<label class="shot-pick">${labelize(sh.id)}<select data-slide="${sh.id}">${opts}</select></label>`;
  }).join("");

  wrap.querySelectorAll("select").forEach((sel) =>
    sel.addEventListener("change", () => rerender(sel.dataset.slide, sel.value)));
}

async function rerender(slideId, value) {
  if (!current) return;
  const overrides = { [slideId]: value };
  try {
    const res = await fetch("/api/rerender", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: current.slug, overrides })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "rerender failed");
    applyDeck(data);
  } catch (e) { alert("Re-render failed: " + e.message); }
}

// combobox labels -> backend keys. Unknown (custom-typed) -> slug; backend
// degrades gracefully (plan/playbook/snap lookups all fall back on miss).
const AUDIENCE_KEY = { "enterprise buyer": "enterprise", "smb": "smb", "investor": "investor" };
const USECASE_KEY = {
  "inbound support": "inbound_support", "receptionist / front desk": "receptionist",
  "outbound sales": "outbound_sales", "collections / recovery": "collections",
  "scheduling / reminders": "scheduling", "lead qualification": "qualification",
  "renewals / retention": "renewals", "surveys / feedback": "surveys"
};
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const toKey = (map, raw) => { const t = (raw || "").trim().toLowerCase(); return map[t] || slug(raw || ""); };

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const answers = Object.fromEntries(new FormData(form).entries());
  answers.clientType = toKey(AUDIENCE_KEY, answers.clientType);
  answers.useCase = toKey(USECASE_KEY, answers.useCase);
  const btn = $("go");
  btn.disabled = true; btn.textContent = "Generating…";

  show(loading);
  let i = 0;
  $("loadMsg").textContent = MSGS[0];
  const tick = setInterval(() => { i = (i + 1) % MSGS.length; $("loadMsg").textContent = MSGS[i]; }, 7000);

  try {
    const res = await fetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(answers)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");

    applyDeck(data);
    show(preview);
    loadRecent();
  } catch (err) {
    show(empty);
    alert("Generation failed: " + err.message);
  } finally {
    clearInterval(tick);
    btn.disabled = false; btn.textContent = "Generate deck";
  }
});

// Download buttons (PDF/HTML): fetch as blob with visible feedback so a slow
// Chrome render doesn't look broken, and force a real file download.
document.addEventListener("click", async (e) => {
  const a = e.target.closest('a[href^="/api/dl/"]');
  if (!a || a.dataset.busy) return;
  e.preventDefault();
  const isPdf = a.href.includes("/pdf/");
  const label = a.textContent;
  a.dataset.busy = "1";
  a.textContent = isPdf ? "PDF…" : "HTML…";
  a.style.opacity = "0.6";
  try {
    const res = await fetch(a.href);
    if (!res.ok) throw new Error((await res.text()) || ("HTTP " + res.status));
    const blob = await res.blob();
    const base = decodeURIComponent(a.href.split("/").pop()).replace(/\.html$/, "");
    const u = URL.createObjectURL(blob);
    const tmp = document.createElement("a");
    tmp.href = u; tmp.download = base + (isPdf ? ".pdf" : ".html");
    document.body.appendChild(tmp); tmp.click(); tmp.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  } catch (err) {
    alert("Download failed: " + err.message);
  } finally {
    delete a.dataset.busy; a.textContent = label; a.style.opacity = "";
  }
});

loadRecent();
