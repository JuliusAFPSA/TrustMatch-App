'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const multer     = require('multer');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const Database   = require('better-sqlite3');
const Anthropic  = require('@anthropic-ai/sdk');

// ── Config ────────────────────────────────────
const PORT        = process.env.PORT || 4000;
const DEV_JWT     = 'skillbridge-dev-secret-change-in-prod';
const JWT_SECRET  = process.env.JWT_SECRET || DEV_JWT;
const JWT_EXPIRY  = '7d';
const SALT_ROUNDS = 12;  // upgraded from 10 — better brute-force resistance

if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEV_JWT) {
  console.error('\n  FATAL: JWT_SECRET must be set in production. Aborting.\n');
  process.exit(1);
}
const UPLOAD_DIR  = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Anthropic config ──────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-haiku-4-5-20251001';

if (!ANTHROPIC_API_KEY) {
  console.warn('  [anthropic] ANTHROPIC_API_KEY not set — AI features will be unavailable');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── External API keys ─────────────────────────
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';  // serpapi.com — 100 free searches/month

// ── Database ──────────────────────────────────
const db = new Database(path.join(__dirname, 'data', 'skillbridge.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'jobseeker',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cv_documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename   TEXT,
    source     TEXT    NOT NULL DEFAULT 'upload',
    raw_text   TEXT,
    parsed_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cv_experiences (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cv_doc_id           INTEGER REFERENCES cv_documents(id),
    role                TEXT,
    company             TEXT,
    start_date          TEXT,
    end_date            TEXT,
    description         TEXT,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    created_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cv_education (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cv_doc_id           INTEGER REFERENCES cv_documents(id),
    degree              TEXT,
    institution         TEXT,
    year                TEXT,
    grade               TEXT,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    created_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cv_certifications (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cv_doc_id           INTEGER REFERENCES cv_documents(id),
    name                TEXT,
    issuer              TEXT,
    date                TEXT,
    credential_id       TEXT,
    verification_status TEXT NOT NULL DEFAULT 'pending',
    created_at          TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cv_skills (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill   TEXT    NOT NULL,
    source  TEXT    DEFAULT 'cv'
  );

  CREATE TABLE IF NOT EXISTS cv_personal (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT,
    title      TEXT,
    email      TEXT,
    phone      TEXT,
    location   TEXT,
    summary    TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Safe schema migrations
['cv_experiences', 'cv_education', 'cv_certifications'].forEach(tbl => {
  try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN needs_review INTEGER DEFAULT 0`); } catch {}
});

// ── Prepared statements ───────────────────────
const stmts = {
  findByEmail  : db.prepare('SELECT * FROM users WHERE email = ?'),
  findById     : db.prepare('SELECT id, name, email, role, created_at, last_login FROM users WHERE id = ?'),
  insertUser   : db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)'),
  updateLogin  : db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?"),
  insertSession: db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at)
                             VALUES (?, ?, datetime('now','+7 days'))`),

  insertDoc    : db.prepare('INSERT INTO cv_documents (user_id, filename, source, raw_text) VALUES (?, ?, ?, ?)'),
  deleteOldExp : db.prepare('DELETE FROM cv_experiences WHERE user_id = ?'),
  deleteOldEdu : db.prepare('DELETE FROM cv_education    WHERE user_id = ?'),
  deleteOldCert: db.prepare('DELETE FROM cv_certifications WHERE user_id = ?'),
  deleteOldSkill: db.prepare('DELETE FROM cv_skills WHERE user_id = ?'),

  insertExp    : db.prepare(`INSERT INTO cv_experiences
    (user_id,cv_doc_id,role,company,start_date,end_date,description,verification_status,needs_review)
    VALUES (?,?,?,?,?,?,?,?,?)`),
  insertEdu    : db.prepare(`INSERT INTO cv_education
    (user_id,cv_doc_id,degree,institution,year,grade,verification_status,needs_review)
    VALUES (?,?,?,?,?,?,?,?)`),
  insertCert   : db.prepare(`INSERT INTO cv_certifications
    (user_id,cv_doc_id,name,issuer,date,credential_id,verification_status,needs_review)
    VALUES (?,?,?,?,?,?,?,?)`),
  insertSkill  : db.prepare('INSERT INTO cv_skills (user_id,skill,source) VALUES (?,?,?)'),

  getCVData    : db.prepare(`SELECT * FROM cv_documents WHERE user_id = ? ORDER BY id DESC LIMIT 1`),
  getExp       : db.prepare('SELECT * FROM cv_experiences WHERE user_id = ? ORDER BY id'),
  getEdu       : db.prepare('SELECT * FROM cv_education WHERE user_id = ? ORDER BY id'),
  getCerts     : db.prepare('SELECT * FROM cv_certifications WHERE user_id = ? ORDER BY id'),
  getSkills    : db.prepare('SELECT skill FROM cv_skills WHERE user_id = ?'),

  updateExpStatus  : db.prepare('UPDATE cv_experiences   SET verification_status=? WHERE id=? AND user_id=?'),
  updateEduStatus  : db.prepare('UPDATE cv_education     SET verification_status=? WHERE id=? AND user_id=?'),
  updateCertStatus : db.prepare('UPDATE cv_certifications SET verification_status=? WHERE id=? AND user_id=?'),

  upsertPersonal   : db.prepare(`INSERT INTO cv_personal (user_id,name,title,email,phone,location,summary,updated_at)
                                 VALUES (?,?,?,?,?,?,?,datetime('now'))
                                 ON CONFLICT(user_id) DO UPDATE SET
                                   name=excluded.name, title=excluded.title, email=excluded.email,
                                   phone=excluded.phone, location=excluded.location,
                                   summary=excluded.summary, updated_at=datetime('now')`),
  getPersonal      : db.prepare('SELECT * FROM cv_personal WHERE user_id = ?'),
};

// ── Auto-verification lists ───────────────────
const AUTO_VERIFIED_COMPANIES = [
  'google','meta','facebook','apple','microsoft','amazon','netflix','nvidia','ibm',
  'oracle','salesforce','adobe','sap','accenture','deloitte','pwc','kpmg','ey',
  'mckinsey','bain','bcg','dbs','ocbc','uob','singtel','grab','sea','shopee',
  'government','ministry','agency','hospital','institute','bank','capital'
];
const AUTO_VERIFIED_INSTITUTIONS = [
  'nus','ntu','smu','sutd','sit','sim','national university','nanyang','singapore management',
  'oxford','cambridge','harvard','mit','stanford','yale','imperial','lse','nus',
  'polytechnic','temasek','ngee ann','republic','singapore poly','ite'
];
const AUTO_VERIFIED_CERT_ISSUERS = [
  'google','aws','amazon','microsoft','oracle','salesforce','cisco','comptia',
  'coursera','linkedin','pmi','isc2','isaca','ec-council','scrum','axelos',
  'professional development board','ibm','adobe','vmware'
];

function autoVerifyCompany(company = '') {
  const lc = company.toLowerCase();
  return AUTO_VERIFIED_COMPANIES.some(k => lc.includes(k)) ? 'auto_verified' : 'pending';
}
function autoVerifyInstitution(institution = '') {
  const lc = institution.toLowerCase();
  return AUTO_VERIFIED_INSTITUTIONS.some(k => lc.includes(k)) ? 'auto_verified' : 'pending';
}
function autoVerifyCertIssuer(issuer = '') {
  const lc = issuer.toLowerCase();
  return AUTO_VERIFIED_CERT_ISSUERS.some(k => lc.includes(k)) ? 'auto_verified' : 'pending';
}

// ── CV text pre-processor ─────────────────────
// Splits raw text into labelled sections, then groups each section's
// lines into discrete entries (one entry = one job / degree / cert).
// This runs BEFORE the LLM so the model only sees pre-structured input.

// Section headings are short standalone labels — they match the FULL line
// (keyword + optional trailing spaces/colons/dashes). This prevents content
// lines like "Project Management Professional..." or "Certified UiPath..."
// from falsely triggering a section switch.
const SECTION_RE = {
  experience    : /^(work\s+experience|professional\s+experience|employment(\s+history)?|work\s+history|career(\s+history)?|experience)\s*[:\-]?\s*$/i,
  education     : /^(education|academic\s+(background|qualifications?)?|qualifications?)\s*[:\-]?\s*$/i,
  certifications: /^(certifications?|licen[sc]es?\s*(and\s*certifications?)?|credentials?|professional\s+development)\s*[:\-]?\s*$/i,
  skills        : /^((technical\s+)?skills?|core\s+competencies|key\s+skills?|expertise|proficiencies)\s*[:\-]?\s*$/i,
  _ignore       : /^(key\s+projects?|projects?|achievements?|awards?|publications?|references?|interests?|hobbies|volunteer(\s+experience)?|activities|languages?|additional\s+info)\s*[:\-]?\s*$/i,
};
const BULLET_RE     = /^[\uf0b7\uf0a7•·▪▸\-\*>◦●]\s*/;  // includes Windows/PDF Wingdings bullets
const DATE_RANGE_RE = /((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*)?\d{4}\s*[-–—to]+\s*((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|\d{4}|present|current|now)/i;

function splitSections(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(l => l.trim());
  let current = null;
  const sections = { experience: [], education: [], certifications: [], skills: [], header: [] };
  for (const line of lines) {
    if (!line) continue;
    let hit = false;
    for (const [sec, re] of Object.entries(SECTION_RE)) {
      if (re.test(line)) { current = sec; hit = true; break; }
    }
    // _ignore sections (KEY PROJECTS, AWARDS, etc.) are dropped entirely
    if (!hit && current !== '_ignore') (sections[current] || sections.header).push(line);
  }
  return sections;
}

// Returns true when a string looks like a job title rather than a company name.
// Used to handle LinkedIn-style CVs that put company name before job title.
function looksLikeJobTitle(s) {
  return /\b(engineer|manager|designer|developer|analyst|director|lead|head|vp|vice.president|chief|officer|specialist|consultant|associate|intern|coordinator|architect|strategist|scientist|researcher|advisor|partner|executive|president|founder|co.founder|technologist|technician|programmer|administrator|operator|accountant|auditor|lawyer|attorney|recruiter|editor|writer|producer|marketer)\b/i.test(s);
}

// Group a flat list of section lines into discrete job entries.
//
// Handles all major CV formats:
//   Format A: "Role\nCompany, Location | Dates\n• bullets"   (Julius CV style)
//   Format B: "Role\nCompany\nDates\n• bullets"              (3-line header)
//   Format C: "Role, Company, Dates\n• bullets"              (1-line all-in)
//   Format D: "Role at Company (Dates)\n• bullets"
//   Format E: "Role | Company | Dates\n• bullets"
//   Format F: "Company\nRole\nDates\n• bullets"              (LinkedIn export)
//
// Key: use TWO-LINE look-ahead so that "Company / Role / Dates" (LinkedIn)
// also correctly triggers a new entry at the Company line.
function groupEntries(lines) {
  const entries = [];
  let cur = [];

  for (let i = 0; i < lines.length; i++) {
    const line     = lines[i];
    const isBullet = BULLET_RE.test(line);
    const hasRange = DATE_RANGE_RE.test(line);

    const next1 = lines[i + 1] || '';
    const next2 = lines[i + 2] || '';
    // A date range within the next 2 lines signals we're at a new entry header
    const nextHasRange =
      (DATE_RANGE_RE.test(next1) && !BULLET_RE.test(next1)) ||
      (DATE_RANGE_RE.test(next2) && !BULLET_RE.test(next2));

    const curHasBullets = cur.some(l => BULLET_RE.test(l));

    // "Soft" description: a non-blank line after the entry's date line that
    // is not itself a date range. PDF-extracted bullets often come out as
    // leading-space lines (e.g. " Defined...") — they won't match BULLET_RE
    // but they ARE description content and should trigger a split.
    const curDateIdx = cur.findIndex(l => DATE_RANGE_RE.test(l));
    const curHasSoftDesc = curDateIdx >= 0 &&
      cur.slice(curDateIdx + 1).some(l => l.trim().length > 5 && !DATE_RANGE_RE.test(l));

    const curHasContent = curHasBullets || curHasSoftDesc;

    // Title lines are short and don't end with a sentence-ending period.
    // Description sentences (even short ones from PDF extraction) end with ".".
    const isShortLine      = line.trim().length <= 80;
    const endsWithPeriod   = /[.!?]$/.test(line.trim());

    // Split to a new entry when:
    // (a) We're at a short, non-sentence header line AND the current entry has
    //     description content AND a date range appears within the next 2 lines
    // (b) The current line IS a date range AND current entry already has content
    const isNewEntry =
      (!isBullet && !hasRange && nextHasRange && curHasContent && isShortLine && !endsWithPeriod) ||
      (hasRange  && !isBullet && curHasContent);

    if (isNewEntry && cur.length > 0) { entries.push(cur); cur = []; }
    cur.push(line);
  }

  if (cur.length > 0) entries.push(cur);
  return entries.filter(e => e.length > 0);
}

// Extract the complete description from an entry's lines.
// Only includes lines that are bullets or come after the first bullet
// (capturing wrapped continuations). Header lines before the first
// bullet (role, company, date) are excluded automatically.
function extractDescription(entryLines) {
  const body = [];
  let pastHeader = false;
  for (const line of entryLines) {
    if (BULLET_RE.test(line)) { pastHeader = true; }
    if (pastHeader) { body.push(line.replace(BULLET_RE, '').trim()); continue; }
    // Soft-bullet fallback: no standard bullet chars (PDF extraction strips them).
    // Once we've passed the header (first date-range line), collect everything.
    if (!pastHeader && DATE_RANGE_RE.test(line)) { pastHeader = true; continue; }
  }
  return body.filter(Boolean).join('\n');
}

// ── LLM helper — Anthropic Claude ────────────
// Single focused call that returns parsed JSON.
// Uses claude-haiku for speed/cost; model is configurable via ANTHROPIC_MODEL env var.
async function ollamaJSON(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const message = await anthropic.messages.create({
    model      : ANTHROPIC_MODEL,
    max_tokens : 1024,
    temperature: 0.1,
    messages   : [{ role: 'user', content: prompt }],
  });

  const raw = (message.content[0]?.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // Parse outermost JSON structure (array or object)
  const firstChar = raw.trimStart()[0];
  if (firstChar === '[') {
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
  }
  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) return JSON.parse(objMatch[0]);
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  if (arrMatch) return JSON.parse(arrMatch[0]);
  throw new Error('No JSON in Claude response');
}

// ── Regex fallback: parse header line ────────
// Handles formats like:
//   "Senior PM, Grab, Jan 2022 – Present"
//   "Senior PM at Grab (Jan 2022 - Present)"
//   "Grab | Senior PM | 2020 – 2022"
function parseHeaderFallback(headerLine) {
  const DR = DATE_RANGE_RE;
  const dateMatch = headerLine.match(DR);
  let start_date = '', end_date = '';
  if (dateMatch) {
    const parts = dateMatch[0].split(/\s*(?:[-–—]|\bto\b)\s*/i);
    start_date = (parts[0] || '').trim();
    end_date   = (parts[1] || '').trim();
  }

  const clean = headerLine.replace(DR, '').replace(/[()[\]]/g, '').trim();

  const strip = s => s.replace(/[,|·•\s]+$/, '').trim();

  // Try "Role at Company" first
  const atMatch = clean.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) return { role: strip(atMatch[1]), company: strip(atMatch[2]), start_date, end_date };

  // Try pipe / comma splitting: could be "Role | Company" or "Company | Role"
  const parts = clean.split(/[,|·•]+/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Heuristic: if first part is longer and title-like, it's the role
    return { role: parts[0], company: parts[1], start_date, end_date };
  }

  // Single token — treat as role, company unknown
  return { role: strip(clean), company: '', start_date, end_date };
}

// ── Parse a single experience entry ──────────
async function parseExpEntry(entryLines) {
  const description = extractDescription(entryLines);

  // ── Step 1: Regex extraction (always runs — high accuracy) ──
  // Handles formats A–F: role-company-dates across 1-3 header lines.
  const firstBulletIdx = entryLines.findIndex(l => BULLET_RE.test(l));
  const headerOnly = firstBulletIdx >= 0
    ? entryLines.slice(0, firstBulletIdx)
    : entryLines.slice(0, 3);
  const nonBullet = headerOnly.filter(l => l.trim());
  const dateLine  = nonBullet.find(l => DATE_RANGE_RE.test(l)) || '';
  const nonDate   = nonBullet.filter(l => !DATE_RANGE_RE.test(l));

  let fields = { role: '', company: '', start_date: '', end_date: '' };

  // Extract dates
  if (dateLine) {
    const dm = dateLine.match(DATE_RANGE_RE);
    if (dm) {
      const pts = dm[0].split(/\s*(?:[-–—]|\bto\b)\s*/i);
      fields.start_date = (pts[0] || '').trim();
      fields.end_date   = (pts[1] || '').trim();
    }
  }

  // Extract role + company
  if (nonDate.length === 0) {
    // Formats C/D/E: everything on the date line ("Role at Company | Dates")
    const fb = parseHeaderFallback(dateLine);
    fields.role    = fb.role    || '';
    fields.company = fb.company || '';
  } else {
    // Detect LinkedIn order: company first, then role
    let roleIdx = 0;
    if (nonDate.length >= 2 &&
        !looksLikeJobTitle(nonDate[0]) &&
         looksLikeJobTitle(nonDate[1])) {
      roleIdx = 1;
    }
    const companyIdx = roleIdx === 0 ? 1 : 0;
    fields.role = nonDate[roleIdx].trim();

    // Format A variant: "Data Analyst - Accenture" on one line
    const atM   = fields.role.match(/^(.+?)\s+at\s+(.+)$/i);
    const dashM = fields.role.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (atM) {
      fields.company = atM[2].trim();
      fields.role    = atM[1].trim();
    } else if (dashM && dashM[2].length > 2) {
      fields.company = dashM[2].trim();
      fields.role    = dashM[1].trim();
    }

    if (!fields.company) {
      const companyFromDate = dateLine
        .replace(DATE_RANGE_RE, '').replace(/[|\-–—,\s]+$/, '').trim();
      if (companyFromDate.length > 2) {
        fields.company = companyFromDate;
      } else if (nonDate[companyIdx]) {
        fields.company = nonDate[companyIdx].trim();
      }
    }
  }

  // ── Step 2: LLM supplements only genuinely missing fields ──
  // Never overwrites a value already found by regex.
  if (!fields.role || !fields.company) {
    const headerText = nonBullet.slice(0, 3).join('\n');
    const prompt =
`Extract job title, company, start date, end date from this CV job header.
Return ONLY JSON: {"role":"","company":"","start_date":"","end_date":""}

${headerText}`;
    try {
      const llm = await ollamaJSON(prompt);
      if (!fields.role    && llm.role)       fields.role       = String(llm.role).trim();
      if (!fields.company && llm.company)    fields.company    = String(llm.company).trim();
      if (!fields.start_date && llm.start_date) fields.start_date = String(llm.start_date).trim();
      if (!fields.end_date   && llm.end_date)   fields.end_date   = String(llm.end_date).trim();
    } catch {}
  }

  return {
    role       : (fields.role       || '').trim(),
    company    : (fields.company    || '').trim(),
    start_date : (fields.start_date || '').trim(),
    end_date   : (fields.end_date   || '').trim(),
    description,
  };
}

// ── Regex fallback parsers ────────────────────
function parseEduFallback(lines) {
  const results = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const clean = line.replace(BULLET_RE, '').trim();
    // Skip lines that are just a year — they belong to a preceding education entry
    if (/^\d{4}$/.test(clean)) continue;
    const yearM = clean.match(/\b(19|20)\d{2}\b/);
    const year  = yearM ? yearM[0] : '';
    const gradeM = clean.match(/(gpa|cgpa|grade|honours?|distinction|merit|first class|second class)[:\s]*[\d.]+[^\s,]*/i);
    const grade = gradeM ? gradeM[0].trim() : '';

    // Split on " – ", " — ", or " - " (space-dash-space) which is the standard
    // education separator in most CV formats. Avoid splitting on mid-word hyphens.
    const dashSplit = clean.split(/\s+[-–—]\s+/);
    if (dashSplit.length >= 2) {
      const degree      = dashSplit[0].trim();
      // Strip trailing year and location from institution
      const institution = dashSplit[1]
        .replace(/,.*$/, '')              // strip ", Country" suffix
        .replace(/\b(19|20)\d{2}\b/, '') // strip year if embedded
        .trim();
      results.push({ degree, institution, year, grade });
    } else {
      // Fallback: comma split for "Degree, Institution" format
      const parts = clean.split(/,/).map(s => s.trim()).filter(Boolean);
      results.push({ degree: parts[0] || '', institution: parts[1] || '', year, grade });
    }
  }
  return results.filter(e => e.degree && e.degree.length > 2);
}

function parseCertFallback(lines) {
  return lines.map(line => {
    const clean = line.replace(BULLET_RE, '').trim();
    if (!clean || clean.length < 4) return null;
    const dateM = clean.match(/((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}|\d{4})/i);
    const date  = dateM ? dateM[0].trim() : '';
    const credM = clean.match(/credential[:\s#]*([A-Z0-9\-]+)/i);
    const credential_id = credM ? credM[1].trim() : '';

    // Split on " – ", " — ", or " - " (space-dash-space) to handle both
    // "Cert Name – Issuer" and "Cert Name - Issuer" formats
    const withoutDate = clean.replace(date, '');
    const dashSplit   = withoutDate.split(/\s+[-–—]\s+/);
    const parenM      = clean.match(/\(([^)]+)\)/);
    let name = '', issuer = '';

    if (dashSplit.length >= 2) {
      name   = dashSplit[0].replace(/[()]/g, '').trim();
      issuer = dashSplit[dashSplit.length - 1].replace(/[,;.\s]+$/, '').trim(); // last segment = issuer
    } else if (parenM) {
      // "Cert Name (Issuer Abbreviation)" — abbreviation in parens is often NOT the issuer
      // so treat full name as cert name, extract issuer via inferCertIssuers later
      name = clean.replace(date, '').trim();
    } else {
      name = clean.replace(date, '').trim();
    }
    return { name, issuer, date, credential_id };
  }).filter(c => c && c.name && c.name.length > 2);
}

function parseSkillsFallback(lines) {
  const skills = [];
  for (const line of lines) {
    line.split(/[,;|•·\t]+/).forEach(s => {
      const t = s.trim().replace(BULLET_RE, '');
      if (t.length > 1 && t.length < 50) skills.push(t);
    });
  }
  return [...new Set(skills)];
}

// ── Focused LLM extraction for education ─────
async function parseEducation(eduLines) {
  if (!eduLines.length) return [];
  const text = eduLines.join('\n');
  const prompt =
`Extract ALL education entries from the text below.
Return ONLY a JSON array — no markdown, no explanation:
[{"degree":"","institution":"","year":"","grade":""}]

Rules:
- degree: full degree name (e.g. "BSc, Business Information Systems")
- institution: university/school name only (e.g. "Murdoch University")
- year: graduation year if present, else ""
- grade: GPA/honours/distinction if present, else ""

${text}`;
  try {
    const r = await ollamaJSON(prompt);
    const arr = Array.isArray(r) ? r : (r.education || []);
    if (arr.length) return arr;
  } catch {}
  return parseEduFallback(eduLines);
}

// ── Focused LLM extraction for certifications ─
async function parseCertifications(certLines) {
  if (!certLines.length) return [];
  const cleaned = certLines.map(l => l.replace(BULLET_RE, '').trim()).filter(Boolean);
  const text = cleaned.join('\n');
  const expectedCount = cleaned.length;

  const prompt =
`Extract ALL ${expectedCount} certifications listed below. Return every single one.
Return ONLY a JSON array — no markdown, no explanation:
[{"name":"","issuer":"","date":"","credential_id":""}]

Rules:
- name: full certification name (include acronym if given, e.g. "Project Management Professional (PMP)")
- issuer: issuing organization if stated (e.g. "PMI", "Google", "Microsoft"), else ""
- date: year or date if present, else ""
- credential_id: credential ID if present, else ""

${text}`;
  let llmResult = [];
  try {
    const r = await ollamaJSON(prompt);
    llmResult = Array.isArray(r) ? r : (r.certifications || []);
  } catch {}

  // If LLM returned close to the expected count, trust it; otherwise merge with fallback
  if (llmResult.length >= expectedCount - 1 && llmResult.length > 0) {
    return inferCertIssuers(llmResult);
  }
  // Merge: take LLM results + fill in anything missed via regex fallback
  const fallback = parseCertFallback(certLines);
  const llmNames = new Set(llmResult.map(c => (c.name || '').toLowerCase().slice(0, 20)));
  const extras = fallback.filter(c => !llmNames.has((c.name || '').toLowerCase().slice(0, 20)));
  return inferCertIssuers([...llmResult, ...extras]);
}

// Infer missing issuers from well-known certification names
function inferCertIssuers(certs) {
  const ISSUER_MAP = [
    [/\bpmp\b|project management professional/i, 'PMI'],
    [/\buipath\b/i, 'UiPath'],
    [/\bblue prism\b/i, 'Blue Prism'],
    [/\bpower automate\b/i, 'Microsoft'],
    [/\baws\b|amazon web services/i, 'Amazon Web Services'],
    [/\bazure\b|microsoft\s+certified/i, 'Microsoft'],
    [/\bgoogle analytics\b/i, 'Google'],
    [/\bgoogle cloud\b/i, 'Google'],
    [/\bsalesforce\b/i, 'Salesforce'],
    [/\bcisco\b|ccna|ccnp/i, 'Cisco'],
    [/\bcompTIA\b/i, 'CompTIA'],
    [/\bpmi-acp\b|agile certified/i, 'PMI'],
    [/\bscrum master\b|csm\b/i, 'Scrum Alliance'],
    [/\bcoursera\b/i, 'Coursera'],
    [/\blinkedin learning\b/i, 'LinkedIn'],
    [/\bitil\b/i, 'AXELOS'],
  ];
  return certs.map(c => {
    if (c.issuer) return c;
    for (const [re, issuer] of ISSUER_MAP) {
      if (re.test(c.name)) return { ...c, issuer };
    }
    return c;
  });
}

// ── Skills extraction — two-pass hybrid ──────────────────────────────────────
// Pass 1 (regex): directly plucks named items that are unambiguously skills:
//   • Items in parentheses: "(Blue Prism)", "(PMP)"
//   • Certifications section lines
//   • "using/on/with X" connector patterns
// Pass 2 (LLM): reads focused, skill-dense lines to catch anything Pass 1 missed.
// This gives reliable coverage without a hardcoded skill dictionary.

function regexExtractSkills(rawText, skillLines) {
  const found = new Set();
  // Normalise: strip leading/trailing whitespace including non-breaking spaces
  const norm = s => s.replace(/^[\s\u00a0\u200b]+|[\s\u00a0\u200b]+$/g, '');

  // ── Certifications section (highest-confidence source) ──────────────────────
  // Degree abbreviations are not skills — filter these out globally
  const DEGREE_RE = /^(b\.?sc|b\.?eng|b\.?com|b\.?a|m\.?sc|m\.?eng|m\.?ba|m\.?ca|m\.?a|ph\.?d|dr|mr|ms|mrs)\b/i;

  if (Array.isArray(skillLines) && skillLines.length > 0) {
    // Explicit skills/competencies section: extract label before any colon.
    // Skip continuation lines (start with lowercase — they're part of the previous bullet).
    for (const line of skillLines) {
      const stripped = norm(line.replace(BULLET_RE, ''));
      if (!stripped || /^[a-z]/.test(stripped)) continue; // skip continuation lines
      const label = stripped.split(':')[0].trim();
      if (label.length >= 2 && label.length <= 45 && !/\d/.test(label) && !DEGREE_RE.test(label)) found.add(label);
    }
  } else {
    // Find certifications section and grab each line's cert name
    const lines = rawText.split('\n').map(l => norm(l));
    let inCerts = false;
    for (const line of lines) {
      if (/^certifications?\s*[:\-]?\s*$/i.test(line)) { inCerts = true; continue; }
      if (/^(education|work\s+experience|professional\s+experience|key\s+projects?)\s*[:\-]?\s*$/i.test(line)) { inCerts = false; continue; }
      if (inCerts && line && !/^[a-z]/.test(line)) {  // skip continuation lines
        // Strip bullet, strip trailing "– Issuer" or "| Issuer"
        const clean = norm(line.replace(BULLET_RE, '').split(/\s*[–—|]\s*/)[0]);
        if (clean.length >= 2 && clean.length <= 50 && !DEGREE_RE.test(clean)) found.add(clean);
      }
    }
  }

  // ── Parenthetical named items: "(Blue Prism)", "(UiPath + AI)" ──────────────
  // Skip: prepositions, degree abbreviations, short ambiguous terms
  const SKIP_PAREN = /\b(via|through|from|at|in|of|by|for|with|and|or)\b/i;
  for (const m of rawText.matchAll(/\(([A-Za-z][A-Za-z0-9 \/\.\+#\-]{1,35})\)/g)) {
    const item = norm(m[1]);
    if (!/\d/.test(item) &&
        item.length >= 3 &&             // skip 2-char ambiguous abbreviations like "DR", "PR"
        item.split(/\s+/).length <= 4 &&
        !SKIP_PAREN.test(item) &&
        !DEGREE_RE.test(item) &&
        !item.endsWith('.'))
    { found.add(item); }
  }

  // ── "using/deploying/implementing X" connector → extract the tool name ───────
  // Requires ProperCase (each word starts uppercase) — rules out verb phrases
  const CONN = /\b(?:using|leveraging|deploy(?:ing|ed)|implement(?:ing|ed)|built\s+(?:on|with)|powered\s+by)\s+([A-Z][A-Za-z0-9]{1,20}(?:\s+[A-Z][A-Za-z0-9]{1,20}){0,2})(?=\s*(?:and\b|,|to\b|\.|$))/g;
  for (const m of rawText.matchAll(CONN)) {
    const item = norm(m[1]);
    if (item.length >= 2 && item.split(/\s+/).length <= 4 && !/\d/.test(item)) found.add(item);
  }

  // Final filter: remove degree abbreviations and institution codes that
  // slipped through (e.g. "NUS-ISS", "MCA", "BSc")
  const INST_CODE = /^[A-Z]{2,5}-[A-Z]{2,5}$/; // patterns like "NUS-ISS", "MIT-SLP"
  return [...found].filter(s =>
    s.length >= 3 &&
    s.length <= 50 &&
    !DEGREE_RE.test(s) &&
    !INST_CODE.test(s)
  );
}

async function parseSkillsFromCV(rawText, skillLines) {
  // Pass 1: regex extracts high-confidence named items directly
  const regexSkills = regexExtractSkills(rawText, skillLines);

  // Pass 2: LLM reads skill-dense lines to find anything regex missed
  // Build focused input: certifications + lines with acronyms or Proper-Case products
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const dense = [];
  let inCerts = false, inSkip = false;
  for (const line of lines) {
    if (/^certifications?\s*[:\-]?\s*$/i.test(line)) { inCerts = true; inSkip = false; continue; }
    if (/^(education|key\s+projects?|references?)\s*[:\-]?\s*$/i.test(line)) { inCerts = false; inSkip = true; continue; }
    if (/^(work\s+experience|professional\s+experience|employment)\s*[:\-]?\s*$/i.test(line)) { inSkip = false; continue; }
    if (inCerts && !inSkip) { dense.push(line); continue; }
    if (inSkip) continue;
    const s = line.replace(BULLET_RE, '').trim();
    if (s.length < 10) continue;
    if (/\(([^)]{2,40})\)/.test(s) ||
        /\b(RPA|OCR|AI\/ML|NLP|SQL|AWS|GCP|ERP|CRM|PMP|ITIL|VAPT|ISO|GenAI|LLM|API|SDK|CI\/CD)\b/.test(s) ||
        /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/.test(s)) {
      dense.push(s);
    }
  }
  const llmInput = (dense.join('\n').slice(0, 2500) || rawText.slice(0, 3000));

  let llmSkills = [];
  try {
    const r = await ollamaJSON(
`List every tool, software, platform, methodology and certification in this text.
Each item: 1-4 words, no numbers, no sentences, no soft skills.
Good examples: "UiPath", "Blue Prism", "PMP", "RPA", "Power Automate", "Azure", "Agile"

Text:
${llmInput}

JSON array only:`
    );
    const raw = Array.isArray(r) ? r : (Array.isArray(r?.skills) ? r.skills : []);
    const STOP = /^(and|or|the|a|an|in|of|for|to|with|by|at|from|on|as|is|be|are|was|were|that|this|these|those|including|also|all|both|each|various|within|through|into|upon)$/i;
    // Phrases ending in achievement/role words indicate descriptions or job titles, not skills
    const NOISE = /\b(reduction|savings|accuracy|efficiency|growth|improvement|rollout|results?|rate|targets?|strategy|management|solutions?|approach|infrastructure|processes?|operations?|systems?|environment|standards?|frameworks?|leader|strategist|director|executive|advisor)\s*$/i;
    const rawLower = rawText.toLowerCase();
    llmSkills = raw
      .map(s => String(s).trim().replace(/[,.]$/, ''))
      .filter(s =>
        s.length >= 2 && s.length <= 45 &&
        s.split(/\s+/).length <= 4 &&
        !/\d/.test(s) &&
        !s.includes(',') &&
        !STOP.test(s) &&
        !NOISE.test(s) &&
        rawLower.includes(s.toLowerCase())  // anti-hallucination: must appear in source text
      );
  } catch { /* LLM unavailable — regex results still used */ }

  // Merge and deduplicate
  const norm = s => s.replace(/^[\s\u00a0\u200b\uf0b7\uf0a7]+|[\s\u00a0\u200b]+$/g, '');
  return [...new Set([...regexSkills, ...llmSkills].map(s => norm(s)).filter(Boolean))];
}

// ── Personal info extraction from CV header ───
// Regex handles structured fields (name, email, phone, location) reliably.
// LLM only supplements title and summary where free-form understanding helps.
async function parsePersonalInfo(headerLines, rawText) {
  const info = { name: '', title: '', email: '', phone: '', location: '', summary: '' };

  // ── Regex extraction (always runs first) ──────────────────────

  // Name extraction — pipe-separated first line takes priority
  const firstNonEmpty = headerLines.find(l => l.trim());
  if (firstNonEmpty && /\|/.test(firstNonEmpty)) {
    // "Carol White | carol@example.com | +44..." → first clean segment
    const parts = firstNonEmpty.split('|').map(s => s.trim()).filter(Boolean);
    const nc = parts.find(p => !/[@\d]/.test(p) && p.length > 2 && p.length < 50);
    if (nc) info.name = nc;
  }
  if (!info.name) {
    // Standard: first non-empty line with no @/digits/pipes
    const nameLine = headerLines.find(l => l.trim() && !/[@\d|+]/.test(l) && l.trim().length < 60 && l.trim().length > 2);
    if (nameLine) info.name = nameLine.trim();
  }

  // Title: second meaningful non-contact line
  const titleLine = headerLines.find((l, i) => {
    if (i === 0) return false;
    const t = l.trim();
    if (!t || t === info.name) return false;
    if (/@/.test(t)) return false;
    if (/\b(summary|profile|objective|experience|education|skill)\b/i.test(t)) return false;
    return t.length >= 5 && t.length <= 120;
  });
  if (titleLine) {
    const t = titleLine.trim();
    info.title = (/\|/.test(t) && !/@/.test(t)) ? t : (t.replace(/\|.*$/, '').trim() || t);
  } else {
    // Pipe-separated first line: second non-contact segment
    const firstLine = headerLines.find(l => l.trim());
    if (firstLine && /\|/.test(firstLine)) {
      const parts = firstLine.split('|').map(s => s.trim()).filter(Boolean);
      const tc = parts.find(p => !/[@\d]/.test(p) && p !== info.name && p.length > 3 && p.length < 80);
      if (tc) info.title = tc;
    }
  }

  // Email: regex scan of full text
  const emailM = rawText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailM) info.email = emailM[0];

  // Phone: regex scan
  const phoneM = rawText.match(/(\+?\d[\d\s\-().]{7,15}\d)/);
  if (phoneM) info.phone = phoneM[0].trim();

  // Location: common city/country keywords
  const locM = rawText.match(/\b(Singapore|Malaysia|Indonesia|Thailand|Philippines|Vietnam|Australia|New Zealand|United Kingdom|UK|USA|United States|India|Hong Kong|Canada|Germany|France|Japan|China|UAE|Dubai)\b/i);
  if (locM) info.location = locM[0];

  // Summary: long prose lines in the header (not contact/pipe lines)
  const summaryLines = headerLines.filter(l =>
    l.length > 60 && !/@/.test(l) && !/\|/.test(l) &&
    !/^\+?\d/.test(l) &&
    !SECTION_RE.experience.test(l) && !SECTION_RE.education.test(l) &&
    !SECTION_RE.certifications.test(l) && !SECTION_RE.skills.test(l)
  );
  if (summaryLines.length) info.summary = summaryLines.join(' ').trim();

  // ── LLM supplements only still-empty title / summary ─────────
  if (!info.title || !info.summary) {
    const sample = headerLines.slice(0, 10).join('\n');
    const prompt =
`From this CV header, extract the job title/headline and professional summary.
Return ONLY JSON — no markdown:
{"title":"","summary":""}

- title: professional headline (e.g. "Senior Data Analyst | Business Intelligence")
- summary: professional summary paragraph if present, else ""

${sample}`;
    try {
      const llm = await ollamaJSON(prompt);
      if (!info.title   && llm.title)   info.title   = String(llm.title).trim();
      if (!info.summary && llm.summary) info.summary = String(llm.summary).trim();
    } catch {}
  }

  return info;
}

// ── Main CV parser ────────────────────────────
async function parseCV(text) {
  const sections = splitSections(text);

  // Run all extractions in parallel for speed
  const [experiences, education, certifications, skills, personal] = await Promise.all([
    Promise.all(groupEntries(sections.experience).map(parseExpEntry)),
    parseEducation(sections.education),
    parseCertifications(sections.certifications),
    parseSkillsFromCV(text, sections.skills),
    parsePersonalInfo(sections.header, text),
  ]);

  // Deduplicate and sanity-check skills
  const allSkills = [...new Set(skills.map(s => s.trim()).filter(s => s.length > 1 && s.length < 60))];

  return { experiences, education, certifications, skills: allSkills, personal };
}

// ── Multer storage ────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = crypto.randomBytes(12).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.doc', '.txt'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Helpers ───────────────────────────────────
function signToken(payload)  { return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY }); }
function verifyToken(token)  { return jwt.verify(token, JWT_SECRET); }

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try { req.user = verifyToken(token); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── Flag incomplete items for review ─────────
// Combines AI judgment with rule-based checks so small models don't miss obvious gaps
function needsReviewExp(e) {
  if (e.needs_review) return true;
  if (!e.role || e.role.trim().length < 2)    return true;
  if (!e.company || e.company.trim().length < 2) return true;
  if (!e.start_date || e.start_date.trim() === '') return true;
  return false;
}
function needsReviewEdu(e) {
  if (e.needs_review) return true;
  if (!e.degree || e.degree.trim().length < 2)       return true;
  if (!e.institution || e.institution.trim().length < 2) return true;
  return false;
}
function needsReviewCert(c) {
  if (c.needs_review) return true;
  if (!c.name || c.name.trim().length < 2)   return true;
  if (!c.issuer || c.issuer.trim().length < 2) return true;
  return false;
}

// ── Store parsed CV in DB (transaction) ───────
function storeParsedCV(userId, docId, parsed) {
  const tx = db.transaction(() => {
    stmts.deleteOldExp.run(userId);
    stmts.deleteOldEdu.run(userId);
    stmts.deleteOldCert.run(userId);
    stmts.deleteOldSkill.run(userId);

    for (const e of parsed.experiences) {
      const status = autoVerifyCompany(e.company);
      stmts.insertExp.run(userId, docId, e.role, e.company, e.start_date, e.end_date, e.description, status, needsReviewExp(e) ? 1 : 0);
    }
    for (const e of parsed.education) {
      const status = autoVerifyInstitution(e.institution);
      stmts.insertEdu.run(userId, docId, e.degree, e.institution, e.year, e.grade, status, needsReviewEdu(e) ? 1 : 0);
    }
    for (const c of parsed.certifications) {
      const status = autoVerifyCertIssuer(c.issuer);
      stmts.insertCert.run(userId, docId, c.name, c.issuer, c.date, c.credential_id, status, needsReviewCert(c) ? 1 : 0);
    }
    for (const s of parsed.skills) {
      stmts.insertSkill.run(userId, s, 'cv');
    }
    if (parsed.personal) {
      const p = parsed.personal;
      stmts.upsertPersonal.run(userId, p.name||'', p.title||'', p.email||'', p.phone||'', p.location||'', p.summary||'');
    }
  });
  tx();
}

// ── Helper: fetch stored CV records for a user ─
function storedCVData(uid) {
  return {
    experiences   : stmts.getExp.all(uid),
    education     : stmts.getEdu.all(uid),
    certifications: stmts.getCerts.all(uid),
    skills        : stmts.getSkills.all(uid).map(r => r.skill),
    personal      : stmts.getPersonal.get(uid) || null,
  };
}

// ── Express app ───────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role = 'jobseeker' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!['jobseeker','employer'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (stmts.findByEmail.get(email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);
  const info   = stmts.insertUser.run(name.trim(), email.toLowerCase(), hashed, role);
  const userId = info.lastInsertRowid;
  const token  = signToken({ id: userId, email, role });
  stmts.insertSession.run(userId, crypto.createHash('sha256').update(token).digest('hex'));
  stmts.updateLogin.run(userId);
  res.status(201).json({ message: 'Account created', token, user: stmts.findById.get(userId) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const row = stmts.findByEmail.get(email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'Invalid email or password.' });
  const match = await bcrypt.compare(password, row.password);
  if (!match) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = signToken({ id: row.id, email: row.email, role: row.role });
  stmts.insertSession.run(row.id, crypto.createHash('sha256').update(token).digest('hex'));
  stmts.updateLogin.run(row.id);
  res.json({ message: 'Login successful', token, user: stmts.findById.get(row.id) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = stmts.findById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

app.post('/api/auth/logout', requireAuth, (_, res) => res.json({ message: 'Logged out' }));

// ══════════════════════════════════════════════
// CV ROUTES
// ══════════════════════════════════════════════

/* POST /api/cv/upload  — file upload (PDF / DOCX / TXT) */
app.post('/api/cv/upload', requireAuth, upload.single('cv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded or unsupported file type.' });

  try {
    let rawText = '';
    const ext   = path.extname(req.file.originalname).toLowerCase();

    if (ext === '.pdf') {
      const buf = fs.readFileSync(req.file.path);
      try {
        const data = await pdfParse(buf);
        rawText = data.text;
      } catch (pdfErr) {
        // Some PDFs have xref issues — retry with lenient options
        const data = await pdfParse(buf, { max: 0 });
        rawText = data.text;
      }
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: req.file.path });
      rawText = result.value;
    } else {
      rawText = fs.readFileSync(req.file.path, 'utf8');
    }

    const docInfo = stmts.insertDoc.run(req.user.id, req.file.originalname, 'upload', rawText);
    const parsed  = await parseCV(rawText);
    storeParsedCV(req.user.id, docInfo.lastInsertRowid, parsed);

    // Clean up temp file
    fs.unlink(req.file.path, () => {});

    // Return stored records (include id + verification_status for front-end)
    const stored = storedCVData(req.user.id);
    res.json({
      message: 'CV uploaded and parsed successfully',
      parsed: stored,
      summary: {
        experiences   : stored.experiences.length,
        education     : stored.education.length,
        certifications: stored.certifications.length,
        skills        : stored.skills.length,
      }
    });
  } catch (err) {
    console.error('CV parse error:', err);
    const msg = err.message?.includes('fetch') || err.message?.includes('connect')
      ? 'AI parsing unavailable. Check your ANTHROPIC_API_KEY configuration.'
      : 'Failed to parse CV. Please try again.';
    res.status(500).json({ error: msg });
  }
});

/* POST /api/cv/text  — paste raw text */
app.post('/api/cv/text', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 20)
    return res.status(400).json({ error: 'Please paste at least some CV text.' });

  try {
    const docInfo = stmts.insertDoc.run(req.user.id, 'pasted-text', 'paste', text);
    const parsed  = await parseCV(text);
    storeParsedCV(req.user.id, docInfo.lastInsertRowid, parsed);

    // Return stored records (include id + verification_status for front-end)
    const stored = storedCVData(req.user.id);
    res.json({
      message: 'CV text parsed successfully',
      parsed: stored,
      summary: {
        experiences   : stored.experiences.length,
        education     : stored.education.length,
        certifications: stored.certifications.length,
        skills        : stored.skills.length,
      }
    });
  } catch (err) {
    console.error('CV text parse error:', err);
    const msg = err.message?.includes('fetch') || err.message?.includes('connect')
      ? 'AI parsing unavailable. Check your ANTHROPIC_API_KEY configuration.'
      : 'Failed to parse CV. Please try again.';
    res.status(500).json({ error: msg });
  }
});

/* PATCH /api/cv/item  — edit fields of an extracted CV item */
app.patch('/api/cv/item', requireAuth, (req, res) => {
  const { type, id, fields } = req.body;
  const uid = req.user.id;
  try {
    if (type === 'experience') {
      db.prepare('UPDATE cv_experiences SET role=?,company=?,start_date=?,end_date=?,description=?,needs_review=0 WHERE id=? AND user_id=?')
        .run(fields.role||'', fields.company||'', fields.start_date||'', fields.end_date||'', fields.description||'', id, uid);
    } else if (type === 'education') {
      db.prepare('UPDATE cv_education SET degree=?,institution=?,year=?,grade=?,needs_review=0 WHERE id=? AND user_id=?')
        .run(fields.degree||'', fields.institution||'', fields.year||'', fields.grade||'', id, uid);
    } else if (type === 'certification') {
      db.prepare('UPDATE cv_certifications SET name=?,issuer=?,date=?,credential_id=?,needs_review=0 WHERE id=? AND user_id=?')
        .run(fields.name||'', fields.issuer||'', fields.date||'', fields.credential_id||'', id, uid);
    } else {
      return res.status(400).json({ error: 'Invalid type.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('CV item update error:', err);
    res.status(500).json({ error: 'Failed to update item.' });
  }
});

/* PATCH /api/cv/confirm  — confirm an item without editing (clears needs_review) */
app.patch('/api/cv/confirm', requireAuth, (req, res) => {
  const { type, id } = req.body;
  const uid = req.user.id;
  const stmtMap = {
    experience:    db.prepare('UPDATE cv_experiences    SET needs_review=0 WHERE id=? AND user_id=?'),
    education:     db.prepare('UPDATE cv_education      SET needs_review=0 WHERE id=? AND user_id=?'),
    certification: db.prepare('UPDATE cv_certifications SET needs_review=0 WHERE id=? AND user_id=?'),
  };
  const stmt = stmtMap[type];
  if (!stmt) return res.status(400).json({ error: 'Invalid type.' });
  stmt.run(id, uid);
  res.json({ ok: true });
});

/* PATCH /api/cv/skills  — replace all skills for current user */
app.patch('/api/cv/skills', requireAuth, (req, res) => {
  const { skills } = req.body;
  if (!Array.isArray(skills)) return res.status(400).json({ error: 'skills must be array.' });
  const uid = req.user.id;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cv_skills WHERE user_id=?').run(uid);
    const ins = db.prepare('INSERT INTO cv_skills (user_id,skill,source) VALUES (?,?,?)');
    for (const s of skills) if (s && s.trim()) ins.run(uid, s.trim(), 'cv_confirmed');
  });
  tx();
  res.json({ ok: true });
});

/* GET /api/cv/data  — fetch saved CV data for logged-in user */
app.get('/api/cv/data', requireAuth, (req, res) => {
  res.json(storedCVData(req.user.id));
});

/* PATCH /api/cv/verify  — request manual verification for an item */
app.patch('/api/cv/verify', requireAuth, (req, res) => {
  const { type, id } = req.body;
  const uid = req.user.id;
  const statusMap = {
    experience    : stmts.updateExpStatus,
    education     : stmts.updateEduStatus,
    certification : stmts.updateCertStatus,
  };
  const stmt = statusMap[type];
  if (!stmt) return res.status(400).json({ error: 'Invalid type.' });
  stmt.run('verification_requested', id, uid);
  res.json({ message: 'Verification request submitted.' });
});

// ══════════════════════════════════════════════
// FUTURE / CAREER PATHWAYS ROUTES
// ══════════════════════════════════════════════

// ── External API helpers ──────────────────────

// Search for courses on a specific platform via SerpAPI Google Search
async function searchCoursesViaSerpAPI(query, site) {
  if (!SERPAPI_KEY) return [];
  const platform = site.includes('coursera') ? 'Coursera'
    : site.includes('linkedin')              ? 'LinkedIn Learning'
    : 'Udemy';
  try {
    const q = `site:${site} ${query} course`;
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${SERPAPI_KEY}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.organic_results || []).slice(0, 5).map(r => ({
      platform,
      title: r.title.replace(/\s*[-|]\s*(Coursera|Udemy|LinkedIn Learning|LinkedIn).*$/i, '').trim(),
      description: (r.snippet || '').slice(0, 150),
      url: r.link,
      image: r.thumbnail || null,
      difficulty: 'intermediate',
      rating: null,
      duration: null,
    }));
  } catch { return []; }
}

// Check how many job listings exist for a given role title (for pathway market validation)
async function fetchJobCount(title) {
  if (!SERPAPI_KEY) return null;
  try {
    const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(title)}&api_key=${SERPAPI_KEY}&num=5`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.error) return null;
    return (data.jobs_results || []).length;
  } catch { return null; }
}

/* POST /api/future/pathways — LLM-generated career pathway suggestions */
app.post('/api/future/pathways', requireAuth, async (req, res) => {
  try {
    const cv = storedCVData(req.user.id);
    if (!cv.experiences.length && !cv.skills.length) {
      return res.status(400).json({ error: 'No CV data found. Please upload your CV first on the Past tab.' });
    }

    const currentRole  = cv.experiences[0]?.role    || cv.personal?.title || 'Professional';
    const skillsList   = cv.skills.slice(0, 20).join(', ');
    const expSummary   = cv.experiences.slice(0, 3).map(e => `${e.role} at ${e.company}`).join('; ');
    const bioText      = (currentRole + ' ' + skillsList + ' ' + expSummary).toLowerCase();

    // ── Multi-domain detection ─────────────────────────────────────────
    const domainIs = pat => pat.test(bioText);
    const isHospitality  = domainIs(/hotel|hospitality|hospit|resort|guest|serviced.apart|property.operat|front.desk|housekeep|food.bev|f&b|vip.serv|concierge|sonder|airbnb/);
    const isOperations   = domainIs(/operations manager|ops manager|general manager|facilities|supply chain|logistics|warehouse|fleet|procurement/) && !isHospitality;
    const isAutomation   = domainIs(/automat|rpa|uipath|process.automat|robotic/);
    const isData         = domainIs(/\bdata\b|analyst|scientist|\bsql\b|\bbi\b|tableau|power.bi|machine learning/);
    const isFinance      = domainIs(/financ|banking|accountant|accounting|investment|wealth|treasury|\baudit\b|\bcfo\b|\bfund\b|\bequity\b|\bcredit\b/);
    const isMarketing    = domainIs(/marketing|brand|campaign|growth.hack|seo|sem|social.media|content.strat|demand.gen|crm/);
    const isHR           = domainIs(/human.resource|\bhr\b|talent.acqui|recruitment|recruiter|learning.dev|l&d|people.ops|hris/);
    const isSales        = domainIs(/\bsales\b|account.exec|business.dev|biz.dev|revenue.growth|client.acqui|b2b.sales/);
    const isEngineering  = domainIs(/software.eng|developer|devops|cloud.eng|backend|frontend|full.stack|platform.eng|sre\b/);

    // Role example sets per domain
    const DOMAINS = {
      hospitality: {
        vertical:   'Regional Director of Operations, Hotel General Manager, VP of Hospitality Operations, Area Director of Guest Experience',
        lateral:    'Hospitality Consultant, Event Operations Director, Destination Manager, Short-Term Rental Portfolio Manager, Facilities Operations Manager',
        emerging:   'Digital Guest Experience Manager, Smart Hotel Operations Director, Hospitality Tech Consultant, Serviced Apartment Platform Manager',
        specialist: 'Luxury VIP & UHNW Client Relations Director, Pre-Opening Specialist, Revenue Optimisation Manager, Guest Experience Architect',
        salary:     { v: 'S$80k – S$120k', l: 'S$70k – S$105k', e: 'S$85k – S$125k', s: 'S$90k – S$130k' },
      },
      operations: {
        vertical:   'Head of Operations, VP of Operations, Chief Operating Officer, Director of Business Operations',
        lateral:    'Operations Consultant, Business Transformation Manager, Process Improvement Lead, Project Director',
        emerging:   'Digital Operations Manager, Intelligent Operations Lead, AI-Augmented Operations Director',
        specialist: 'Lean Six Sigma Operations Expert, Business Continuity Director, Global Operations Architect',
        salary:     { v: 'S$90k – S$130k', l: 'S$80k – S$120k', e: 'S$95k – S$140k', s: 'S$100k – S$145k' },
      },
      automation: {
        vertical:   'Head of Process Automation, Director of Intelligent Automation, VP of Digital Operations',
        lateral:    'Digital Transformation Manager, IT Strategy Consultant, Business Transformation Lead, Innovation Program Manager',
        emerging:   'Hyperautomation Architect, AI Automation Strategist, Intelligent Process Designer, GenAI Operations Lead',
        specialist: 'RPA Centre of Excellence Manager, Intelligent Document Processing Specialist, Process Mining Expert, UiPath Platform Architect',
        salary:     { v: 'S$100k – S$145k', l: 'S$90k – S$130k', e: 'S$105k – S$155k', s: 'S$110k – S$160k' },
      },
      data: {
        vertical:   'Senior Data Science Lead, Head of Analytics, Director of Data & AI',
        lateral:    'Product Manager (Data), Digital Strategy Consultant, Business Intelligence Manager, Analytics Consultant',
        emerging:   'AI/ML Product Lead, Generative AI Specialist, LLM Engineer, Data & AI Strategy Director',
        specialist: 'MLOps Engineer, Feature Engineering Specialist, Real-time Analytics Architect, NLP Specialist',
        salary:     { v: 'S$110k – S$155k', l: 'S$95k – S$135k', e: 'S$115k – S$165k', s: 'S$120k – S$170k' },
      },
      finance: {
        vertical:   'Finance Director, CFO, Head of Treasury, VP of Finance, Group Financial Controller',
        lateral:    'Financial Consultant, Corporate Finance Advisor, Risk Manager, Strategy & Finance Lead',
        emerging:   'FinTech Strategy Lead, Digital Finance Transformation Director, Open Banking Product Manager',
        specialist: 'Investment Portfolio Director, ESG Finance Specialist, Structured Products Expert, Regulatory Compliance Director',
        salary:     { v: 'S$110k – S$160k', l: 'S$100k – S$145k', e: 'S$115k – S$165k', s: 'S$120k – S$180k' },
      },
      marketing: {
        vertical:   'Head of Marketing, CMO, VP of Growth, Director of Brand & Communications',
        lateral:    'Brand Consultant, Digital Strategy Director, Growth Lead, Customer Experience Director',
        emerging:   'AI Marketing Strategist, Conversational Commerce Lead, Personalisation & AI Director',
        specialist: 'Performance Marketing Director, Brand Architecture Specialist, Demand Generation Expert',
        salary:     { v: 'S$100k – S$140k', l: 'S$90k – S$130k', e: 'S$105k – S$145k', s: 'S$95k – S$135k' },
      },
      hr: {
        vertical:   'HR Director, Chief People Officer, VP of Talent, Head of People & Culture',
        lateral:    'Organisational Development Consultant, Talent Strategy Advisor, People Analytics Lead',
        emerging:   'AI-Augmented HR Director, People Tech Lead, Future of Work Strategist',
        specialist: 'Executive Talent Acquisition Director, L&D Architect, HRIS & People Analytics Specialist',
        salary:     { v: 'S$95k – S$135k', l: 'S$85k – S$125k', e: 'S$100k – S$140k', s: 'S$95k – S$130k' },
      },
      sales: {
        vertical:   'Head of Sales, VP of Sales, Chief Revenue Officer, Regional Sales Director',
        lateral:    'Business Development Consultant, Strategic Partnerships Lead, Revenue Operations Manager',
        emerging:   'Sales AI Strategist, Digital Sales Transformation Lead, Revenue Intelligence Director',
        specialist: 'Enterprise Account Director, Channel Sales Architect, Solution Sales Expert',
        salary:     { v: 'S$100k – S$150k', l: 'S$90k – S$135k', e: 'S$105k – S$155k', s: 'S$100k – S$145k' },
      },
      engineering: {
        vertical:   'Engineering Director, Principal Architect, Head of Engineering, VP of Technology',
        lateral:    'Technical Product Manager, Solutions Architect, IT Strategy Consultant',
        emerging:   'GenAI Solutions Architect, AI Platform Lead, LLM Engineer, Cloud AI Architect',
        specialist: 'Cloud Security Architect, Site Reliability Engineer, Platform Engineering Lead',
        salary:     { v: 'S$120k – S$165k', l: 'S$110k – S$155k', e: 'S$125k – S$175k', s: 'S$130k – S$180k' },
      },
      default: {
        vertical:   'Senior Manager, Director of Operations, Head of Department, General Manager',
        lateral:    'Business Consultant, Project Director, Operations Advisor, Strategy Manager',
        emerging:   'Digital Transformation Lead, AI-Augmented Operations Manager, Innovation Programme Director',
        specialist: 'Industry Subject-Matter Expert, Centre of Excellence Lead, Strategic Advisory Director',
        salary:     { v: 'S$80k – S$120k', l: 'S$75k – S$110k', e: 'S$85k – S$125k', s: 'S$90k – S$130k' },
      },
    };

    // Pick the best-matching domain
    const domain = isHospitality ? DOMAINS.hospitality
      : isAutomation  ? DOMAINS.automation
      : isData        ? DOMAINS.data
      : isOperations  ? DOMAINS.operations
      : isFinance     ? DOMAINS.finance
      : isMarketing   ? DOMAINS.marketing
      : isHR          ? DOMAINS.hr
      : isSales       ? DOMAINS.sales
      : isEngineering ? DOMAINS.engineering
      : DOMAINS.default;

    const verticalEx   = domain.vertical;
    const lateralEx    = domain.lateral;
    const emergingEx   = domain.emerging;
    const specialistEx = domain.specialist;

    // One small LLM call per pathway type — run in parallel for speed
    const sal = domain.salary;
    const typeConfig = [
      { type: 'vertical',   typeName: 'Promotion',        demand: 'High',    salary: sal.v, examples: verticalEx },
      { type: 'lateral',    typeName: 'Lateral Move',     demand: 'Medium',  salary: sal.l, examples: lateralEx  },
      { type: 'emerging',   typeName: 'Emerging Role',    demand: 'Growing', salary: sal.e, examples: emergingEx },
      { type: 'specialist', typeName: 'Specialist Track', demand: 'High',    salary: sal.s, examples: specialistEx },
    ];

    const makePathwayPrompt = ({ type, examples }) =>
`You are a career advisor. Suggest ONE ${type} career role that directly matches this person's industry and background.
Choose ONLY from these examples (pick the best fit): ${examples}
Do NOT suggest tech or software roles unless the person has a tech background.
Return ONLY JSON: {"title":"Exact Job Title","match":80,"skills":["skill1","skill2","skill3","skill4","skill5"],"desc":"One sentence describing the day-to-day work."}
Rules: match=integer 55-92. skills=5 real skills needed (not placeholder letters).
Person: ${currentRole}. Background: ${expSummary.slice(0, 100)}. Skills: ${skillsList.slice(0, 100)}`;

    const results = await Promise.allSettled(
      typeConfig.map(tc => ollamaJSON(makePathwayPrompt(tc)))
    );

    // If ALL calls failed, surface a proper error instead of silently returning []
    const allFailed = results.every(r => r.status === 'rejected');
    if (allFailed) {
      const err0 = results[0].reason;
      const msg  = String(err0?.message || '').includes('fetch') || String(err0?.message || '').includes('connect')
        ? 'AI service unavailable. Check your ANTHROPIC_API_KEY configuration.'
        : 'AI failed to generate career pathways. Try again.';
      return res.status(503).json({ error: msg });
    }

    const normalised = results.map((r, i) => {
      const tc = typeConfig[i];
      const p  = r.status === 'fulfilled' ? r.value : {};
      const title = String(p.title || '').trim();
      const rawSkills = p.skills || p.requiredSkills || p.required || [];
      return {
        id:            `${tc.type}-${i}`,
        title:         title || `${tc.typeName} Path`,
        type:          tc.type,
        typeName:      tc.typeName,
        demand:        tc.demand,
        match:         Math.min(92, Math.max(55, Number(p.match) || 70)),
        salary:        tc.salary,
        description:   String(p.desc || p.description || '').trim(),
        requiredSkills: Array.isArray(rawSkills) ? rawSkills.slice(0, 6) : [],
      };
    // Keep pathway if it has a real title (not the generic fallback) OR has skills
    }).filter(p => (p.title && p.title !== `${p.typeName} Path`) || p.requiredSkills.length > 0);

    // If partial failure wiped everything, still send what we have (or error if 0)
    if (!normalised.length) {
      return res.status(503).json({ error: 'AI returned incomplete results. Try again in a moment.' });
    }

    // ── Job market validation ──────────────────────────────────────────────
    // Only recommend roles that have real job openings. Run checks in parallel.
    if (SERPAPI_KEY) {
      const countResults = await Promise.allSettled(
        normalised.map(p => fetchJobCount(p.title))
      );
      countResults.forEach((r, i) => {
        normalised[i].jobCount = r.status === 'fulfilled' ? (r.value ?? null) : null;
      });

      // Filter out roles with a confirmed zero — keep null (unknown/timeout) as valid
      const withJobs = normalised.filter(p => p.jobCount === null || p.jobCount > 0);

      if (withJobs.length >= 2) {
        // Enough pathways with real openings — use only those
        normalised.splice(0, normalised.length, ...withJobs);
      } else if (withJobs.length === 1) {
        // Only one confirmed — keep the top two by job count so we don't leave the user with a single option
        normalised.sort((a, b) => (b.jobCount ?? 0) - (a.jobCount ?? 0));
        normalised.splice(2);
      }
      // If withJobs.length === 0: all searches returned 0, likely a transient SerpAPI issue — keep all pathways
    }

    res.json({ pathways: normalised });
  } catch (err) {
    console.error('Pathways error:', err);
    const msg = err.message?.includes('fetch') || err.message?.includes('connect')
      ? 'AI service unavailable. Check your ANTHROPIC_API_KEY configuration.'
      : 'Failed to generate career pathways.';
    res.status(503).json({ error: msg });
  }
});

/* GET /api/future/jobs?role=&location= — Google Jobs via SerpAPI */
app.get('/api/future/jobs', requireAuth, async (req, res) => {
  if (!SERPAPI_KEY) {
    return res.json({
      configured: false,
      message: 'Add SERPAPI_KEY to .env to see live job openings (serpapi.com — 100 free searches/month)',
      jobs: [], total: 0,
    });
  }

  const { role = '', location = 'Singapore' } = req.query;
  if (!role.trim()) return res.status(400).json({ error: 'role is required' });

  try {
    const q = `${role.trim()} ${location}`.trim();
    const url = `https://serpapi.com/search.json?engine=google_jobs&q=${encodeURIComponent(q)}&location=${encodeURIComponent(location)}&api_key=${SERPAPI_KEY}&num=10`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const data = await resp.json();

    if (data.error) {
      return res.json({ configured: true, total: 0, jobs: [], error: data.error });
    }

    const jobs = (data.jobs_results || []).slice(0, 10).map(j => ({
      title:    j.title,
      company:  j.company_name,
      location: j.location,
      via:      j.via,
      posted:   j.detected_extensions?.posted_at   || '',
      salary:   j.detected_extensions?.salary       || '',
      description: (j.description || '').slice(0, 200),
      link:     j.related_links?.[0]?.link || '',
    }));

    res.json({ configured: true, total: jobs.length, jobs });
  } catch (err) {
    console.error('Jobs error:', err);
    res.json({ configured: true, total: 0, jobs: [], error: 'Job search temporarily unavailable.' });
  }
});

/* POST /api/future/gap — enriched LLM skill gap analysis */
app.post('/api/future/gap', requireAuth, async (req, res) => {
  try {
    const { pathwayTitle, requiredSkills = [] } = req.body;
    if (!pathwayTitle) return res.status(400).json({ error: 'pathwayTitle is required' });

    const cv = storedCVData(req.user.id);
    const userSkills = cv.skills || [];

    // ── Step 1: Server-side baseline with fuzzy matching ──────────
    // Normalise: lowercase + strip punctuation for comparison
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const userNorm = userSkills.map(norm);

    // Fuzzy match: direct, contains, or first word match
    const matches = (req, user) => {
      const rn = norm(req);
      if (user.includes(rn)) return true;
      if (user.some(u => u.includes(rn) || rn.includes(u))) return true;
      // First word match (e.g. "Python" matches "Python programming")
      const firstWord = rn.split(/\s/)[0];
      if (firstWord.length > 3 && user.some(u => u.startsWith(firstWord))) return true;
      return false;
    };

    const baseHave = requiredSkills.filter(s => matches(s, userNorm));
    const baseGap  = requiredSkills.filter(s => !matches(s, userNorm));
    const baseReadiness = requiredSkills.length
      ? Math.round((baseHave.length / requiredSkills.length) * 100) : 0;

    // ── Step 2: LLM for per-skill priority, time estimates, skill type & strengths ──
    const priorityPrompt =
`You are a career advisor. Analyse each missing skill below for the target role.
Target role: ${pathwayTitle}
Candidate already has: ${userSkills.slice(0, 20).join(', ')}
Missing skills: ${baseGap.join(', ')}

Return ONLY JSON (no markdown):
{"readiness":65,"gaps":[{"skill":"X","type":"hard","priority":"Critical","weeks":6,"reason":"why this skill matters for the role","courseType":"online course"}],"strengths":["specific competitive advantage 1","specific competitive advantage 2"],"insight":"Single most impactful next step the candidate should take."}

Field rules:
- type: "hard" for technical/tool/platform/certification skills; "soft" for interpersonal/leadership/communication/management/emotional intelligence skills
- priority: "Critical" = required from day one; "Important" = expected within 3 months; "Useful" = differentiator
- weeks: realistic integer 1–24 to reach working proficiency
- courseType: for hard skills use "online course"|"certification"|"bootcamp"|"project"; for soft skills use "workshop"|"coaching"|"book"|"practice"
- strengths: 2 specific competitive advantages this person already has FOR ${pathwayTitle}
- readiness: integer 0–100 overall readiness score
- insight: one concrete next action`;

    try {
      const llm = await ollamaJSON(priorityPrompt);

      // Normalise LLM gaps — ensure all baseGap skills are represented
      const llmGaps    = Array.isArray(llm.gaps) ? llm.gaps : [];
      const llmSkillSet = new Set(llmGaps.map(g => norm(g.skill || '')));

      // Add any missing gaps with default values
      const allGaps = [
        ...llmGaps.map(g => ({
          skill:      String(g.skill      || '').trim(),
          type:       g.type === 'soft' ? 'soft' : 'hard',
          priority:   ['Critical','Important','Useful'].includes(g.priority) ? g.priority : 'Important',
          weeks:      Math.min(24, Math.max(1, Number(g.weeks) || 8)),
          reason:     String(g.reason     || '').trim(),
          courseType: String(g.courseType || '').trim(),
        })).filter(g => g.skill),
        ...baseGap
          .filter(s => !llmSkillSet.has(norm(s)))
          .map(s => ({ skill: s, type: 'hard', priority: 'Useful', weeks: 6, reason: '', courseType: 'online course' })),
      ];

      // Sort: Critical → Important → Useful
      const priOrder = { Critical: 0, Important: 1, Useful: 2 };
      allGaps.sort((a, b) => (priOrder[a.priority] ?? 1) - (priOrder[b.priority] ?? 1));

      return res.json({
        readiness:  Number(llm.readiness) || baseReadiness,
        have:       baseHave,
        gaps:       allGaps,
        strengths:  Array.isArray(llm.strengths) ? llm.strengths.slice(0, 3).map(String) : [],
        insight:    String(llm.insight || '').trim(),
      });
    } catch {
      // LLM failed — return baseline with generic priorities
      const fallbackGaps = baseGap.map((s, i) => ({
        skill: s, type: 'hard', priority: i < 2 ? 'Critical' : i < 4 ? 'Important' : 'Useful', weeks: 8, reason: '', courseType: 'online course',
      }));
      return res.json({ readiness: baseReadiness, have: baseHave, gaps: fallbackGaps, strengths: [], insight: '' });
    }
  } catch (err) {
    console.error('Gap error:', err);
    res.status(500).json({ error: 'Failed to perform gap analysis.' });
  }
});

/* GET /api/future/courses?skills=skill1,skill2&priorities=Critical,Important,Useful&types=hard,soft,hard
   Returns courses grouped by skill. Hard skills → Coursera/Udemy. Soft skills → LinkedIn Learning. */
app.get('/api/future/courses', requireAuth, async (req, res) => {
  const { skills = '', priorities = '', types = '' } = req.query;
  const skillList = skills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  const prioList  = priorities.split(',').map(s => s.trim());
  const typeList  = types.split(',').map(s => s.trim().toLowerCase());
  if (!skillList.length) return res.json({ skillGroups: [], linkedInUrl: '', serpApiConfigured: false });

  const linkedInUrl = `https://www.linkedin.com/learning/search?keywords=${encodeURIComponent(skillList.slice(0, 2).join(' '))}`;

  // Per-skill search-link fallbacks (always returned)
  const skillGroups = skillList.map((skill, i) => {
    const isSoft = typeList[i] === 'soft';
    return {
      skill,
      skillType: isSoft ? 'soft' : 'hard',
      priority:  prioList[i] || 'Useful',
      courses:   [],
      searchUrl: isSoft
        ? {
            'LinkedIn Learning': `https://www.linkedin.com/learning/search?keywords=${encodeURIComponent(skill)}`,
            Coursera:            `https://www.coursera.org/courses?query=${encodeURIComponent(skill + ' communication leadership')}`,
          }
        : {
            Coursera: `https://www.coursera.org/courses?query=${encodeURIComponent(skill)}`,
            Udemy:    `https://www.udemy.com/courses/search/?q=${encodeURIComponent(skill)}&sort=highest-rated`,
          },
    };
  });

  if (!SERPAPI_KEY) {
    return res.json({ skillGroups, linkedInUrl, serpApiConfigured: false });
  }

  // Search top 3 skills — hard skills on Coursera+Udemy, soft skills on LinkedIn Learning
  // Limit to 3 to preserve SerpAPI credits
  const top3 = skillGroups.slice(0, 3);

  const searchTasks = top3.flatMap(sg => {
    if (sg.skillType === 'soft') {
      // Soft skills: LinkedIn Learning only (1 call instead of 2)
      return [
        searchCoursesViaSerpAPI(sg.skill, 'linkedin.com/learning')
          .then(courses => ({ skill: sg.skill, platform: 'LinkedIn Learning', courses })),
      ];
    }
    // Hard skills: Coursera + Udemy (2 calls)
    return [
      searchCoursesViaSerpAPI(sg.skill, 'coursera.org').then(courses => ({ skill: sg.skill, platform: 'Coursera', courses })),
      searchCoursesViaSerpAPI(sg.skill, 'udemy.com').then(courses  => ({ skill: sg.skill, platform: 'Udemy',    courses })),
    ];
  });

  const settled = await Promise.allSettled(searchTasks);

  // Accumulate courses into skillGroups
  const coursesBySkill = {};
  settled.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const { skill, courses } = r.value;
    if (!coursesBySkill[skill]) coursesBySkill[skill] = [];
    coursesBySkill[skill].push(...courses.map(c => ({ ...c, forSkill: skill })));
  });

  // Deduplicate within each skill group
  skillGroups.forEach(sg => {
    const raw  = coursesBySkill[sg.skill] || [];
    const seen = new Set();
    sg.courses = raw.filter(c => {
      const k = c.title.toLowerCase().slice(0, 40);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 4);
  });

  res.json({ skillGroups, linkedInUrl, serpApiConfigured: true });
});

// ── Health ────────────────────────────────────
app.get('/api/health', async (_, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get();
  res.json({
    status : 'ok',
    users  : count.n,
    ai     : !!ANTHROPIC_API_KEY,
    model  : ANTHROPIC_MODEL,
    ts     : new Date().toISOString(),
  });
});

// ── Fallback ──────────────────────────────────
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  TrustMatch server  →  http://localhost:${PORT}`);
  console.log(`  DB                 →  ${path.join(__dirname, 'data', 'skillbridge.db')}`);
  console.log(`  AI model           →  ${ANTHROPIC_MODEL}`);
  console.log(`  Anthropic API      →  ${ANTHROPIC_API_KEY ? 'configured ✓' : 'NOT SET — AI features disabled'}\n`);
});
