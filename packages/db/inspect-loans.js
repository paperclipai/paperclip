import fs from 'fs';

const loans = JSON.parse(fs.readFileSync('/home/dwizy/paperclip-gce/src/closed_loans.json', 'utf8'));
console.log(`Total loans: ${loans.length}`);

// unique Account Executives
const aeCounts = {};
loans.forEach(loan => {
  const ae = loan.Account_Executive__c;
  aeCounts[ae] = (aeCounts[ae] || 0) + 1;
});

console.log("Account Executive counts in closed_loans.json:", aeCounts);

// let's look at a few examples of loans
console.log("Example loans:", loans.slice(0, 5));
