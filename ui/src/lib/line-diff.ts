export type DiffRowKind = "context" | "removed" | "added";

export type DiffRow = {
  kind: DiffRowKind;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  text: string;
};

export function buildLineDiff(oldText: string, newText: string): DiffRow[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const dp = Array.from({ length: oldCount + 1 }, () => Array<number>(newCount + 1).fill(0));

  for (let i = oldCount - 1; i >= 0; i -= 1) {
    for (let j = newCount - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let oldLineNumber = 1;
  let newLineNumber = 1;

  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      rows.push({
        kind: "context",
        oldLineNumber,
        newLineNumber,
        text: oldLines[i],
      });
      i += 1;
      j += 1;
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({
        kind: "removed",
        oldLineNumber,
        newLineNumber: null,
        text: oldLines[i],
      });
      i += 1;
      oldLineNumber += 1;
      continue;
    }

    rows.push({
      kind: "added",
      oldLineNumber: null,
      newLineNumber,
      text: newLines[j],
    });
    j += 1;
    newLineNumber += 1;
  }

  while (i < oldCount) {
    rows.push({
      kind: "removed",
      oldLineNumber,
      newLineNumber: null,
      text: oldLines[i],
    });
    i += 1;
    oldLineNumber += 1;
  }

  while (j < newCount) {
    rows.push({
      kind: "added",
      oldLineNumber: null,
      newLineNumber,
      text: newLines[j],
    });
    j += 1;
    newLineNumber += 1;
  }

  return rows;
}
