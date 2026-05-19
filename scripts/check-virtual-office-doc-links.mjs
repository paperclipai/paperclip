import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const docsDir = path.join(repoRoot, "docs");

const virtualOfficeDocs = fs
  .readdirSync(docsDir)
  .filter((fileName) => fileName.startsWith("virtual-office-") && fileName.endsWith(".md"))
  .sort();

const referencedDocPattern = /docs\/virtual-office-[\w.-]+\.md/g;
const missingReferences = [];
const foundReferences = new Set();
const englishDocNames = virtualOfficeDocs.filter((fileName) => fileName.endsWith(".en.md"));
const mojibakePatterns = ["撱箇", "摰", "敺", "鈭箏", "蝡", "銝", "嚗"];
const mojibakeFindings = [];

for (const fileName of virtualOfficeDocs) {
  const filePath = path.join(docsDir, fileName);
  const source = fs.readFileSync(filePath, "utf8");
  const references = source.match(referencedDocPattern) ?? [];

  for (const reference of references) {
    foundReferences.add(reference);
    const relativeDocPath = reference.replace(/^docs\//, "");
    const targetPath = path.join(docsDir, relativeDocPath);
    if (!fs.existsSync(targetPath)) {
      missingReferences.push(`${fileName} -> ${reference}`);
    }
  }

  if (englishDocNames.includes(fileName)) {
    for (const pattern of mojibakePatterns) {
      if (source.includes(pattern)) {
        mojibakeFindings.push(`${fileName} contains ${pattern}`);
      }
    }
  }
}

console.log("Virtual Office documentation check");
console.log(`  Documents scanned: ${virtualOfficeDocs.length}`);
console.log(`  Virtual Office doc references: ${foundReferences.size}`);
console.log(`  English documents checked: ${englishDocNames.length}`);

if (missingReferences.length > 0) {
  console.log("");
  console.log("Missing references:");
  for (const missingReference of missingReferences) {
    console.log(`  - ${missingReference}`);
  }
  process.exit(1);
}

if (mojibakeFindings.length > 0) {
  console.log("");
  console.log("English document readability findings:");
  for (const finding of mojibakeFindings) {
    console.log(`  - ${finding}`);
  }
  process.exit(1);
}

console.log("  Missing references: 0");
console.log("  English readability findings: 0");
