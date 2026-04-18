import fs from "node:fs";
import path from "node:path";

export interface SpaFixture {
  uiDistDir: string;
  uiIndexPath: string;
  createdUiDistDir: boolean;
}

export function createSpaFixture(uiDistDir: string, uiIndexHtml: string): SpaFixture {
  const createdUiDistDir = !fs.existsSync(uiDistDir);
  fs.mkdirSync(uiDistDir, { recursive: true });

  const uiIndexPath = path.join(uiDistDir, "index.html");
  fs.writeFileSync(uiIndexPath, uiIndexHtml, "utf8");

  return {
    uiDistDir,
    uiIndexPath,
    createdUiDistDir,
  };
}

export function cleanupSpaFixture(fixture: SpaFixture): void {
  fs.rmSync(fixture.uiIndexPath, { force: true });

  if (!fixture.createdUiDistDir) {
    return;
  }

  try {
    fs.rmdirSync(fixture.uiDistDir);
  } catch {
    // Leave non-empty or already-removed directories untouched.
  }
}
