// mongoService.js
// MongoDB persistence layer for PayStream analysis reports.
// Reports are saved after every successful analysis run and can be
// retrieved by shareId to render the CEO-facing shareable page.

require('dotenv').config();
const mongoose = require('mongoose');

// ─── Schema ───────────────────────────────────────────────────────────────────

const reportSchema = new mongoose.Schema(
  {
    _id:      { type: String },          // shareId (16-char hex from randomUUID)
    repoName: { type: String },
    repoUrl:  { type: String },
    meta:     { type: mongoose.Schema.Types.Mixed },  // { fileCount, languages }
    data:     { type: mongoose.Schema.Types.Mixed },  // { codeReader, simplifier, analogy, insight }
    createdAt:{ type: Date, default: Date.now },
  },
  { _id: false }
);

// Auto-delete reports after 30 days
reportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

const Report = mongoose.model('Report', reportSchema);

// ─── Connection ───────────────────────────────────────────────────────────────

async function connectDB() {
  if (mongoose.connection.readyState === 1) return; // already connected
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(uri);
  console.log('[MongoDB] Connected');
}

// ─── Save / Fetch ─────────────────────────────────────────────────────────────

async function saveReport({ shareId, repoName, repoUrl, meta, data }) {
  await connectDB();
  const doc = new Report({ _id: shareId, repoName, repoUrl, meta, data });
  await doc.save();
  return shareId;
}

async function getReport(shareId) {
  await connectDB();
  return Report.findById(shareId).lean();
}

module.exports = { saveReport, getReport };
