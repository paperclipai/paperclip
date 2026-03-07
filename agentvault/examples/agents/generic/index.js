/**
 * Example Generic Agent Entry Point
 *
 * This is a simple example of a generic agent that can be
 * deployed to AgentVault and executed on ICP.
 */

async function processMessage(message, context) {
  console.log(`Processing message: ${message}`);
  console.log(`Working directory: ${context.workingDirectory}`);
  console.log(`Environment:`, context.environment);

  // Simple echo response for demonstration
  return `Processed: ${message}`;
}

// Example main function for execution
async function main(args) {
  console.log('Generic Agent Started');
  console.log('Args:', args);

  // Example context
  const context = {
    workingDirectory: process.cwd(),
    environment: process.env,
    allowedFiles: ['*'],
  };

  // Process a sample message
  const response = await processMessage('Hello, Agent!', context);
  console.log('Response:', response);
}

// Export for module usage
export { main, processMessage };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(console.error);
}
