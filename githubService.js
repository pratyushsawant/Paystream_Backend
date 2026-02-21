// githubService.js
// Fetches repository content from GitHub.
//
// Strategy: only 2 GitHub API calls regardless of repo size.
//   Call 1: GET /repos/{owner}/{repo}          → get default branch name
//   Call 2: GET /git/trees/{branch}?recursive=1 → get full file tree
//   Files:  raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}  ← NO rate limit
//
// This avoids the 60 req/hr unauthenticated API limit entirely for file fetching.

require('dotenv').config();

const GITHUB_API    = 'https://api.github.com';
const GITHUB_RAW    = 'https://raw.githubusercontent.com';

const ALLOWED_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.cs', '.cpp', '.c', '.h',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.env.example', '.env.sample', '.env.template',
  '.graphql', '.gql', '.sql', '.prisma',
]);

const ALWAYS_INCLUDE = new Set([
  'package.json', 'requirements.txt', 'pipfile', 'go.mod', 'cargo.toml',
  'gemfile', 'pom.xml', 'build.gradle', 'dockerfile', 'docker-compose.yml',
  'docker-compose.yaml', '.env.example', '.env.sample', 'readme.md', 'readme',
  '.gitignore', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
  'webpack.config.js', 'next.config.js', 'next.config.ts',
  'tailwind.config.js', 'tailwind.config.ts',
]);

const SKIP_DIRS = [
  'node_modules/', 'dist/', 'build/', '.git/', '__pycache__/', '.next/',
  'vendor/', '.venv/', 'venv/', 'coverage/', '.nyc_output/', 'target/',
  '.gradle/', '.idea/', '.vscode/', 'out/', '.cache/',
];

const MAX_FILES          = 50;
const MAX_TOTAL_BYTES    = 100000;
const MAX_BYTES_PER_FILE = 3000;

function shouldIncludeFile(path) {
  const lower = path.toLowerCase();
  if (SKIP_DIRS.some((dir) => lower.includes(dir))) return false;
  if (lower.endsWith('.lock') || lower.endsWith('-lock.json')) return false;
  const basename = lower.split('/').pop();
  if (ALWAYS_INCLUDE.has(basename)) return true;
  const dot = basename.lastIndexOf('.');
  if (dot === -1) return false;
  return ALLOWED_EXTENSIONS.has(basename.slice(dot));
}

function parseGithubUrl(url) {
  const cleaned = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const match   = cleaned.match(/github\.com[\/:]([^\/]+)\/([^\/\?#]+)/);
  if (!match) throw new Error('Invalid GitHub URL. Expected: https://github.com/owner/repo');
  return { owner: match[1], repo: match[2] };
}

function apiHeaders() {
  const h = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'PayStream' };
  if (process.env.GITHUB_TOKEN) h['Authorization'] = 'token ' + process.env.GITHUB_TOKEN;
  return h;
}

async function fetchRepoContent(githubUrl) {
  const { owner, repo } = parseGithubUrl(githubUrl);
  console.log('\nFetching repo: ' + owner + '/' + repo);

  // ── API Call 1: get default branch ──────────────────────────────────────────
  const repoRes = await fetch(GITHUB_API + '/repos/' + owner + '/' + repo, { headers: apiHeaders() });
  if (!repoRes.ok) {
    if (repoRes.status === 404) throw new Error('Repo not found or is private: ' + owner + '/' + repo);
    if (repoRes.status === 403) throw new Error('GitHub API rate limit hit on repo metadata. Wait 1 hour or add GITHUB_TOKEN to .env');
    throw new Error('GitHub API error ' + repoRes.status);
  }
  const repoData      = await repoRes.json();
  const defaultBranch = repoData.default_branch || 'main';
  console.log('Default branch: ' + defaultBranch);

  // ── API Call 2: get file tree ────────────────────────────────────────────────
  const treeRes = await fetch(
    GITHUB_API + '/repos/' + owner + '/' + repo + '/git/trees/' + defaultBranch + '?recursive=1',
    { headers: apiHeaders() }
  );
  if (!treeRes.ok) {
    if (treeRes.status === 403) throw new Error('GitHub API rate limit hit on tree fetch. Wait 1 hour or add GITHUB_TOKEN to .env');
    throw new Error('Failed to fetch repo tree: ' + treeRes.status);
  }
  const treeData = await treeRes.json();
  if (treeData.truncated) console.log('Warning: tree truncated (very large repo)');

  // ── Filter + sort blobs ──────────────────────────────────────────────────────
  const allBlobs = (treeData.tree || []).filter(
    (n) => n.type === 'blob' && shouldIncludeFile(n.path)
  );
  allBlobs.sort((a, b) => {
    const da = (a.path.match(/\//g) || []).length;
    const db = (b.path.match(/\//g) || []).length;
    return da !== db ? da - db : a.path.localeCompare(b.path);
  });
  const blobs = allBlobs.slice(0, MAX_FILES);

  // ── Detect languages ─────────────────────────────────────────────────────────
  const langCount = {};
  blobs.forEach((f) => {
    const ext = f.path.split('.').pop();
    if (ext && ext !== f.path) langCount[ext] = (langCount[ext] || 0) + 1;
  });
  const languages = Object.entries(langCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([l]) => l);

  // ── Fetch file contents via raw.githubusercontent.com (no rate limit) ────────
  const files      = [];
  let   totalBytes = 0;
  const batches    = [];
  for (let i = 0; i < blobs.length; i += 10) batches.push(blobs.slice(i, i + 10));

  for (const batch of batches) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;

    const results = await Promise.all(
      batch.map(async (blob) => {
        try {
          const rawUrl = GITHUB_RAW + '/' + owner + '/' + repo + '/' + defaultBranch + '/' + blob.path;
          const res    = await fetch(rawUrl);          // no auth headers needed for raw
          if (!res.ok) return null;
          const text = await res.text();
          return { path: blob.path, content: text.slice(0, MAX_BYTES_PER_FILE) };
        } catch { return null; }
      })
    );

    for (const f of results) {
      if (!f) continue;
      totalBytes += f.content.length;
      if (totalBytes > MAX_TOTAL_BYTES) break;
      files.push(f);
    }
  }

  console.log('Fetched ' + files.length + ' files | ' + Math.round(totalBytes / 1024) + 'KB | ' + languages.join(', '));

  return { owner, repo, repoName: owner + '/' + repo, fileCount: files.length, languages, files };
}

module.exports = { fetchRepoContent, parseGithubUrl };
