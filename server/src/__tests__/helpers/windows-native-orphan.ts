import { spawn } from "node:child_process";
import { once } from "node:events";

/** A bounded native child whose exact parent exited, like a lost local runner. */
export async function windowsNativeOrphan(home: string, escaped = false) {
  const notBefore = new Date().toISOString();
  const parent = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const request=JSON.parse(process.argv[1]);
    const marker=request.escaped?JSON.stringify({CODEX_HOME:request.home}):request.home;
    const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),15000)','--',marker],{stdio:'ignore',detached:true,windowsHide:true});
    child.unref();process.stdout.write(String(child.pid));
  `, JSON.stringify({ home, escaped })], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let output = "";
  parent.stdout!.setEncoding("utf8").on("data", value => { output += value; });
  await Promise.all([once(parent, "exit"), once(parent.stdout!, "end")]);
  const pid = Number(output);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Windows orphan fixture did not report its child");
  return { pids: [pid], parentPid: parent.pid!, executable: process.execPath, codexHome: home,
    notBefore, notAfter: new Date().toISOString() };
}
