// index.js
// PayStream terminal runner — Phase 4
// Runs the full agent flow and prints everything to the console.
// Run with: node index.js

const { runMainAgent } = require('./agentService');

// ─────────────────────────────────────────────
// Configure your task and budget here
// ─────────────────────────────────────────────
const TASK   = 'Research the top 3 AI and crypto projects announced this week';
const BUDGET = 1; // HBAR

// ─────────────────────────────────────────────
// Run PayStream
// ─────────────────────────────────────────────
async function main() {
  console.log('========================================');
  console.log('          PAYSTREAM v1.0');
  console.log('  Multi-Agent AI Economy on Hedera');
  console.log('========================================\n');

  const result = await runMainAgent(TASK, BUDGET);

  console.log('========================================');
  console.log('             FINAL REPORT');
  console.log('========================================\n');
  console.log(result.finalReport);

  console.log('\n========================================');
  console.log('           PAYMENT SUMMARY');
  console.log('========================================');
  console.log('Total spent:    ' + result.spent + ' HBAR');
  console.log('Total refunded: ' + result.refunded + ' HBAR');
  console.log('\nAll transactions visible on HashScan:');
  console.log('https://hashscan.io/testnet/account/' + process.env.AGENT_ACCOUNT_ID);
  console.log('\nPayStream complete.');
}

main().catch((err) => {
  console.error('\nERROR: ' + err.message);
  process.exit(1);
});
