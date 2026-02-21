// server.js
// Express server that streams PayStream events to the React frontend
// using Server-Sent Events (SSE) — a simple one-way real-time connection.
// Run with: node server.js

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { randomUUID } = require('crypto');

const { runMainAgent }        = require('./agentService');
const { fetchRepoContent }    = require('./githubService');
const { runCodebaseAnalysis } = require('./codebaseAgentService');
const { saveReport, getReport } = require('./mongoService');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// GET /api/run?task=...&budget=...
// ─────────────────────────────────────────────
app.get('/api/run', async (req, res) => {
  const task   = req.query.task;
  const budget = parseFloat(req.query.budget);

  if (!task || isNaN(budget)) {
    return res.status(400).json({ error: 'Missing task or budget' });
  }

  console.log('\nNew run request:');
  console.log('Task:   ' + task);
  console.log('Budget: ' + budget + ' HBAR');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  try {
    await runMainAgent(task, budget, sendEvent);
  } catch (err) {
    console.error('Agent error:', err.message);
    sendEvent({ type: 'error', message: err.message });
  }

  res.end();
});

// ─────────────────────────────────────────────
// GET /api/analyze?repo=<githubUrl>&budget=<hbar>
// Fetches a GitHub repo, runs 4 codebase intelligence agents,
// saves results to MongoDB, streams everything back via SSE.
// ─────────────────────────────────────────────
app.get('/api/analyze', async (req, res) => {
  const repo   = req.query.repo;
  const budget = parseFloat(req.query.budget);

  if (!repo || isNaN(budget)) {
    return res.status(400).json({ error: 'Missing repo URL or budget' });
  }

  console.log('\nNew analyze request:');
  console.log('Repo:   ' + repo);
  console.log('Budget: ' + budget + ' HBAR');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  try {
    // Step 1: Fetch the repo from GitHub
    sendEvent({ type: 'fetching_repo', repo });
    const repoContent = await fetchRepoContent(repo);
    sendEvent({
      type: 'repo_fetched',
      meta: {
        repoName: repoContent.repoName,
        fileCount: repoContent.fileCount,
        languages: repoContent.languages,
      },
    });

    // Step 2: Build a persistFn — saves the finished report to MongoDB
    //         and returns a shareId that the frontend uses to build the share URL.
    //         Gracefully skipped if MONGODB_URI is not configured.
    const persistFn = process.env.MONGODB_URI
      ? async (results) => {
          const shareId = randomUUID().replace(/-/g, '').slice(0, 16);
          await saveReport({
            shareId,
            repoName: repoContent.repoName,
            repoUrl:  repo,
            meta: {
              fileCount: repoContent.fileCount,
              languages: repoContent.languages,
            },
            data: results,
          });
          return shareId;
        }
      : null;

    // Step 3: Run the 4-agent analysis pipeline (fires SSE events + saves)
    await runCodebaseAnalysis(repoContent, budget, sendEvent, persistFn);

  } catch (err) {
    console.error('Analysis error:', err.message);
    sendEvent({ type: 'error', message: err.message });
  }

  res.end();
});

// ─────────────────────────────────────────────
// GET /api/report/:shareId
// Returns the full saved report JSON for the CEO share page.
// ─────────────────────────────────────────────
app.get('/api/report/:shareId', async (req, res) => {
  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'MongoDB not configured on this server.' });
  }
  try {
    const report = await getReport(req.params.shareId);
    if (!report) return res.status(404).json({ error: 'Report not found or expired.' });
    res.json(report);
  } catch (err) {
    console.error('Report fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'PayStream server is running' });
});

app.listen(PORT, () => {
  console.log('PayStream server running on http://localhost:' + PORT);
  console.log('Ready to receive requests from the frontend.');
  if (!process.env.MONGODB_URI) {
    console.log('[MongoDB] MONGODB_URI not set — share-link feature disabled.');
  }
});
