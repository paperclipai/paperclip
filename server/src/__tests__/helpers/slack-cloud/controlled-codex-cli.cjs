#!/usr/bin/env node
// Controlled provider executable, NOT the real Codex model or service.
const assert = require("node:assert/strict"), fs = require("node:fs");
require("./scoped-cli-prewire.cjs");
assert.equal(process.versions.node.split(".")[0], "24", "The qualification Node24 executable is required");
const version = process.argv.length === 3 && process.argv[2] === "--version";
fs.appendFileSync(process.env.SLACK_GATE_PROCESS_LOG, JSON.stringify({phase:"controlled-cli-entry",pid:process.pid,ppid:process.ppid,
  execPath:process.execPath,argv:process.argv,execArgv:process.execArgv,versionProbe:version,realModelProvider:false})+"\n");
if (version) { console.log("paperclip-controlled-codex-jsonl-fixture (no real model)"); }
else {
  assert.ok(process.argv.slice(2).includes("exec"), "Only actual normal Codex exec invocation accepted");
  assert.ok(process.env.PAPERCLIP_RUN_ID && process.env.PAPERCLIP_API_KEY, "Normal run token required");
  // Consume normal prompt stdin without executing it or leaking it to logs.
  (async () => {
    let size=0; for await (const chunk of process.stdin) { size+=chunk.length; assert.ok(size<=2*1024*1024,"Controlled prompt bound"); }
    console.log(JSON.stringify({type:"thread.started",thread_id:`controlled-${process.env.PAPERCLIP_RUN_ID}`}));
    await import("./normal-scoped-useful-final.mjs");
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
