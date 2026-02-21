// agentService.js
// The AI brain of PayStream. Orchestrates the multi-agent system using Claude Sonnet.

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk/index.js');
const {
  initClient,
  createHCSTopic,
  fundAgent,
  paySubAgent,
  refundRemainder,
} = require('./hederaService');

// Initialize the Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// What fraction of the total budget goes to agents (the rest is refunded)
// e.g. 0.30 means 30% is spent on agents, 70% is refunded
const AGENT_BUDGET_RATIO = 0.30;

// ─────────────────────────────────────────────
// runSubAgent(agentName, stepDescription)
// A specialized AI agent that completes one step using Claude Sonnet.
// Each agent has a different role and system prompt.
// Returns the result as a string.
// ─────────────────────────────────────────────
async function runSubAgent(agentName, stepDescription) {
  console.log('\n[' + agentName + '] Starting work...');
  console.log('[' + agentName + '] Task: ' + stepDescription);

  // Each agent has a specific personality and job
  const systemPrompts = {
    'Research Agent': 'You are a Research Agent. Your job is to find and gather relevant, factual information. Be specific and thorough. Keep your response under 200 words.',
    'Analysis Agent': 'You are an Analysis Agent. Your job is to evaluate and compare information critically. Provide clear insights. Keep your response under 200 words.',
    'Writer Agent':   'You are a Writer Agent. Your job is to synthesize information into a clean, readable summary. Keep your response under 200 words.',
  };

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: systemPrompts[agentName] || 'You are a helpful AI agent. Keep your response under 200 words.',
    messages: [{ role: 'user', content: stepDescription }],
  });

  const result = response.content[0].text;
  console.log('[' + agentName + '] Done.');
  return result;
}

// ─────────────────────────────────────────────
// formatFinalReport(task, results)
// Takes all 3 sub-agent outputs and calls Claude one final time
// to combine them into a single clean report for the user.
// ─────────────────────────────────────────────
async function formatFinalReport(task, results) {
  console.log('\nFormatting final report with Claude Sonnet...');

  const combinedResults = results
    .map((r) => '=== ' + r.agentName + ' ===\n' + r.result)
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: 'You are a report formatter. Combine the outputs from multiple AI agents into one clean, well-structured final report with clear headings.',
    messages: [{
      role: 'user',
      content: 'Original task: "' + task + '"\n\nAgent outputs:\n\n' + combinedResults + '\n\nCombine these into a single, clean final report.',
    }],
  });

  return response.content[0].text;
}

// ─────────────────────────────────────────────
// runMainAgent(task, budgetInHbar)
// The main orchestrator. This is the full PayStream flow:
//   1. Initialize Hedera client + create HCS audit trail topic
//   2. Fund agent wallet + create 10-min scheduled auto-refund
//   3. Ask Claude to break the task into 3 steps
//   4. Run each sub-agent (Research, Analysis, Writer)
//   5. After each step: pay the sub-agent + log to HCS
//   6. Format the final combined report
//   7. Cancel the scheduled refund + immediately refund remainder to user
// ─────────────────────────────────────────────
async function runMainAgent(task, budgetInHbar, onEvent = () => {}) {
  console.log('\n========================================');
  console.log('PAYSTREAM — DEPLOYING AGENT');
  console.log('Task:   ' + task);
  console.log('Budget: ' + budgetInHbar + ' HBAR');
  console.log('========================================\n');

  // Step 1: Initialize Hedera + create HCS topic
  initClient();
  await createHCSTopic();

  // Step 2: Fund agent wallet + create scheduled auto-refund on Hedera
  const scheduleId = await fundAgent(budgetInHbar);
  let remainingBudget = budgetInHbar;

  // Step 3: Ask Claude Sonnet to plan the task as 3 steps
  console.log('\nMain Agent calling Claude Sonnet to plan the task...');

  const planResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: `You are a task planner AND budget allocator. Analyze the given task, break it into 3 steps for 3 specialized agents, and assign each agent a budget allocation percentage based on the complexity of their work for THIS specific task.

Rules:
- Allocations must sum to exactly 100
- Minimum 15% per agent, maximum 60% per agent
- Research-heavy tasks: give Research Agent 45-60%
- Analysis-heavy tasks: give Analysis Agent 40-55%
- Writing/content-heavy tasks: give Writer Agent 40-55%

Respond with ONLY a valid JSON object — no extra text, no markdown.
Format: {"steps": [{"agent": "Research Agent", "task": "...", "allocation": 40}, {"agent": "Analysis Agent", "task": "...", "allocation": 35}, {"agent": "Writer Agent", "task": "...", "allocation": 25}]}`,
    messages: [{ role: 'user', content: task }],
  });

  // Parse the plan — fall back to default steps if anything goes wrong
  let steps;
  try {
    const jsonMatch = planResponse.content[0].text.match(/\{[\s\S]*\}/);
    steps = JSON.parse(jsonMatch[0]).steps;
  } catch (e) {
    console.log('Plan parsing failed, using default steps.');
    steps = [
      { agent: 'Research Agent', task: 'Research and find relevant information for: ' + task, allocation: 40 },
      { agent: 'Analysis Agent', task: 'Analyze and evaluate the findings for: ' + task,      allocation: 35 },
      { agent: 'Writer Agent',   task: 'Write a clear final report for: ' + task,             allocation: 25 },
    ];
  }

  // Calculate total HBAR pool for agents based on budget ratio
  const totalAgentBudget = Math.round(budgetInHbar * AGENT_BUDGET_RATIO * 100) / 100;

  console.log('\nPlan ready — ' + steps.length + ' steps:');
  console.log('Total agent budget: ' + totalAgentBudget + ' HBAR (30% of ' + budgetInHbar + ' HBAR)');
  steps.forEach((s, i) => {
    const payment = Math.round((s.allocation / 100) * totalAgentBudget * 100) / 100;
    console.log('  Step ' + (i + 1) + ': [' + s.agent + '] ' + s.allocation + '% → ' + payment + ' HBAR — ' + s.task);
  });

  // Step 4 + 5: Run each sub-agent, then pay it and log to HCS
  const results = [];

  for (const step of steps) {
    // Calculate this agent's dynamic payment based on allocation percentage
    const payment = Math.round((step.allocation / 100) * totalAgentBudget * 100) / 100;

    // Stop if we've run out of budget
    if (remainingBudget < payment) {
      console.log('\nBudget exhausted — stopping. Completed ' + results.length + ' of ' + steps.length + ' steps.');
      break;
    }

    // Notify frontend that this agent is starting
    onEvent({ type: 'step_start', agent: step.agent, task: step.task, allocation: step.allocation, payment });

    // Run the sub-agent using Claude Sonnet
    const result = await runSubAgent(step.agent, step.task);

    // Pay the sub-agent dynamically — logs the payment permanently to HCS
    const txId = await paySubAgent(step.agent, payment, step.task);

    // Track remaining budget
    remainingBudget = Math.round((remainingBudget - payment) * 100) / 100;
    console.log('Budget remaining: ' + remainingBudget + ' HBAR');

    // Notify frontend that this step is done with payment info
    onEvent({ type: 'step_complete', agent: step.agent, task: step.task, payment, txId, remainingBudget });

    results.push({ agentName: step.agent, task: step.task, result });
  }

  // Step 6: Combine all results into a final report
  const finalReport = await formatFinalReport(task, results);
  onEvent({ type: 'report', text: finalReport });

  // Step 7: Cancel the scheduled auto-refund + send remainder back to user immediately
  console.log('\nRefunding ' + remainingBudget + ' HBAR to user...');
  const refundTxId = await refundRemainder(scheduleId, remainingBudget);
  onEvent({ type: 'refund', amount: remainingBudget, txId: refundTxId });

  console.log('\n========================================');
  console.log('PAYSTREAM — COMPLETE');
  console.log('Spent:    ' + (budgetInHbar - remainingBudget) + ' HBAR');
  console.log('Refunded: ' + remainingBudget + ' HBAR');
  console.log('========================================\n');

  return {
    finalReport,
    results,
    spent: budgetInHbar - remainingBudget,
    refunded: remainingBudget,
    refundTxId,
  };
}

module.exports = { runMainAgent, runSubAgent, formatFinalReport };
