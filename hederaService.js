// hederaService.js
// All Hedera blockchain interactions live here.
// We build this function by function and test each one.

require('dotenv').config();

const {
  Client,
  AccountId,
  PrivateKey,
  AccountBalanceQuery,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
  TransferTransaction,
  Hbar,
  ScheduleCreateTransaction,
  ScheduleDeleteTransaction,
  ScheduleId,
  Timestamp,
} = require('@hashgraph/sdk');

// This holds our connected client so we don't reconnect every time
let client;

// This holds the HCS topic ID once createHCSTopic() is called
let hcsTopicId;

// ─────────────────────────────────────────────
// initClient()
// Connects to the Hedera testnet using credentials from .env
// Must be called once before anything else
// ─────────────────────────────────────────────
function initClient() {
  const userAccountId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const userPrivateKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY);

  client = Client.forTestnet();
  client.setOperator(userAccountId, userPrivateKey);

  console.log('Hedera client initialized.');
  console.log('Operator: ' + userAccountId.toString());

  return client;
}

// ─────────────────────────────────────────────
// getBalance(accountId)
// Returns the HBAR balance of any account
// accountId should be a string like "0.0.7974282"
// ─────────────────────────────────────────────
async function getBalance(accountId) {
  const balance = await new AccountBalanceQuery()
    .setAccountId(AccountId.fromString(accountId))
    .execute(client);

  console.log('Balance of ' + accountId + ': ' + balance.hbars.toString());
  return balance.hbars;
}

// ─────────────────────────────────────────────
// createHCSTopic()
// Creates a new Hedera Consensus Service topic.
// Think of a topic like a public channel — every step the agent
// takes gets posted here as a permanent, tamper-proof message.
// Returns the Topic ID (e.g. "0.0.1234567")
// ─────────────────────────────────────────────
async function createHCSTopic() {
  const tx = await new TopicCreateTransaction()
    .setTopicMemo('PayStream Agent Audit Trail')
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId.toString();

  // Save it to the module variable so paySubAgent can use it
  hcsTopicId = topicId;

  console.log('HCS Topic created: ' + topicId);
  console.log('View on HashScan: https://hashscan.io/testnet/topic/' + topicId);

  return topicId;
}

// ─────────────────────────────────────────────
// paySubAgent(agentName, amountInHbar, stepDescription)
// Logs a sub-agent payment permanently to HCS.
// This is the on-chain proof that the agent did its work and got paid.
// agentName = "Research Agent", "Analysis Agent", or "Writer Agent"
// amountInHbar = 0.05
// stepDescription = what this agent was asked to do
// ─────────────────────────────────────────────
async function paySubAgent(agentName, amountInHbar, stepDescription) {
  // Build the message that will be permanently stored on Hedera
  const message = JSON.stringify({
    agent: agentName,
    paid: amountInHbar + ' HBAR',
    task: stepDescription,
    timestamp: new Date().toISOString(),
  });

  // Submit the message to HCS — this is the on-chain payment record
  const submitTx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(hcsTopicId))
    .setMessage(message)
    .execute(client);

  const receipt = await submitTx.getReceipt(client);
  const txId = submitTx.transactionId.toString();

  console.log('---');
  console.log('Agent:   ' + agentName);
  console.log('Paid:    ' + amountInHbar + ' HBAR');
  console.log('Task:    ' + stepDescription);
  console.log('Status:  ' + receipt.status.toString());
  console.log('HashScan: https://hashscan.io/testnet/transaction/' + txId);

  return txId;
}

// ─────────────────────────────────────────────
// fundAgent(budgetInHbar)
// Does two things:
//   1. Sends the user's budget to the agent wallet (real HBAR transfer)
//   2. Creates a ScheduleCreateTransaction — a self-executing refund
//      that the Hedera network will auto-run in 10 minutes if we don't
//      cancel it first. No server needed. This is the On-Chain Automation bounty.
// Returns the scheduleId so we can cancel it early in refundRemainder()
// ─────────────────────────────────────────────
async function fundAgent(budgetInHbar) {
  const userAccountId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const userPrivateKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY);
  const agentAccountId = AccountId.fromString(process.env.AGENT_ACCOUNT_ID);
  const agentPrivateKey = PrivateKey.fromStringED25519(process.env.AGENT_PRIVATE_KEY);

  // Step 1: Transfer the budget from user wallet → agent wallet
  console.log('Transferring ' + budgetInHbar + ' HBAR from User -> Agent...');

  const fundTx = await new TransferTransaction()
    .addHbarTransfer(userAccountId, new Hbar(-budgetInHbar))
    .addHbarTransfer(agentAccountId, new Hbar(budgetInHbar))
    .execute(client);

  const fundReceipt = await fundTx.getReceipt(client);
  console.log('Fund transfer status: ' + fundReceipt.status.toString());
  console.log('HashScan: https://hashscan.io/testnet/transaction/' + fundTx.transactionId.toString());

  // Step 2: Create a scheduled auto-refund
  // This is a TransferTransaction (agent -> user) wrapped inside a ScheduleCreateTransaction.
  // The Hedera network holds it and will auto-execute it after 10 minutes.
  // If the agent finishes early, we cancel this and do the refund immediately instead.
  console.log('\nCreating scheduled auto-refund (10 min timer on Hedera)...');

  const scheduledTransfer = new TransferTransaction()
    .addHbarTransfer(agentAccountId, new Hbar(-budgetInHbar))
    .addHbarTransfer(userAccountId, new Hbar(budgetInHbar));

  // setWaitForExpiry(true) = don't execute immediately even if all signatures are present.
  // Wait until the expiry time. This is what makes it a real "10 min on-chain timer".
  const expiryTime = Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000));

  const scheduleCreateTx = await new ScheduleCreateTransaction()
    .setScheduledTransaction(scheduledTransfer)
    .setScheduleMemo('PayStream auto-refund ' + Date.now())
    .setAdminKey(userPrivateKey.publicKey)  // lets us cancel it early
    .setExpirationTime(expiryTime)          // auto-executes in 10 minutes
    .setWaitForExpiry(true)                 // hold it — don't fire early
    .freezeWith(client)
    .sign(agentPrivateKey);                 // agent signs since money leaves agent wallet

  const scheduleResponse = await scheduleCreateTx.execute(client);
  const scheduleReceipt = await scheduleResponse.getReceipt(client);
  const scheduleId = scheduleReceipt.scheduleId.toString();

  console.log('Scheduled auto-refund created: ' + scheduleId);
  console.log('HashScan: https://hashscan.io/testnet/schedule/' + scheduleId);

  return scheduleId;
}

// ─────────────────────────────────────────────
// refundRemainder(scheduleId, remainingHbar)
// Called when the agent finishes its task early.
// Does two things:
//   1. Cancels the scheduled auto-refund timer (so it doesn't fire again later)
//   2. Immediately sends the remaining HBAR back to the user wallet
// remainingHbar = budget minus what was spent (e.g. 1 - 0.15 = 0.85)
// ─────────────────────────────────────────────
async function refundRemainder(scheduleId, remainingHbar) {
  const userAccountId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID);
  const agentAccountId = AccountId.fromString(process.env.AGENT_ACCOUNT_ID);
  const agentPrivateKey = PrivateKey.fromStringED25519(process.env.AGENT_PRIVATE_KEY);

  // Step 1: Cancel the scheduled auto-refund timer
  // We set adminKey to the user's key in fundAgent(), so the user (operator) can delete it
  console.log('Cancelling scheduled auto-refund: ' + scheduleId);

  const deleteTx = await new ScheduleDeleteTransaction()
    .setScheduleId(ScheduleId.fromString(scheduleId))
    .execute(client);

  const deleteReceipt = await deleteTx.getReceipt(client);
  console.log('Schedule cancelled: ' + deleteReceipt.status.toString());

  // Step 2: Immediately refund the remaining HBAR from agent wallet → user wallet
  // The agent signs this since money is leaving the agent account
  console.log('Refunding ' + remainingHbar + ' HBAR to user...');

  const refundTx = await new TransferTransaction()
    .addHbarTransfer(agentAccountId, new Hbar(-remainingHbar))
    .addHbarTransfer(userAccountId, new Hbar(remainingHbar))
    .freezeWith(client)
    .sign(agentPrivateKey);

  const refundResponse = await refundTx.execute(client);
  const refundReceipt = await refundResponse.getReceipt(client);

  console.log('Refund status: ' + refundReceipt.status.toString());
  console.log('HashScan: https://hashscan.io/testnet/transaction/' + refundResponse.transactionId.toString());

  return refundResponse.transactionId.toString();
}

module.exports = { initClient, getBalance, createHCSTopic, paySubAgent, fundAgent, refundRemainder };
