#!/usr/bin/env node
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/paperclip/workspaces/paperclip/vitest-results.json', 'utf8'));
const failed = data.testResults.filter(r => r.status === 'failed');
console.log('Total test suites:', data.numTotalTestSuites);
console.log('Passed suites:', data.numPassedTestSuites);
console.log('Failed suites:', data.numFailedTestSuites);
console.log('Total tests:', data.numTotalTests);
console.log('Passed tests:', data.numPassedTests);
console.log('Failed tests:', data.numFailedTests);
console.log('\n=== FAILED TEST FILES ===\n');
failed.forEach(f => {
  const name = f.testFilePath.replace(/.*\/workspaces\/paperclip\//, '');
  console.log('FILE:', name);
  const failedTests = (f.assertionResults || []).filter(a => a.status === 'failed');
  failedTests.slice(0, 5).forEach(a => {
    console.log('  TEST:', a.fullName.substring(0, 100));
    const msg = (a.failureMessages || [''])[0];
    console.log('  ERR:', msg.substring(0, 300).replace(/\n/g, ' '));
  });
  console.log();
});
