import https from "node:https";
import { readFileSync, appendFileSync, chmodSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const PORT = parseInt(process.env.UP_PORT ?? "8443", 10);
const LOG = process.env.UP_LOG ?? "/tmp/received.log";
const EXPECT_FP = process.env.UP_EXPECT_FP ?? "";
const PLACEHOLDER_FP = process.env.UP_PLACEHOLDER_FP ?? "";
const LABEL = process.env.UP_LABEL ?? "upstream";

if (!existsSync(LOG)) { writeFileSync(LOG, ""); }
try { chmodSync(LOG, 0o600); } catch {}

function sha12(s) { return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12); }

function tokenOf(auth) {
  if (!auth) return "";
  const m = auth.match(/^(?:Bearer|token)\s+(.*)$/i);
  return m ? m[1] : auth;
}

const opts = { cert: readFileSync(process.env.UP_CERT), key: readFileSync(process.env.UP_KEY) };

https.createServer(opts, (req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const auth = req.headers["authorization"] ?? "";
    const nonce = req.headers["x-run-nonce"] ?? "";
    const tok = tokenOf(auth);
    const fp = tok ? sha12(tok) : "";
    appendFileSync(LOG,
      JSON.stringify({ ts: new Date().toISOString(), label: LABEL, method: req.method,
        path: req.url, nonce, authorization: auth, token_sha256_12: fp }) + "\n");
    const authorized = fp !== "" && fp === EXPECT_FP;
    const verdict = {
      nonce, label: LABEL, method: req.method, path: req.url,
      authorized, key_sha256_12: fp,
      is_placeholder: fp === PLACEHOLDER_FP,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(verdict));
  });
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock-upstream[${LABEL}] listening 127.0.0.1:${PORT}\n`);
});
