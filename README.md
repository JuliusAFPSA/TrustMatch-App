# TrustMatch App

An AI-powered career development platform that parses CVs, verifies work history, generates personalised career pathways, and builds tailored resumes — all powered by the Anthropic Claude API.

---

## Features

- **CV Upload & Parsing** — Upload PDF or DOCX; the app extracts work experience, education, certifications, and skills automatically
- **AI Skill Extraction** — Two-pass hybrid extraction (regex + LLM) finds named tools, certifications, and methodologies without hallucination
- **Work History Verification** — Items are auto-verified against known companies/institutions or flagged for manual review
- **Career Pathway Generation** — Generates four personalised pathways (Vertical, Lateral, Emerging, Specialist) using multi-domain detection across 9 industries
- **Gap Analysis** — Compares current skills against a target role; returns readiness score, skill gaps with priority/weeks, and strengths
- **Course Recommendations** — Searches Coursera and Udemy via SerpAPI, grouped by skill gap priority
- **Live Job Search** — Pulls real job listings from Google Jobs via SerpAPI
- **Resume Builder** — Live-preview resume editor that correctly handles PDF-extracted bullet points
- **JWT Authentication** — Secure login/register with bcrypt password hashing (12 salt rounds)

---

## Tech Stack

### Backend
| Component | Technology |
|---|---|
| Runtime | Node.js (v20+) |
| Framework | Express.js |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| Auth | JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`) |
| File Uploads | Multer |
| PDF Parsing | `pdf-parse` |
| DOCX Parsing | `mammoth` |
| AI / LLM | Anthropic Claude API (`@anthropic-ai/sdk`) |
| Job/Course Search | SerpAPI (Google Jobs + Coursera/Udemy) |

### Frontend
| Component | Technology |
|---|---|
| Pages | Vanilla HTML + CSS + JavaScript (no framework) |
| Styling | Custom CSS with CSS variables |
| Auth | JWT stored in `localStorage` |
| Navigation | Shared `nav.js` with active-state detection |

### AI / LLM
| Component | Detail |
|---|---|
| Provider | Anthropic Claude API |
| Default model | `claude-haiku-4-5-20251001` (fast, cost-efficient) |
| Alternative model | `claude-sonnet-4-6` (higher quality) |
| Format | JSON-mode prompts with code-fence stripping and fallback regex parsing |
| Skill extraction | Two-pass: regex (certs, parentheticals, connectors) + LLM with anti-hallucination substring check |
| Pathway generation | 4 parallel `Promise.allSettled` calls — one per pathway type |
| Gap analysis | Single focused LLM call with structured JSON schema |

---

## Project Structure

```
TrustMatch-App/
├── server.js          # Express backend — all routes, DB, LLM, parsing
├── auth.js            # Auth middleware helper
├── index.html         # Landing / login page
├── past.html          # CV upload & work history verification
├── future.html        # Career pathways, gap analysis, courses, jobs
├── resume.html        # Resume builder with live preview
├── script.js          # Shared frontend utilities
├── nav.js             # Navigation bar initialisation
├── future.js          # Future tab frontend logic
├── resume.js          # Resume builder logic
├── styles.css         # Global styles
├── nav.css            # Navigation styles
├── future.css         # Future tab styles
├── resume.css         # Resume builder styles
├── package.json
└── .env               # Secrets (never committed — see .gitignore)
```

---

## How the Core Logic Works

### CV Parsing Pipeline

```
Upload (PDF/DOCX)
    → Extract raw text (pdf-parse / mammoth)
    → splitSections()        — splits into header/experience/education/certs/skills
    → groupEntries()         — groups experience lines into discrete job entries
    → parseExpEntry()        — LLM extracts role, company, dates, bullets per entry
    → parseEducation()       — regex + LLM hybrid
    → parseCertifications()  — regex with auto-verification against known issuers
    → parseSkillsFromCV()    — two-pass hybrid (regex + LLM)
    → parsePersonalInfo()    — regex for email/phone/location, LLM for title/summary
    → saveToDatabase()       — stores all extracted data per user
```

### Skill Extraction (Two-Pass Hybrid)

The original approach used regex splitting on commas/semicolons which produced garbage fragments. This was replaced with:

**Pass 1 — Regex (zero hallucination):**
- Certifications section lines stripped of `\uf0b7` Wingdings bullets (common in Windows PDFs)
- Parenthetical items: `(Blue Prism)`, `(PMP)` — filtered for prepositions, degree abbreviations, institution codes
- Connector patterns: `"deploying X"`, `"implementing X"` → ProperCase tool names only

**Pass 2 — LLM (Claude Haiku):**
- Feeds only skill-dense lines (certs + lines containing known acronyms / ProperCase products)
- Anti-hallucination filter: each LLM result must appear verbatim in the source text
- Post-filters: max 4 words, no digits, no achievement-suffix phrases (`"efficiency"`, `"rollout"`, etc.)

### Career Pathway Generation

1. Domain detection scans the user's current role and experience against 9 industry domains (hospitality, operations, automation, data, finance, marketing, HR, sales, engineering)
2. Selects the matching domain's pathway templates and salary bands
3. Fires 4 parallel LLM calls simultaneously (`Promise.allSettled`) — one per pathway type
4. Each call returns `{title, description, demand, salaryRange, timeframe, keySkills[]}`
5. Falls back to a 503 with a clear error if all 4 calls fail

### Gap Analysis

Given a target role and the user's current skills, the LLM returns:
```json
{
  "readiness": 65,
  "have": ["skill1", "skill2"],
  "gaps": [{"skill": "X", "priority": "High", "weeks": 8, "reason": "..."}],
  "strengths": ["strength1"],
  "insight": "narrative paragraph"
}
```

---

## Setup & Local Development

### Prerequisites
- Node.js v20+
- Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
- SerpAPI key — optional, for job and course search (100 free searches/month at [serpapi.com](https://serpapi.com))

### Install

```bash
git clone https://github.com/JuliusAFPSA/TrustMatch-App.git
cd TrustMatch-App
npm install
```

### Configure

Create a `.env` file in the project root:

```env
# Required — powers all AI features
ANTHROPIC_API_KEY=sk-ant-...your-key-here...

# Optional — default is claude-haiku-4-5-20251001 (fast/cheap)
# Use claude-sonnet-4-6 for higher-quality outputs
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Optional — enables live job search and course recommendations
SERPAPI_KEY=your-serpapi-key

# Optional defaults
PORT=4000
JWT_SECRET=change-this-in-production
```

### Run

```bash
npm start
```

Open [http://localhost:4000](http://localhost:4000)

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | — | Register new user |
| `POST` | `/api/auth/login` | — | Login, returns JWT |
| `GET` | `/api/auth/me` | JWT | Get current user |
| `POST` | `/api/auth/logout` | JWT | Logout |
| `POST` | `/api/cv/upload` | JWT | Upload PDF/DOCX CV |
| `POST` | `/api/cv/text` | JWT | Submit CV as plain text |
| `GET` | `/api/cv/data` | JWT | Get all parsed CV data |
| `PATCH` | `/api/cv/item` | JWT | Update a CV item |
| `PATCH` | `/api/cv/confirm` | JWT | Confirm a CV item |
| `PATCH` | `/api/cv/skills` | JWT | Update skills list |
| `PATCH` | `/api/cv/verify` | JWT | Request manual verification |
| `POST` | `/api/future/pathways` | JWT | Generate career pathways |
| `POST` | `/api/future/gap` | JWT | Run gap analysis for a role |
| `GET` | `/api/future/courses` | JWT | Search courses by skills |
| `GET` | `/api/future/jobs` | JWT | Search live job listings |
| `GET` | `/api/health` | — | Server health check |

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Anthropic API key — powers all AI features |
| `ANTHROPIC_MODEL` | No | `claude-haiku-4-5-20251001` | Claude model to use. Use `claude-sonnet-4-6` for higher quality |
| `JWT_SECRET` | Yes (prod) | dev fallback | Secret for signing JWTs — app exits if default used in production |
| `SERPAPI_KEY` | For jobs/courses | — | SerpAPI key for Google Jobs + course search |
| `PORT` | No | `4000` | HTTP port |
| `NODE_ENV` | No | — | Set to `production` to enforce `JWT_SECRET` check |

---

## Deployment

Key steps for a production VPS deployment:

1. Provision a server with **2 GB RAM** minimum (Hetzner CX22 ~€4/mo or DigitalOcean $12/mo)
2. Install Node.js 20, nginx, PM2
3. Clone repo, run `npm install --production`
4. Create `.env` with a strong random `JWT_SECRET`, `ANTHROPIC_API_KEY`, and `NODE_ENV=production`
5. `pm2 start server.js --name trustmatch && pm2 save`
6. Configure nginx as reverse proxy on ports 80/443
7. Add HTTPS: `certbot --nginx -d yourdomain.com`

Full step-by-step instructions are in [DEPLOYMENT.md](DEPLOYMENT.md) *(coming soon)*.

---

## Security Notes

- `.env` is in `.gitignore` — never committed to version control
- `data/` (SQLite DB + user uploads) is in `.gitignore` — never committed
- Passwords hashed with bcrypt at 12 salt rounds
- JWTs expire after 7 days
- Server exits immediately at startup if `JWT_SECRET` is the dev default in production
- File uploads restricted to PDF and DOCX by MIME type

---

## License

MIT
