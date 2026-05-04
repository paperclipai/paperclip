const fs = require('fs');
const content = fs.readFileSync('C:/Real-Tycoon 2/packages/db/src/migrations/0059_lean_magdalene.sql', 'utf8');
const delimiter = '--> statement-breakpoint';
const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);
let cum = 0;
for (let i = 0; i < parts.length; i++) {
  const start = cum;
  cum += parts[i].length;
  const end = cum - 1;
  console.log(`Statement ${i}: bytes ${start}-${end} (len=${parts[i].length})`);
  if (start <= 1822 && 1822 <= end) {
    console.log('  <-- CONTAINS BYTE 1822');
    const stmtOffset = 1822 - start;
    const ctx = parts[i].substring(Math.max(0, stmtOffset - 30), stmtOffset + 50);
    console.log('  Context around 1822:', JSON.stringify(ctx));
    console.log('  Full statement length:', parts[i].length);
  }
  cum += delimiter.length;
}
console.log('Total chars:', content.length);