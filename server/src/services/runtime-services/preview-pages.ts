import { randomBytes } from "node:crypto";
import type { Response } from "express";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** These pages run on the preview origin and contain no control-plane data. */
export function previewPage(res: Response, input: { status: number; title: string; message: string; boardURL?: string; poll?: boolean }) {
  const nonce = randomBytes(18).toString("base64url");
  res.status(input.status).set({
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
  }).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(input.title)} · Paperclip</title><style nonce="${nonce}">:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:36rem;margin:12vh auto;padding:1.5rem;line-height:1.6}h1{font-size:1.5rem}a{color:inherit}p{opacity:.8}button{font:inherit;padding:.4em .9em;cursor:pointer}#status{min-height:1.6em}</style></head><body><main><h1>${escape(input.title)}</h1><p>${escape(input.message)}</p><p id="status" role="status" aria-live="polite"></p>${input.boardURL ? `<a href="${escape(input.boardURL)}" rel="noreferrer">Open in Paperclip</a>` : ""}${input.poll ? `<script nonce="${nonce}">let checks=0;async function check(){try{const response=await fetch('/.paperclip/status',{cache:'no-store'});if(response.status===401||response.status===403){document.getElementById('status').textContent='Preview access expired. Open Paperclip to sign in again.';return}if(!response.ok)throw Error();const result=await response.json();if(result.ready){location.reload();return}if(result.state==='failed'||result.desiredState==='stopped'){document.getElementById('status').textContent='The service needs attention. Open Paperclip for details.';return}document.getElementById('status').textContent=++checks>10?'Still starting. This page will update when the app is ready.':'Waiting for the app…'}catch{document.getElementById('status').textContent='Connection interrupted. Retrying…'}setTimeout(check,1500)}check();</script>` : ""}</main></body></html>`);
}

// An open socket, background fetch, or a hidden document must not extend idle
// time. The signal is intentionally separate from status and health probes.
export const previewVisibilityScript = `(()=>{if(window!==window.top)return;let pending=false;async function signal(){if(pending)return;pending=true;try{await fetch('/.paperclip/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({visible:document.visibilityState==='visible'}),cache:'no-store',keepalive:true})}catch{}finally{pending=false}}signal();document.addEventListener('visibilitychange',signal);setInterval(()=>{if(document.visibilityState==='visible')signal()},20000)})();`;
