import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const destination = new URL("./.env", import.meta.url);
let revision = "";
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch { /* Source archives have no git metadata. Leave the build unstamped. */ }
const secret = () => randomBytes(32).toString("hex");
try {
  writeFileSync(destination, [
    "PAPERMARKETING_PORT=3100", "PAPERCLIP_PUBLIC_URL=http://localhost:3100",
    "PAPERCLIP_ALLOWED_HOSTNAMES=", `PAPERCLIP_BUILD_COMMIT=${revision}`,
    `POSTGRES_PASSWORD=${secret()}`, `BETTER_AUTH_SECRET=${secret()}`,
    `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=${secret()}`, "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  console.log("Created docker/papermarketing/.env. Keep this file private and include it in encrypted backups.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.error(".env already exists. Existing secrets were preserved.");
  process.exitCode = 1;
}
