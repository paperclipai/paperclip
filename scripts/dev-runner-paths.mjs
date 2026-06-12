const testDirectoryNames = new Set([
  "__tests__",
  "_tests",
  "test",
  "tests",
]);

const ignoredTestConfigBasenames = new Set([
  "jest.config.cjs",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
]);

const nodeDiagnosticReportPattern = /^report\.\d{8}\.\d{6}\.\d+\.\d+\.\d+\.json$/i;

export function shouldTrackDevServerPath(relativePath) {
  const normalizedPath = String(relativePath).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalizedPath.length === 0) return false;

  const segments = normalizedPath.split("/");
  const basename = segments.at(-1) ?? normalizedPath;

  if (nodeDiagnosticReportPattern.test(basename)) {
    return false;
  }
  if (segments.includes(".paperclip")) {
    return false;
  }
  if (ignoredTestConfigBasenames.has(basename)) {
    return false;
  }
  if (segments.some((segment) => testDirectoryNames.has(segment))) {
    return false;
  }
  if (/\.(test|spec)\.[^/]+$/i.test(basename)) {
    return false;
  }

  return true;
}
