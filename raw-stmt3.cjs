const fs = require('fs');

const buffer = fs.readFileSync('C:/Real-Tycoon 2/packages/db/src/migrations/0000_mature_masked_marvel.sql');
console.log('File size:', buffer.length, 'bytes');

// Statement 3 starts at byte 1545, length 500 (bytes 1545-2044)
const stmt3Start = 1545;
const stmt3Length = 500;
const stmt3End = stmt3Start + stmt3Length - 1; // 2044

console.log('\nStatement 3 (bytes 1545-2044):');
const stmt3 = buffer.slice(stmt3Start, stmt3Start + stmt3Length);
console.log('Length:', stmt3.length);
console.log('Content:');
console.log(stmt3.toString('utf8'));

// Check position 1822 (0-indexed) = position 1823 (1-indexed)
const pos = 1822;
console.log('\nChar at byte', pos, ':', buffer[pos], '(code:', buffer[pos], ')');
console.log('Context bytes', pos-20, 'to', pos+20, ':');
console.log(buffer.slice(pos-20, pos+21).toString('utf8'));

// What if the position 1823 is from BEGIN...stmt1...stmt2...stmt3 as ONE query?
// Let's compute cumulative positions of statements in the transaction
const delimiter = Buffer.from('--> statement-breakpoint');
const parts = [];
let searchFrom = 0;
while (true) {
  const idx = buffer.indexOf(delimiter, searchFrom);
  if (idx === -1) {
    parts.push(buffer.slice(searchFrom).toString('utf8'));
    break;
  }
  parts.push(buffer.slice(searchFrom, idx).toString('utf8').trim());
  searchFrom = idx + delimiter.length;
}

console.log('\nStatement lengths (after trim):');
let cumLen = 0;
for (let i = 0; i < parts.length; i++) {
  const trimmed = parts[i].trim();
  if (!trimmed) continue;
  const start = cumLen;
  cumLen += trimmed.length;
  console.log(`Statement ${i}: len=${trimmed.length}, cumulative range ${start}-${cumLen-1}:`);
  console.log('  Preview:', trimmed.substring(0, 50));
  if (start <= 1822 && 1822 <= cumLen - 1) {
    console.log('  ** CONTAINS BYTE 1822 (local offset: ' + (1822 - start) + ') **');
    const localOffset = 1822 - start;
    console.log('  Context:', JSON.stringify(trimmed.substring(Math.max(0, localOffset-30), localOffset+50)));
  }
  cumLen += 24; // delimiter length
}