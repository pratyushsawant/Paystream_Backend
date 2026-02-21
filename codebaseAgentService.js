// codebaseAgentService.js
// 4-agent codebase intelligence orchestrator.
// Uses Claude tool_use API for guaranteed structured JSON output per agent.
// Plugs into existing hederaService.js — zero changes to blockchain layer.

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk/index.js');
const {
  initClient,
  createHCSTopic,
  fundAgent,
  paySubAgent,
  refundRemainder,
} = require('./hederaService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AGENT_BUDGET_RATIO = 0.30;
const AGENT_ALLOCATIONS  = {
  'Code Reader Agent': 30,
  'Simplifier Agent':  20,
  'Analogy Agent':     25,
  'Insight Agent':     25,
};

// ─────────────────────────────────────────────
// buildFilesSummary(files, maxFiles, maxCharsPerFile)
// Builds a compact, token-efficient dump of the most important files.
// Prioritises: root-level files, package.json, README, entry points.
// ─────────────────────────────────────────────
function buildFilesSummary(files, maxFiles, maxCharsPerFile) {
  // Priority score — lower = more important
  const priority = (path) => {
    const lower = path.toLowerCase();
    const depth = (path.match(/\//g) || []).length;
    if (['package.json', 'readme.md', 'go.mod', 'cargo.toml', 'requirements.txt'].includes(lower)) return 0;
    if (lower.includes('index.') || lower.includes('main.') || lower.includes('app.')) return 1;
    if (lower.includes('server') || lower.includes('router') || lower.includes('route')) return 2;
    if (lower.includes('config') || lower.includes('.env')) return 3;
    return 4 + depth;
  };

  const sorted = [...files].sort((a, b) => priority(a.path) - priority(b.path));
  return sorted
    .slice(0, maxFiles)
    .map((f) => '=== ' + f.path + ' ===\n' + f.content.slice(0, maxCharsPerFile))
    .join('\n\n');
}

// ─────────────────────────────────────────────
// callWithToolUse — shared Claude tool_use helper
// ─────────────────────────────────────────────
async function callWithToolUse(systemPrompt, userPrompt, toolName, toolDescription, inputSchema, maxTokens) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 4096,
    system: systemPrompt,
    tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error(toolName + ' returned no structured output (stop_reason: ' + response.stop_reason + ')');
  return block.input;
}

// ─────────────────────────────────────────────
// runCodeReaderAgent
// Input: compact file dump (~20 files, 1500 chars each ≈ 30KB)
// Output: architecture map, tech stack, modules, dependencies
// ─────────────────────────────────────────────
async function runCodeReaderAgent(repoContent) {
  console.log('[Code Reader Agent] Starting...');

  // ← KEY FIX: only send 20 files, 1500 chars each — keeps input ~30KB
  const filesDump = buildFilesSummary(repoContent.files, 20, 1500);

  const userPrompt =
    'Analyze this codebase: ' + repoContent.repoName + '\n' +
    'Languages: ' + repoContent.languages.join(', ') + '\n\n' +
    'FILES (top 20 by importance):\n' + filesDump;

  const result = await callWithToolUse(
    'You are an expert software architect. Analyze the codebase and produce structured insights. ' +
    'For Mermaid diagrams use ONLY "graph TD" syntax with short alphanumeric node IDs (e.g. A, B, FE, API). ' +
    'No parentheses in node IDs. Labels go in square brackets. Keep to 10 nodes max. ' +
    'Example: graph TD\n  FE[Frontend] --> API[API Server]\n  API --> DB[Database]',
    userPrompt,
    'code_reader_output',
    'Structured codebase analysis: architecture, tech stack, modules, dependencies',
    {
      type: 'object',
      properties: {
        architectureMap: {
          type: 'object',
          properties: {
            mermaid: { type: 'string', description: 'Valid Mermaid graph TD. Max 10 nodes. Short IDs only.' },
            description: { type: 'string', description: '2-3 plain-English sentences about the architecture.' },
          },
          required: ['mermaid', 'description'],
        },
        techStack: {
          type: 'array',
          description: 'All significant technologies used. Include at least 4 items.',
          items: {
            type: 'object',
            properties: {
              name:     { type: 'string' },
              role:     { type: 'string', description: 'What it does in this project. One sentence.' },
              category: { type: 'string', enum: ['frontend', 'backend', 'database', 'infrastructure', 'ai', 'blockchain', 'testing', 'tooling', 'auth', 'payments'] },
            },
            required: ['name', 'role', 'category'],
          },
        },
        modules: {
          type: 'array',
          description: 'Key folders/files. Include at least 4 items.',
          items: {
            type: 'object',
            properties: {
              path:    { type: 'string' },
              purpose: { type: 'string', description: 'One plain-English sentence, no jargon.' },
              type:    { type: 'string', enum: ['feature', 'config', 'util', 'test', 'api', 'ui', 'model', 'service'] },
            },
            required: ['path', 'purpose', 'type'],
          },
        },
        dependencies: {
          type: 'array',
          description: 'Key packages with risk assessment. Include at least 4 items.',
          items: {
            type: 'object',
            properties: {
              name:    { type: 'string' },
              purpose: { type: 'string' },
              risk:    { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['name', 'purpose', 'risk'],
          },
        },
      },
      required: ['architectureMap', 'techStack', 'modules', 'dependencies'],
    },
    4096  // ← increased from 2048
  );

  // Defensive: ensure arrays exist even if Claude skips them
  result.techStack    = result.techStack    || [];
  result.modules      = result.modules      || [];
  result.dependencies = result.dependencies || [];
  if (!result.architectureMap) result.architectureMap = { mermaid: 'graph TD\n  A[App]', description: 'No architecture data available.' };

  console.log('[Code Reader Agent] Got ' + result.techStack.length + ' tech items, ' + result.modules.length + ' modules');
  return result;
}

// ─────────────────────────────────────────────
// runSimplifierAgent
// Input: Code Reader output (compact, already processed)
// Output: code flow story, glossary, onboarding doc
// ─────────────────────────────────────────────
async function runSimplifierAgent(repoContent, codeReaderResult) {
  console.log('[Simplifier Agent] Starting...');

  // Defensive fallbacks — guard against partial Code Reader output
  const modules  = codeReaderResult.modules      || [];
  const techStack = codeReaderResult.techStack   || [];
  const archDesc  = (codeReaderResult.architectureMap || {}).description || '';

  const moduleList  = modules.map((m)  => m.path + ': ' + m.purpose).join('\n') || 'No module data';
  const techList    = techStack.map((t) => t.name + ': ' + t.role).join('\n')    || 'No tech stack data';
  const fileSamples = buildFilesSummary(repoContent.files, 8, 500);

  const userPrompt =
    'Project: ' + repoContent.repoName + '\n\n' +
    'Architecture: ' + archDesc + '\n\n' +
    'Modules:\n' + moduleList + '\n\n' +
    'Tech Stack:\n' + techList + '\n\n' +
    'Key files:\n' + fileSamples;

  return callWithToolUse(
    'You are a technical writer who makes complex code understandable to non-engineers. ' +
    'Use simple language, short sentences, and "when X → then Y" patterns for flows.',
    userPrompt,
    'simplifier_output',
    'Plain English explanations: code flow, glossary, onboarding guide',
    {
      type: 'object',
      properties: {
        codeFlow: {
          type: 'string',
          description: 'Step-by-step narrative of main user interaction using → arrows. 3-5 steps.',
        },
        glossary: {
          type: 'array',
          description: 'Technical terms explained simply. Min 6 items.',
          items: {
            type: 'object',
            properties: {
              term:  { type: 'string' },
              plain: { type: 'string', description: 'One sentence, use analogies.' },
            },
            required: ['term', 'plain'],
          },
        },
        onboardingDoc: {
          type: 'string',
          description: 'Markdown "Week 1 guide" for new devs. Max 300 words. Cover: what it does, key files, how to run.',
        },
      },
      required: ['codeFlow', 'glossary', 'onboardingDoc'],
    },
    4096
  );
}

// ─────────────────────────────────────────────
// runAnalogyAgent
// Input: Code Reader output
// Output: tech analogies, CEO deck (5 slides)
// ─────────────────────────────────────────────
async function runAnalogyAgent(repoContent, codeReaderResult) {
  console.log('[Analogy Agent] Starting...');

  // Defensive fallbacks
  const techStack = codeReaderResult.techStack || [];
  const modules   = codeReaderResult.modules   || [];
  const archDesc  = (codeReaderResult.architectureMap || {}).description || '';

  const techList   = techStack.map((t) => t.name + ' (' + t.category + '): ' + t.role).join('\n') || 'No tech stack data';
  const moduleList = modules.map((m) => m.purpose).join('\n') || 'No module data';

  const userPrompt =
    'Project: ' + repoContent.repoName + '\n' +
    'Architecture: ' + archDesc + '\n\n' +
    'Tech Stack:\n' + techList + '\n\n' +
    'What modules do:\n' + moduleList;

  return callWithToolUse(
    'You are a CTO who explains technical products to executives using vivid, memorable analogies. ' +
    'CEO deck must be polished, jargon-free, and ready to present to a board.',
    userPrompt,
    'analogy_output',
    'Tech analogies and CEO deck (5 slides)',
    {
      type: 'object',
      properties: {
        techAnalogies: {
          type: 'array',
          description: 'Real-world analogy for each technology. Min 4 items.',
          items: {
            type: 'object',
            properties: {
              tech:   { type: 'string' },
              analogy:{ type: 'string', description: 'One vivid real-world analogy sentence.' },
              what:   { type: 'string', description: 'What it does in this project. One sentence.' },
            },
            required: ['tech', 'analogy', 'what'],
          },
        },
        ceoSlides: {
          type: 'array',
          description: 'Exactly 5 CEO presentation slides.',
          items: {
            type: 'object',
            properties: {
              slideNumber: { type: 'number' },
              title:       { type: 'string' },
              content:     { type: 'string', description: '3-5 bullets or 2 short paragraphs. No jargon.' },
              speakerNote: { type: 'string', description: 'One sentence the presenter says.' },
            },
            required: ['slideNumber', 'title', 'content', 'speakerNote'],
          },
        },
      },
      required: ['techAnalogies', 'ceoSlides'],
    },
    4096
  );
}

// ─────────────────────────────────────────────
// runInsightAgent
// Input: raw files + Code Reader summary
// Output: complexity score, red flags, scalability, tech debt
// ─────────────────────────────────────────────
async function runInsightAgent(repoContent, codeReaderResult) {
  console.log('[Insight Agent] Starting...');

  // Defensive fallbacks
  const deps     = codeReaderResult.dependencies || [];
  const archDesc = (codeReaderResult.architectureMap || {}).description || '';

  const fileSamples = buildFilesSummary(repoContent.files, 12, 1000);
  const depList     = deps.map((d) => d.name + ': ' + d.purpose).join('\n') || 'No dependency data';

  const userPrompt =
    'Codebase: ' + repoContent.repoName + '\n' +
    'Languages: ' + repoContent.languages.join(', ') + '\n' +
    'Architecture: ' + archDesc + '\n\n' +
    'Dependencies:\n' + depList + '\n\n' +
    'Key files:\n' + fileSamples;

  return callWithToolUse(
    'You are a senior engineering consultant reviewing codebases for CTOs and VCs. ' +
    'Be specific, honest, and base findings only on evidence in the shown code.',
    userPrompt,
    'insight_output',
    'Complexity score, red flags, scalability, tech debt, rebuild suggestion',
    {
      type: 'object',
      properties: {
        complexityScore: {
          type: 'object',
          properties: {
            score:         { type: 'number', description: '1-10 integer' },
            label:         { type: 'string', enum: ['Simple', 'Moderate', 'Complex', 'Very Complex'] },
            reasoning:     { type: 'string', description: '2-3 sentences with specific evidence.' },
            cleanParts:    { type: 'string' },
            overEngineered:{ type: 'string' },
          },
          required: ['score', 'label', 'reasoning'],
        },
        redFlags: {
          type: 'array',
          description: 'Real issues with evidence. Max 6.',
          items: {
            type: 'object',
            properties: {
              severity:   { type: 'string', enum: ['low', 'medium', 'high'] },
              issue:      { type: 'string' },
              location:   { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['severity', 'issue', 'location', 'suggestion'],
          },
        },
        scalability: {
          type: 'object',
          properties: {
            canHandle10x: { type: 'boolean' },
            bottleneck:   { type: 'string' },
            assessment:   { type: 'string', description: '2-3 plain-English sentences.' },
          },
          required: ['canHandle10x', 'bottleneck', 'assessment'],
        },
        techDebt: {
          type: 'array',
          description: 'Tech debt items. Max 5.',
          items: {
            type: 'object',
            properties: {
              item:   { type: 'string' },
              effort: { type: 'string', enum: ['low', 'medium', 'high'] },
              impact: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['item', 'effort', 'impact'],
          },
        },
        rebuildSuggestion: {
          type: 'string',
          description: 'If starting fresh: what would you change? 3-4 specific sentences.',
        },
      },
      required: ['complexityScore', 'redFlags', 'scalability', 'techDebt', 'rebuildSuggestion'],
    },
    4096
  );
}

// ─────────────────────────────────────────────
// runCodebaseAnalysis — parallel orchestrator
//
// Phase 1 (sequential): Code Reader Agent — must finish first,
//   its output feeds all 3 downstream agents.
//
// Phase 2 (parallel):   Simplifier + Analogy + Insight run
//   simultaneously via Promise.allSettled — 3x faster.
// ─────────────────────────────────────────────
// persistFn(results) → optional async fn that saves the report and returns a shareId
async function runCodebaseAnalysis(repoContent, budgetInHbar, onEvent, persistFn) {
  if (!onEvent) onEvent = function () {};

  console.log('\n========================================');
  console.log('PAYSTREAM — CODEBASE INTELLIGENCE (PARALLEL)');
  console.log('Repo:   ' + repoContent.repoName);
  console.log('Files:  ' + repoContent.fileCount);
  console.log('Budget: ' + budgetInHbar + ' HBAR');
  console.log('========================================\n');

  initClient();
  await createHCSTopic();
  const scheduleId = await fundAgent(budgetInHbar);
  let remainingBudget = budgetInHbar;

  const totalAgentBudget = Math.round(budgetInHbar * AGENT_BUDGET_RATIO * 100) / 100;
  console.log('Agent pool: ' + totalAgentBudget + ' HBAR');

  const pay = (name) => Math.round((AGENT_ALLOCATIONS[name] / 100) * totalAgentBudget * 100) / 100;
  const results = {};

  // ── PHASE 1: Code Reader (sequential — foundation for all others) ──────────

  const crPayment = pay('Code Reader Agent');
  onEvent({ type: 'agent_start', agent: 'Code Reader Agent', allocation: AGENT_ALLOCATIONS['Code Reader Agent'], payment: crPayment });

  try {
    results.codeReader = await runCodeReaderAgent(repoContent);
  } catch (err) {
    console.error('[Code Reader Agent] Error: ' + err.message);
    onEvent({ type: 'agent_error', agent: 'Code Reader Agent', message: err.message });
    // Provide fallback so phase 2 doesn't crash
    results.codeReader = { techStack: [], modules: [], dependencies: [], architectureMap: { mermaid: 'graph TD\n  A[App]', description: 'Analysis unavailable.' } };
  }

  const crTxId = await paySubAgent('Code Reader Agent', crPayment, 'Codebase intelligence for ' + repoContent.repoName);
  remainingBudget = Math.round((remainingBudget - crPayment) * 100) / 100;
  onEvent({ type: 'agent_complete', agent: 'Code Reader Agent', key: 'codeReader', result: results.codeReader, txId: crTxId, payment: crPayment, remainingBudget });
  console.log('[Code Reader Agent] done. Remaining: ' + remainingBudget + ' HBAR');

  // ── PHASE 2: Simplifier + Analogy + Insight — all 3 in parallel ───────────

  const phase2 = [
    { name: 'Simplifier Agent', key: 'simplifier', fn: () => runSimplifierAgent(repoContent, results.codeReader) },
    { name: 'Analogy Agent',    key: 'analogy',    fn: () => runAnalogyAgent(repoContent,    results.codeReader) },
    { name: 'Insight Agent',    key: 'insight',    fn: () => runInsightAgent(repoContent,     results.codeReader) },
  ];

  // Emit all 3 "starting" events at the same time — they're all spinning up now
  phase2.forEach((a) => {
    onEvent({ type: 'agent_start', agent: a.name, allocation: AGENT_ALLOCATIONS[a.name], payment: pay(a.name) });
  });

  console.log('[Phase 2] Launching Simplifier, Analogy, Insight in parallel...');

  // Run all 3 Claude calls simultaneously
  const phase2Results = await Promise.allSettled(phase2.map((a) => a.fn()));

  // Process results — pay each one and emit complete/error
  await Promise.all(phase2.map(async (agentDef, i) => {
    const settled  = phase2Results[i];
    const payment  = pay(agentDef.name);
    const jobDesc  = 'Codebase intelligence for ' + repoContent.repoName;

    if (settled.status === 'fulfilled') {
      results[agentDef.key] = settled.value;
      const txId = await paySubAgent(agentDef.name, payment, jobDesc);
      remainingBudget = Math.round((remainingBudget - payment) * 100) / 100;
      onEvent({ type: 'agent_complete', agent: agentDef.name, key: agentDef.key, result: settled.value, txId, payment, remainingBudget });
      console.log('[' + agentDef.name + '] done. Remaining: ' + remainingBudget + ' HBAR');
    } else {
      console.error('[' + agentDef.name + '] Error: ' + settled.reason.message);
      onEvent({ type: 'agent_error', agent: agentDef.name, message: settled.reason.message });
    }
  }));

  onEvent({ type: 'analysis_complete', data: results });

  // Persist report to MongoDB and notify frontend with a shareable ID
  if (typeof persistFn === 'function') {
    try {
      const shareId = await persistFn(results);
      if (shareId) {
        onEvent({ type: 'report_saved', shareId });
        console.log('[MongoDB] Report saved — shareId:', shareId);
      }
    } catch (err) {
      console.error('[MongoDB] Failed to save report:', err.message);
    }
  }

  console.log('\nRefunding ' + remainingBudget + ' HBAR...');
  const refundTxId = await refundRemainder(scheduleId, remainingBudget);
  onEvent({ type: 'refund', amount: remainingBudget, txId: refundTxId });

  console.log('\n========================================');
  console.log('COMPLETE — Spent: ' + (budgetInHbar - remainingBudget).toFixed(4) + ' | Refunded: ' + remainingBudget.toFixed(4));
  console.log('========================================\n');

  return { results, spent: budgetInHbar - remainingBudget, refunded: remainingBudget };
}

module.exports = { runCodebaseAnalysis };
