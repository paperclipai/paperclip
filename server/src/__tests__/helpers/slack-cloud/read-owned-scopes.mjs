import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
assert.equal(process.versions.node.split(".")[0], "24");
assert.equal(process.argv.length, 3);
const { SLACK_CHAT_BOT_SCOPES } = await import(pathToFileURL(process.argv[2]));
assert.ok(Array.isArray(SLACK_CHAT_BOT_SCOPES) && SLACK_CHAT_BOT_SCOPES.length > 0);
assert.ok(SLACK_CHAT_BOT_SCOPES.every(value => typeof value === "string" && (value === "commands" || /^[a-z_]+:[a-z_]+$/.test(value))));
console.log(JSON.stringify({ scopes: SLACK_CHAT_BOT_SCOPES, pid: process.pid, node: process.version }));
