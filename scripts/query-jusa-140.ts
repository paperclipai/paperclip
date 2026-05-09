import { db } from '../packages/db/src/index.js';

async function main() {
  try {
    const issue = await db.query.issues.findFirst({
      where: (issues, { eq }) => eq(issues.publicId, 'JUSA-140'),
      with: {
        runs: {
          orderBy: (runs, { desc }) => [desc(runs.createdAt)],
          limit: 10
        }
      }
    });

    if (!issue) {
      console.log('Issue JUSA-140 not found');
      process.exit(1);
    }

    console.log(JSON.stringify(issue, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error querying issue:', error);
    process.exit(1);
  }
}

main();
