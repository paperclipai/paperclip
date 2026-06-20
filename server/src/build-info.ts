export interface BuildInfo {
  commitSha: string;
  shortSha: string;
  branch: string;
  buildTimestamp: string | null;
}

function readBuildValue(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export function getBuildInfo(): BuildInfo {
  const commitSha = readBuildValue("BUILD_SHA", "unknown");

  return {
    commitSha,
    shortSha: commitSha === "unknown" ? "unknown" : commitSha.slice(0, 12),
    branch: readBuildValue("BUILD_BRANCH", "unknown"),
    buildTimestamp: process.env.BUILD_TIMESTAMP?.trim() || null,
  };
}
