import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../slack-app-manifest.json", import.meta.url), "utf8"));
const url = new URL("https://api.slack.com/apps");
url.searchParams.set("new_app", "1");
url.searchParams.set("manifest_json", JSON.stringify(manifest));
console.log(url.href);
