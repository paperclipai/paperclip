#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
 
const env = {
  ...process.env,
  PAPERCLIP_MIGRATION_PROMPT: "never",
};
 
const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
const args = [
  "watch",
  "--ignore",
  "../ui/node_modules",
  "--ignore",
  "../ui/.vite",
  "--ignore",
  "../ui/dist",
  "src/index.ts",
];
 
const child = spawn(tsxBin, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
 
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

