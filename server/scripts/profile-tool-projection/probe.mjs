import http from 'node:http';
const agent = new http.Agent({ keepAlive: true });
let active = false, pending, times = [], port;
function ping() {
  if (!active || pending) return;
  pending = new Promise(resolve => {
    const start = performance.now();
    const request = http.get({ host: '127.0.0.1', port, path: '/api/health', agent }, response => {
      response.resume(); response.on('end', () => { times.push(performance.now() - start); resolve(); });
    });
    request.setTimeout(20000, () => request.destroy(new Error('Probe timeout')));
    request.on('error', error => { times.push({ error: error.message }); resolve(); });
  }).finally(() => { pending = null; });
}
const interval = setInterval(ping, 20);
process.on('message', async message => {
  if (message.kind === 'arm') { port = message.port; times = []; active = true; process.send({ kind: 'armed' }); }
  if (message.kind === 'stop') { active = false; await pending; process.send({ kind: 'stopped', times }); }
  if (message.kind === 'close') { clearInterval(interval); agent.destroy(); process.disconnect(); }
});
