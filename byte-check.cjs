const fs = require('fs');

// Read raw bytes
const buffer = fs.readFileSync('C:/Real-Tycoon 2/packages/db/src/migrations/0000_mature_masked_marvel.sql');
console.log('File size:', buffer.length, 'bytes');

// Get chars around position 1822 (0-indexed)
const pos = 1822;
const start = Math.max(0, pos - 50);
const end = Math.min(buffer.length, pos + 50);
const chunk = buffer.slice(start, end);
console.log('\nBytes', start, 'to', end - 1, ':');
console.log('Hex:', chunk.toString('hex'));
console.log('String:', chunk.toString('utf8'));

// Also look at positions around 1545 (start of statement 3) + 277
const statement3Start = 1545;
const localPos = 1822 - statement3Start;
console.log('\nWithin statement 3, byte 1822 is at local offset:', localPos);
const stmt3Chunk = buffer.slice(statement3Start + Math.max(0, localPos - 30), statement3Start + localPos + 50);
console.log('Context:', stmt3Chunk.toString('utf8'));

// Find all --> statement-breakpoint positions
const delimiter = Buffer.from('--> statement-breakpoint');
let searchFrom = 0;
let count = 0;
while (true) {
  const idx = buffer.indexOf(delimiter, searchFrom);
  if (idx === -1) break;
  console.log(`\nDelimiter at byte ${idx}:`);
  console.log('Context:', buffer.slice(Math.max(0, idx - 5), idx + delimiter.length + 5).toString('utf8').replace(/\n/g, '\\n'));
  searchFrom = idx + 1;
  count++;
}
console.log('\nTotal delimiters found:', count);