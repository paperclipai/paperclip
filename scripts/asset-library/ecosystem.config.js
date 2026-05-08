// pm2 ecosystem config — Marketing Asset Library
// Run: pm2 start ecosystem.config.js
const fs = require("node:fs");
const path = require("node:path");

const NOTIFIER_ENV_FILE =
  "/Users/jlqueguiner/.paperclip-worktrees/instances/paperclip-openrunner/secrets/notifier.env";

function loadNotifierEnv() {
  const env = {};
  if (!fs.existsSync(NOTIFIER_ENV_FILE)) return env;
  const text = fs.readFileSync(NOTIFIER_ENV_FILE, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const notifierEnv = loadNotifierEnv();

// Pin to node@20 — Next 14 currently mis-prerenders error pages on node 25.
const NODE_BIN = "/opt/homebrew/opt/node@20/bin/node";

module.exports = {
  apps: [
    {
      name: "asset-library",
      cwd: path.resolve(__dirname),
      script: "node_modules/.bin/next",
      args: "start",
      interpreter: NODE_BIN,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        PORT: "7700",
        ASSET_LIBRARY_PORT: "7700",
        ASSET_LIBRARY_URL: "http://127.0.0.1:7700",
        PATH: `/opt/homebrew/opt/node@20/bin:${process.env.PATH ?? ""}`,
        ...notifierEnv,
      },
    },
  ],
};
