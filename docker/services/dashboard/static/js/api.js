// api.js — thin fetch wrappers for the Flask ops dashboard
// Loaded first; exposes window.API

window.API = (() => {
  const _fetch = async (url, opts = {}) => {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return res.json();
  };

  const _post = (url, body) =>
    _fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    getStatus:   ()     => _fetch('/api/status'),
    getEvents:   ()     => _fetch('/api/events'),
    getRoutines: ()     => _fetch('/api/routines'),
    getScripts:  ()     => _fetch('/api/scripts'),
    runScript:   (file) => _post('/api/scripts/run', { file }),
    clearJobs:   ()     => _post('/api/scripts/jobs/clear', {}),
    getJob:      (jobId) => _fetch(`/api/scripts/jobs/${jobId}`),
  };
})();
