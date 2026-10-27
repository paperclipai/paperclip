export default () => `import { COMPANY } from "../../fixtures";

export function guid(seed: string): string {
  let h = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of \`\${seed}:\${round}\`) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20, 32)}\`;
}

export const agentId = (name: string) => guid(\`agent:\${name}\`);
export const issueIdFor = (taskIdentifier: string) => guid(\`issue:\${taskIdentifier}\`);
export const issueHref = (taskIdentifier: string) => \`/\${COMPANY.issuePrefix}/issues/\${taskIdentifier}\`;
`;
