const semanticRunnerVersion =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function numeric(part: string): boolean {
  return /^[0-9]+$/.test(part);
}

function parse(version: string): [string, string, string, string] | null {
  if (version.length > 96) return null;
  const parts = semanticRunnerVersion.exec(version);
  if (!parts) return null;
  const prerelease = parts[4] ?? "";
  if (prerelease.split(".").some(part => part.length > 1 && part.startsWith("0") && numeric(part))) return null;
  return [parts[1]!, parts[2]!, parts[3]!, prerelease];
}

function compareNumeric(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
}

export function runnerVersionCanResume(current: string, previous: string): boolean {
  const a = parse(current);
  const b = parse(previous);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    const order = compareNumeric(a[i]!, b[i]!);
    if (order !== 0) return order > 0;
  }
  if (a[3] === b[3] || a[3] === "") return true;
  if (b[3] === "") return false;
  const preA = a[3].split(".");
  const preB = b[3].split(".");
  for (let i = 0; i < Math.min(preA.length, preB.length); i += 1) {
    const x = preA[i]!;
    const y = preB[i]!;
    const order = numeric(x) && numeric(y) ? compareNumeric(x, y) : numeric(x) ? -1 : numeric(y) ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (order !== 0) return order > 0;
  }
  return preA.length >= preB.length;
}
