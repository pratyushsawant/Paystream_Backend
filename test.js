// test.js
// Full end-to-end PayStream test using agentService.js
// Run with: node test.js

const { runMainAgent } = require('./agentService');

async function test() {
  const task = 'Research the top 3 AI and crypto projects announced this week';
  const budget = 1; // HBAR

  const result = await runMainAgent(task, budget);

  console.log('\n========================================');
  console.log('FINAL REPORT:');
  console.log('========================================');
  console.log(result.finalReport);
  console.log('\nSpent:    ' + result.spent + ' HBAR');
  console.log('Refunded: ' + result.refunded + ' HBAR');
}

test().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
