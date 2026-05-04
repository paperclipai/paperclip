// Find what exists at byte 1824 (1-indexed) in the full migration batch
const fs = require('fs');
const path = require('path');

const MIGRATIONS_FOLDER = './packages/db/src/migrations';
const journalPath = './packages/db/src/migrations/meta/_journal.json';

const delimiter = '--> statement-breakpoint';

// Read journal to get ordered list of migration files
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const orderedFiles = (journal.entries || [])
  .map(e => `${e.tag}.sql`)
  .filter(f => fs.existsSync(path.join(MIGRATIONS_FOLDER, f)));

console.log(`Found ${orderedFiles.length} migration files in journal order`);
console.log(`First file: ${orderedFiles[0]}`);
console.log('');

// Read and concatenate all migration files in order
let allContent = '';
const fileBoundaries = []; // {file, start, end}

for (const file of orderedFiles) {
  const filePath = path.join(MIGRATIONS_FOLDER, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const start = allContent.length;
  allContent += content;
  const end = allContent.length - 1;
  fileBoundaries.push({ file, start, end });
}

console.log(`Total concatenated length: ${allContent.length} bytes`);
console.log('');

// Find which file/char position 1824 falls into (1-indexed)
const targetPos = 1824 - 1; // Convert to 0-indexed
console.log(`Target position (0-indexed): ${targetPos}`);

for (const { file, start, end } of fileBoundaries) {
  if (start <= targetPos && targetPos <= end) {
    const localPos = targetPos - start;
    console.log(`\nFOUND in: ${file}`);
    console.log(`File start: ${start}, File end: ${end}`);
    console.log(`Local position: ${localPos}`);
    console.log('');
    console.log(`Char at target: '${allContent[targetPos]}' (code: ${allContent.charCodeAt(targetPos)})`);
    console.log(`Context (local pos ${localPos - 50} to ${localPos + 50}):`);
    const ctxStart = Math.max(0, localPos - 50);
    const ctxEnd = Math.min(end - start + 1, localPos + 50);
    console.log(JSON.stringify(allContent.substring(start + ctxStart, start + ctxEnd)));
    console.log('');
    console.log(`Full file content:`);
    const fileContent = fs.readFileSync(path.join(MIGRATIONS_FOLDER, file), 'utf8');
    console.log(fileContent);
    break;
  }
}