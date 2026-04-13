// scripts.js — SSE-streamed script execution for the Flask ops dashboard
// Depends on: api.js
// Exposes window.ScriptRunner

window.ScriptRunner = (() => {

  // ─── state ─────────────────────────────────────────────────────────────────

  const _running = {}; // file → { jobId, es }

  // ─── helpers ───────────────────────────────────────────────────────────────

  const _slugify = (file) =>
    String(file).replace(/[^a-zA-Z0-9_-]/g, '_');

  const _lineClass = (line) => {
    const t = line.trim();
    if (/error|fail|FAIL|ERROR/i.test(t))          return 'err';
    if (/done|complete|success|passed/i.test(t))   return 'ok';
    if (/warn|WARN/i.test(t))                       return 'warn';
    if (/^─+$/.test(t))                             return 'dim';
    return '';
  };

  const _appendLine = (logEl, line) => {
    const cls = _lineClass(line);
    const span = document.createElement('span');
    span.className = `log-line${cls ? ' ' + cls : ''}`;
    span.textContent = line + '\n';
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const _resetBtn = (btnEl, file) => {
    if (!btnEl) return;
    btnEl.disabled = false;
    btnEl.classList.remove('running', 'done', 'failed');
    const label = String(file).replace(/^.*[\\/]/, '');
    btnEl.innerHTML = label;
  };

  const _setDone = (btnEl, file, success) => {
    if (!btnEl) return;
    btnEl.disabled = false;
    btnEl.classList.remove('running');
    btnEl.classList.add(success ? 'done' : 'failed');
    btnEl.innerHTML = success ? '✓ done' : '✗ failed';
    setTimeout(() => _resetBtn(btnEl, file), 5000);
  };

  const _now = () =>
    new Date().toLocaleTimeString();

  // ─── public functions ───────────────────────────────────────────────────────

  const run = async (file, btnEl) => {
    if (_running[file]) return;

    // — button → running state
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.classList.add('running');
      btnEl.innerHTML = '<span class="spinner"></span> Running…';
    }

    let jobId;
    try {
      const res = await API.runScript(file);
      jobId = res.job_id;
    } catch (err) {
      console.error('[ScriptRunner] runScript failed:', err);
      _resetBtn(btnEl, file);
      return;
    }

    // — find or create log entry block
    const slug  = _slugify(file);
    const entryId = `entry-${slug}`;
    const logId   = `log-${jobId}`;
    const jobList = document.getElementById('job-list');

    let entryEl = document.getElementById(entryId);
    let logEl;

    if (entryEl) {
      // reuse entry — clear log, re-open
      logEl = entryEl.querySelector('.stream-log');
      if (logEl) {
        logEl.id = logId;
        logEl.innerHTML = '';
        logEl.classList.add('open');
      }
      // update spinner/timestamp in header
      const hdr = entryEl.querySelector('.entry-header');
      if (hdr) {
        hdr.querySelector('.entry-spinner')?.remove();
        const spinnerEl = document.createElement('span');
        spinnerEl.className = 'spinner entry-spinner';
        hdr.prepend(spinnerEl);
        const tsEl = hdr.querySelector('.entry-ts');
        if (tsEl) tsEl.textContent = _now();
      }
    } else {
      // create new entry
      entryEl = document.createElement('div');
      entryEl.className = 'entry';
      entryEl.id = entryId;

      const label = String(file).replace(/^.*[\\/]/, '');
      entryEl.innerHTML = `
        <div class="entry-header" onclick="Dashboard.toggleEntry('${logId}')">
          <span class="spinner entry-spinner"></span>
          <span class="entry-label">${label}</span>
          <span class="entry-ts muted">${_now()}</span>
        </div>
        <pre class="stream-log open" id="${logId}"></pre>`;

      if (jobList) jobList.prepend(entryEl);

      logEl = entryEl.querySelector('.stream-log');
    }

    // — open SSE stream
    const es = new EventSource(`/api/scripts/stream/${jobId}`);
    _running[file] = { jobId, es };

    es.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.line != null && logEl) {
        _appendLine(logEl, msg.line);
      }

      if (msg.done) {
        es.close();
        delete _running[file];

        _setDone(btnEl, file, msg.success !== false);

        // remove spinner from entry header
        const spinner = entryEl?.querySelector('.entry-spinner');
        spinner?.remove();
      }
    };

    es.onerror = () => {
      es.close();
      delete _running[file];
      _resetBtn(btnEl, file);
      const spinner = entryEl?.querySelector('.entry-spinner');
      spinner?.remove();
    };
  };

  const clearHistory = async () => {
    try {
      await API.clearJobs();
    } catch (err) {
      console.error('[ScriptRunner] clearJobs failed:', err);
    }
    const jobList = document.getElementById('job-list');
    if (jobList) jobList.innerHTML = '';
  };

  const toggleEntry = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open');
  };

  // ─── public API ────────────────────────────────────────────────────────────

  return { run, clearHistory, toggleEntry };
})();
