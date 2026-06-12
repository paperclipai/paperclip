import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const header = readFileSync(new URL("./src/userscript/header.txt", import.meta.url), "utf8");

const result = await esbuild.build({
  entryPoints: ["src/userscript/entry.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  charset: "utf8",
  loader: { ".json": "json" },
  write: false,
});

const code = result.outputFiles[0].text;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/paperclip-de.user.js", header + "\n" + code);
console.log("Wrote dist/paperclip-de.user.js");
