import pc from "picocolors";

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export function printAiderStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.replace(ANSI_RE, "").trimEnd();
  const trimmed = line.trim();
  if (!trimmed) return;

  if (/^Tokens:|^Cost:/i.test(trimmed)) {
    console.log(pc.blue(trimmed));
    return;
  }

  if (/^Applied edit to /i.test(trimmed) || /^Commit [0-9a-f]{7,40}/i.test(trimmed)) {
    console.log(pc.cyan(trimmed));
    return;
  }

  if (/^(?:Aider v|Main model:|Weak model:|Editor model:|Git repo:|Repo-map:|Added |Scanning repo|Use \/help)/i.test(trimmed)) {
    console.log(pc.gray(trimmed));
    return;
  }

  if (/^Warning:|^Error:|litellm\.[A-Za-z]*(?:Error|Exception)/.test(trimmed)) {
    console.log(pc.red(trimmed));
    return;
  }

  console.log(pc.green(line));
}
