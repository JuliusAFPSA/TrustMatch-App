/* ─────────────────────────────────────────────
   Skillbridge – Future Pathways  (live data)
   All data comes from backend API — no hardcoding
   ───────────────────────────────────────────── */

// ── Auth helpers ──────────────────────────────
function getToken() { return localStorage.getItem('sb_token') || ''; }
function authHeaders(json = false) {
  const h = { Authorization: 'Bearer ' + getToken() };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// ── State ─────────────────────────────────────
let pathways       = [];
let selectedId     = null;
let activeFilter   = 'all';
let cvData         = null;   // { experiences, skills, personal, … }

// ── Utilities ─────────────────────────────────
function esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function skeletonLines(n, widths) {
  return `<div class="ft-loading-skeleton">${
    Array.from({ length: n }, (_, i) => {
      const w = widths ? widths[i % widths.length] : (60 + (i * 17) % 35);
      return `<div class="ft-skeleton-line" style="width:${w}%"></div>`;
    }).join('')
  }</div>`;
}

function showSection(id) {
  const sec = document.getElementById(id);
  sec.classList.remove('ft-section-hidden');
  sec.classList.add('visible');
}

function stars(rating) {
  if (!rating) return '';
  const full  = Math.floor(rating);
  const half  = rating - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// ── Load CV data ──────────────────────────────
async function loadCVData() {
  try {
    const resp = await fetch('/api/cv/data', { headers: authHeaders() });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// ── Populate current-role node ────────────────
function populateCurrentRole(cv) {
  if (!cv) return;
  const exp0 = cv.experiences && cv.experiences[0];
  document.getElementById('crn-title').textContent  = exp0?.role    || cv.personal?.title || 'Your Current Role';
  document.getElementById('crn-skills').textContent = (cv.skills || []).slice(0, 3).join(' · ') || '—';

  const total    = (cv.experiences || []).length;
  const verified = (cv.experiences || []).filter(e => e.verification_status === 'auto_verified').length;
  const pct = total ? Math.round((verified / total) * 100) : 0;
  document.getElementById('crn-ring').textContent = pct + '%';

  // Hero
  const user = (() => { try { return JSON.parse(localStorage.getItem('sb_user')); } catch { return null; } })();
  if (user) {
    const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('hero-initials').textContent = initials;
    document.getElementById('hero-name').textContent     = user.name;
  }
  document.getElementById('hero-role').textContent =
    (exp0 ? exp0.role + ' · ' : '') + (cv.personal?.location || 'Singapore');
  document.getElementById('hero-skills-badge').textContent =
    (cv.skills || []).length + ' Skills Extracted';
}

// ══════════════════════════════════════════════
// SECTION 1 — CAREER PATHWAYS
// ══════════════════════════════════════════════

function renderPathCardsLoading() {
  document.getElementById('path-cards').innerHTML =
    Array.from({ length: 4 }, () =>
      `<div class="path-card-loading">${skeletonLines(3, [80, 55, 70])}</div>`
    ).join('');
}

function renderPathCardsError(msg) {
  document.getElementById('path-cards').innerHTML =
    `<div class="ft-error-state">
       <span class="ft-error-icon">⚠</span>
       <div>
         <strong>${esc(msg)}</strong>
         ${msg.includes('Ollama') ? '<br><small>Run <code>ollama serve</code> in your terminal.</small>' : ''}
         ${msg.includes('CV') ? '<br><a href="/past.html">Upload your CV →</a>' : ''}
       </div>
     </div>`;
}

async function loadPathways() {
  renderPathCardsLoading();
  try {
    const resp = await fetch('/api/future/pathways', { method: 'POST', headers: authHeaders(true) });
    const data = await resp.json();
    if (!resp.ok) { renderPathCardsError(data.error || 'Failed to load pathways'); return; }
    pathways = data.pathways || [];
    renderPathCards();
    drawArrows();
    // Auto-select highest-match path
    if (pathways.length) {
      const best = [...pathways].sort((a, b) => b.match - a.match)[0];
      selectPath(best.id);
    }
  } catch (err) {
    renderPathCardsError('Could not reach server. Is it running?');
  }
}

function renderPathCards() {
  const grid = document.getElementById('path-cards');
  if (!pathways.length) {
    grid.innerHTML = '<div class="ft-empty-state"><div class="ft-empty-icon">🗺️</div>No pathways generated.</div>';
    return;
  }

  const demandCls = { High: 'high', Medium: 'medium', Growing: 'growing' };

  grid.innerHTML = pathways.map(p => {
    const dc = demandCls[p.demand] || 'medium';
    return `
    <div class="path-card type-${esc(p.type)}" data-id="${esc(p.id)}" role="button" tabindex="0">
      <div class="pc-header">
        <span class="pc-title">${esc(p.title)}</span>
        <span class="pc-type-badge">${esc(p.typeName)}</span>
      </div>
      <div class="pc-meta">
        <span class="pc-match">${p.match}% match</span>
        <div class="pc-match-bar"><div class="pc-match-fill" style="width:${p.match}%"></div></div>
        <span class="pc-salary">${esc(p.salary)}</span>
        <span class="pc-demand ${dc}">${esc(p.demand || 'Medium')} Demand</span>
        <span class="pc-openings" id="jobs-badge-${esc(p.id)}">📋 Loading…</span>
      </div>
      ${p.description ? `<p class="pc-desc">${esc(p.description)}</p>` : ''}
    </div>`;
  }).join('');

  grid.querySelectorAll('.path-card').forEach(card => {
    card.addEventListener('click', () => selectPath(card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') selectPath(card.dataset.id); });
  });

  // Load job counts for all cards in background (non-blocking)
  pathways.forEach(p => loadJobBadge(p));
}

async function loadJobBadge(pathway) {
  const badge = document.getElementById(`jobs-badge-${pathway.id}`);
  if (!badge) return;
  try {
    const params = new URLSearchParams({ role: pathway.title, location: 'Singapore' });
    const resp = await fetch('/api/future/jobs?' + params, { headers: authHeaders() });
    const data = await resp.json();
    if (!data.configured) {
      badge.textContent = '⚙ Configure SERPAPI_KEY';
      badge.title = data.message;
    } else if (data.total > 0) {
      badge.textContent = `📋 ${data.total} openings`;
    } else {
      badge.textContent = '📋 No results';
    }
  } catch {
    badge.textContent = '📋 —';
  }
}

// ── Draw SVG connector lines ──────────────────
function drawArrows() {
  const svg = document.getElementById('arrows-svg');
  if (!svg) return;
  const cards = document.querySelectorAll('.path-card');
  if (!cards.length) return;

  const svgRect = svg.getBoundingClientRect();
  const lines = [];
  cards.forEach(card => {
    const r = card.getBoundingClientRect();
    lines.push(r.top + r.height / 2 - svgRect.top);
  });

  const midY = lines.reduce((a, b) => a + b, 0) / lines.length;
  let markup = `<line x1="0" y1="${midY}" x2="30" y2="${midY}" stroke="#d0d8f0" stroke-width="2"/>`;
  lines.forEach(y => {
    markup += `<line x1="30" y1="${midY}" x2="30" y2="${y}" stroke="#d0d8f0" stroke-width="1.5"/>`;
    markup += `<line x1="30" y1="${y}" x2="58" y2="${y}" stroke="#d0d8f0" stroke-width="1.5"/>`;
    markup += `<polygon points="54,${y - 4} 62,${y} 54,${y + 4}" fill="#d0d8f0"/>`;
  });
  svg.innerHTML = markup;
}

// ── Select a path ─────────────────────────────
function selectPath(id) {
  selectedId = id;
  const pathway = pathways.find(p => p.id === id);
  if (!pathway) return;

  document.querySelectorAll('.path-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.id === id));

  showSection('sec-gap');
  showSection('sec-learning');

  // Fire jobs + gap in parallel, then load courses from gap results
  Promise.all([
    loadJobs(pathway),
    loadGap(pathway),
  ]).then(([, gapData]) => {
    if (gapData && gapData.gaps && gapData.gaps.length) {
      loadCourses(gapData.gaps);
    } else {
      document.getElementById('learning-timeline').innerHTML =
        `<div class="ft-empty-state"><div class="ft-empty-icon">🎉</div>You already have all required skills for this role!</div>`;
    }
  });

  setTimeout(() => document.getElementById('sec-gap').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
}

// ══════════════════════════════════════════════
// SECTION 1b — JOB MARKET BAR
// ══════════════════════════════════════════════

async function loadJobs(pathway) {
  const bar = document.getElementById('job-market-bar');
  bar.style.display = '';
  document.getElementById('jmb-role-name').textContent = pathway.title;
  document.getElementById('jmb-total').textContent = '—';
  document.getElementById('jmb-sources').innerHTML = '<span class="jmb-loading">Searching Google Jobs…</span>';

  try {
    const params = new URLSearchParams({ role: pathway.title, location: 'Singapore' });
    const resp = await fetch('/api/future/jobs?' + params, { headers: authHeaders() });
    const data = await resp.json();

    if (!data.configured) {
      document.getElementById('jmb-sources').innerHTML =
        `<span class="jmb-config-note">⚙ ${esc(data.message)}</span>`;
      document.getElementById('jmb-total').textContent = '—';
      return data;
    }

    document.getElementById('jmb-total').textContent = data.total || 0;
    document.getElementById('jmb-sources').innerHTML =
      `<span class="jmb-src go">Google Jobs&nbsp;&nbsp;${data.total}</span>`;

    // Show job listing cards if we got results
    const listEl = document.getElementById('job-listings');
    if (listEl && data.jobs && data.jobs.length) {
      listEl.innerHTML = data.jobs.map(j => `
        <div class="job-card">
          <div class="job-card-title">${esc(j.title)}</div>
          <div class="job-card-company">${esc(j.company)}${j.location ? ' · ' + esc(j.location) : ''}</div>
          <div class="job-card-meta">
            ${j.via ? `<span class="job-card-via">${esc(j.via)}</span>` : ''}
            ${j.salary ? `<span class="job-card-salary">${esc(j.salary)}</span>` : ''}
            ${j.posted ? `<span class="job-card-posted">${esc(j.posted)}</span>` : ''}
          </div>
        </div>`).join('');
      listEl.style.display = '';
    }
    return data;
  } catch (err) {
    document.getElementById('jmb-sources').innerHTML =
      `<span class="jmb-config-note">⚠ Job search unavailable</span>`;
    return {};
  }
}

// ══════════════════════════════════════════════
// SECTION 2 — SKILL GAP ANALYSIS
// ══════════════════════════════════════════════

async function loadGap(pathway) {
  document.getElementById('gap-role-label').textContent = pathway.title;
  document.getElementById('learn-role-label').textContent = pathway.title;
  document.getElementById('have-skills').innerHTML  = skeletonLines(3, [80, 65, 75]);
  document.getElementById('gap-skills').innerHTML   = skeletonLines(3, [70, 85, 60]);
  document.getElementById('skill-bars').innerHTML   = skeletonLines(4, [100, 100, 100, 100]);
  document.getElementById('readiness-pct').textContent = '…';
  // Clear stale insight from previous pathway selection
  document.getElementById('gap-insight')?.remove();

  try {
    const resp = await fetch('/api/future/gap', {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ pathwayTitle: pathway.title, requiredSkills: pathway.requiredSkills || [] }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      document.getElementById('have-skills').innerHTML =
        `<div class="ft-error-state"><span class="ft-error-icon">⚠</span>${esc(data.error)}</div>`;
      return null;
    }
    renderGapAnalysis(data);
    return data;
  } catch {
    document.getElementById('have-skills').innerHTML =
      `<div class="ft-error-state"><span class="ft-error-icon">⚠</span>Gap analysis unavailable.</div>`;
    return null;
  }
}

function renderGapAnalysis(data) {
  const { readiness = 0, have = [], gaps = [], strengths = [], insight = '' } = data;

  // Readiness ring
  const pct = Math.max(0, Math.min(100, readiness));
  document.getElementById('readiness-pct').textContent = pct + '%';
  const circumference = 2 * Math.PI * 24;
  const arc = document.getElementById('readiness-arc');
  arc.setAttribute('stroke', pct >= 70 ? '#1c8e4e' : pct >= 40 ? '#e07b1a' : '#d64040');
  arc.setAttribute('stroke-dasharray', circumference);
  arc.setAttribute('stroke-dashoffset', circumference);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    arc.setAttribute('stroke-dashoffset', circumference * (1 - pct / 100));
  }));

  // "Skills you have" column — flat list + strengths callout
  let haveHtml = '';
  if (have.length) {
    haveHtml += have.map(s => `<div class="sml-item-row have-row"><span class="sml-icon">✓</span><span>${esc(s)}</span></div>`).join('');
  } else {
    haveHtml += '<div style="color:var(--muted);font-size:13px;padding:8px;">None of the required skills matched yet.</div>';
  }
  if (strengths.length) {
    haveHtml += `<div class="gap-strengths">
      <div class="gap-strengths-label">Your competitive advantages:</div>
      <div class="strength-chips">${strengths.map(s => `<span class="strength-chip">${esc(s)}</span>`).join('')}</div>
    </div>`;
  }
  document.getElementById('have-skills').innerHTML = haveHtml;

  // "Skills to develop" column — enriched with priority, weeks, reason
  if (!gaps.length) {
    document.getElementById('gap-skills').innerHTML =
      '<div style="color:#1c8e4e;font-size:13px;padding:8px;">✓ No skill gaps — you\'re ready!</div>';
  } else {
    const priConfig = {
      Critical:  { cls: 'critical',  icon: '🔴' },
      Important: { cls: 'important', icon: '🟡' },
      Useful:    { cls: 'useful',    icon: '🟢' },
    };
    document.getElementById('gap-skills').innerHTML = gaps.map(g => {
      const cfg     = priConfig[g.priority] || priConfig.Useful;
      const isSoft  = g.type === 'soft';
      const typeBadge = isSoft
        ? '<span class="skill-type-badge soft">💬 Soft</span>'
        : '<span class="skill-type-badge hard">🔧 Hard</span>';
      const courseHint = g.courseType
        ? `<span class="course-type-hint">${esc(g.courseType)}</span>`
        : '';
      return `
        <div class="sml-item-row">
          <span class="sml-icon">⚡</span>
          <div class="sml-item-body">
            <div class="sml-item-top">
              <span class="sml-skill-name">${esc(g.skill)}</span>
              ${typeBadge}
              <span class="pri-badge ${cfg.cls}">${cfg.icon} ${esc(g.priority)}</span>
              ${g.weeks ? `<span class="weeks-chip">~${g.weeks}w</span>` : ''}
              ${courseHint}
            </div>
            ${g.reason ? `<div class="gap-reason">${esc(g.reason)}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  // Skill coverage bars — have items at 100%, gaps at 0
  const barItems = [
    ...have.map(s => ({ label: s, isHave: true })),
    ...gaps.map(g => ({ label: g.skill, isHave: false })),
  ];
  document.getElementById('skill-bars').innerHTML = barItems.map(({ label, isHave }) => {
    const colour = isHave ? '#1c8e4e' : '#d64040';
    const cls    = isHave ? 'full' : 'none';
    const target = isHave ? 100 : 0;
    return `
      <div class="sb-row">
        <div class="sb-label">
          <span class="sb-name">${esc(label)}</span>
          <span class="sb-pct" style="color:${colour}">${isHave ? '100%' : 'Gap'}</span>
        </div>
        <div class="sb-track">
          <div class="sb-fill ${cls}" data-target="${target}" style="width:0%"></div>
        </div>
      </div>`;
  }).join('');
  setTimeout(() => {
    document.querySelectorAll('.sb-fill').forEach(el => { el.style.width = el.dataset.target + '%'; });
  }, 80);

  // Insight callout
  const insightEl = document.getElementById('gap-insight');
  const insightHtml = insight
    ? `<div id="gap-insight" class="gap-insight-box"><span class="gap-insight-icon">💡</span><span>${esc(insight)}</span></div>`
    : '';
  if (insightEl) {
    if (insight) insightEl.outerHTML = insightHtml;
    else insightEl.remove();
  } else if (insight) {
    document.getElementById('sec-gap').insertAdjacentHTML('beforeend', insightHtml);
  }
}

// ══════════════════════════════════════════════
// SECTION 3 — LEARNING RECOMMENDATIONS
// ══════════════════════════════════════════════

// gapItems is an array of {skill, priority, weeks, reason} objects (new format)
async function loadCourses(gapItems) {
  const timeline = document.getElementById('learning-timeline');
  timeline.innerHTML = `<div class="ft-loading-skeleton">${
    Array.from({ length: 3 }, () =>
      `<div class="ft-skeleton-card" style="margin-bottom:8px;"></div>`
    ).join('')
  }</div>`;

  try {
    const skills     = gapItems.map(g => g.skill).slice(0, 6).join(',');
    const priorities = gapItems.map(g => g.priority || 'Useful').slice(0, 6).join(',');
    const types      = gapItems.map(g => g.type || 'hard').slice(0, 6).join(',');
    const params = new URLSearchParams({ skills, priorities, types });
    const resp = await fetch('/api/future/courses?' + params, { headers: authHeaders() });
    const data = await resp.json();
    renderLearning(data);
  } catch {
    timeline.innerHTML = `<div class="ft-error-state"><span class="ft-error-icon">⚠</span>Could not load course recommendations.</div>`;
  }
}

// data = { skillGroups:[{skill, priority, courses:[], searchUrl:{Coursera,Udemy}}], linkedInUrl, serpApiConfigured }
function renderLearning(data) {
  const timeline = document.getElementById('learning-timeline');
  const { skillGroups = [], linkedInUrl = '', serpApiConfigured = false } = data;

  // Build query from all skills for LinkedIn fallback
  const allSkills = skillGroups.map(sg => sg.skill);
  const liQuery   = allSkills.slice(0, 2).join(' ');
  const liHref    = linkedInUrl || `https://www.linkedin.com/learning/search?keywords=${encodeURIComponent(liQuery)}`;

  const priConfig = {
    Critical:  { cls: 'critical',  label: 'Critical Skill' },
    Important: { cls: 'important', label: 'Important Skill' },
    Useful:    { cls: 'useful',    label: 'Nice to Have' },
  };

  let phaseNum = 1;
  let html = '';

  for (const sg of skillGroups) {
    const pc      = priConfig[sg.priority] || priConfig.Useful;
    const isSoft  = sg.skillType === 'soft';
    const hasCourses = sg.courses && sg.courses.length > 0;
    const typeLabel  = isSoft
      ? '<span class="skill-type-badge soft" style="font-size:11px;">💬 Soft Skill</span>'
      : '<span class="skill-type-badge hard" style="font-size:11px;">🔧 Hard Skill</span>';

    html += `
      <div class="learn-phase" data-phase>
        <div class="skill-phase-header">
          <div class="skill-phase-name">
            <span class="phase-num">Phase ${phaseNum}</span>
            <span class="phase-skill">${esc(sg.skill)}</span>
            ${typeLabel}
          </div>
          <span class="pri-badge ${pc.cls}">${esc(pc.label)}</span>
        </div>
        <div class="course-cards">`;

    if (hasCourses) {
      html += sg.courses.map(c => renderCourseCard(c)).join('');
    } else if (isSoft) {
      // Soft skill fallback: LinkedIn Learning + Coursera
      const liUrl = sg.searchUrl['LinkedIn Learning'] || liHref;
      html += `
        <div class="course-card" data-platform="LinkedIn Learning">
          <span class="cc-platform linkedin">LinkedIn Learning</span>
          <div class="cc-title">Find "${esc(sg.skill)}" on LinkedIn Learning</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;">Video courses from industry practitioners — ideal for soft skills</div>
          <div class="cc-footer">
            <span></span>
            <a class="cc-enroll" href="${esc(liUrl)}" target="_blank" rel="noopener noreferrer">Search LinkedIn Learning →</a>
          </div>
        </div>
        <div class="course-card" data-platform="Coursera">
          <span class="cc-platform coursera">Coursera</span>
          <div class="cc-title">Find "${esc(sg.skill)}" courses on Coursera</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;">Structured courses and specialisations from top universities</div>
          <div class="cc-footer">
            <span></span>
            <a class="cc-enroll" href="${esc(sg.searchUrl.Coursera || `https://www.coursera.org/courses?query=${encodeURIComponent(sg.skill)}`)}" target="_blank" rel="noopener noreferrer">Search Coursera →</a>
          </div>
        </div>`;
    } else {
      // Hard skill fallback: Coursera + Udemy
      html += `
        <div class="course-card" data-platform="Coursera">
          <span class="cc-platform coursera">Coursera</span>
          <div class="cc-title">Find "${esc(sg.skill)}" courses on Coursera</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;">Browse structured courses and certifications</div>
          <div class="cc-footer">
            <span></span>
            <a class="cc-enroll" href="${esc(sg.searchUrl.Coursera)}" target="_blank" rel="noopener noreferrer">Search Coursera →</a>
          </div>
        </div>
        <div class="course-card" data-platform="Udemy">
          <span class="cc-platform udemy">Udemy</span>
          <div class="cc-title">Find "${esc(sg.skill)}" courses on Udemy</div>
          <div style="font-size:11px;color:var(--muted);line-height:1.5;">Practical, self-paced project-based courses</div>
          <div class="cc-footer">
            <span></span>
            <a class="cc-enroll" href="${esc(sg.searchUrl.Udemy)}" target="_blank" rel="noopener noreferrer">Search Udemy →</a>
          </div>
        </div>`;
    }

    html += `</div></div>`;
    phaseNum++;
  }

  if (!serpApiConfigured && skillGroups.length) {
    html += `<div class="ft-info-state" style="margin-top:8px;">
      <span>ℹ</span>
      <span>Add <strong>SERPAPI_KEY</strong> to <code>.env</code> to see individual course cards with ratings and descriptions.</span>
    </div>`;
  }

  // LinkedIn Learning — always shown as final phase
  html += `
    <div class="learn-phase" data-phase>
      <div class="skill-phase-header">
        <div class="skill-phase-name">
          <span class="phase-num">Phase ${phaseNum}</span>
          <span class="phase-skill">LinkedIn Learning</span>
        </div>
      </div>
      <div class="li-search-card" data-platform="LinkedIn Learning">
        <div>
          <div class="li-search-card-text">Expert-led courses for: <em>${esc(liQuery)}</em></div>
          <div class="li-search-card-sub">Included with LinkedIn Premium · Progress tracked on your profile</div>
        </div>
        <a class="li-search-btn" href="${esc(liHref)}" target="_blank" rel="noopener noreferrer">
          Open LinkedIn Learning →
        </a>
      </div>
    </div>`;

  timeline.innerHTML = html || `<div class="ft-empty-state"><div class="ft-empty-icon">📚</div>No courses found for these skills.</div>`;
  initPlatformFilter();
  applyPlatformFilter();
}

function renderCourseCard(c) {
  const platformKey = c.platform === 'LinkedIn Learning' ? 'linkedin'
    : c.platform === 'Coursera' ? 'coursera' : 'udemy';

  const ratingStr = c.rating
    ? `<span class="cc-rating">${stars(c.rating)} ${c.rating}</span>`
    : '';
  const reviewsStr = c.reviews
    ? `<span>${c.reviews.toLocaleString()} reviews</span>`
    : '';
  const durationStr = c.duration
    ? `<span>⏱ ${esc(c.duration)}</span>`
    : '';

  const diffLabel = (c.difficulty || 'intermediate');
  const diffClass = ['beginner', 'intermediate', 'advanced'].includes(diffLabel)
    ? diffLabel : 'intermediate';

  return `
    <div class="course-card" data-platform="${esc(c.platform)}">
      <span class="cc-platform ${platformKey}">${esc(c.platform)}</span>
      ${c.image ? `<img src="${esc(c.image)}" alt="" style="width:100%;border-radius:8px;object-fit:cover;height:80px;">` : ''}
      <div class="cc-title">${esc(c.title)}</div>
      ${c.description ? `<div style="font-size:11px;color:var(--muted);line-height:1.5;">${esc(c.description)}</div>` : ''}
      <div class="cc-meta">${durationStr}${ratingStr}${reviewsStr}</div>
      <div class="cc-footer">
        <span class="cc-diff ${diffClass}">${diffClass.charAt(0).toUpperCase() + diffClass.slice(1)}</span>
        <a class="cc-enroll" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Enrol →</a>
      </div>
    </div>`;
}

// ── Platform filter ───────────────────────────
function initPlatformFilter() {
  const pf = document.getElementById('platform-filter');
  if (!pf || pf.dataset.bound) return;
  pf.dataset.bound = '1';
  pf.addEventListener('click', e => {
    const btn = e.target.closest('.pf-btn');
    if (!btn) return;
    activeFilter = btn.dataset.platform;
    document.querySelectorAll('.pf-btn').forEach(b => b.classList.toggle('active', b === btn));
    applyPlatformFilter();
  });
}

function applyPlatformFilter() {
  document.querySelectorAll('.course-card, .li-search-card').forEach(card => {
    const matches = activeFilter === 'all' || card.dataset.platform === activeFilter;
    card.closest('.learn-phase') && (card.style.display = matches ? '' : 'none');
  });
  document.querySelectorAll('[data-phase]').forEach(phase => {
    const hasVisible = [...phase.querySelectorAll('.course-card, .li-search-card')]
      .some(c => c.style.display !== 'none');
    phase.style.display = hasVisible ? '' : 'none';
  });
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════
async function init() {
  // Load CV data for hero + current-role node
  cvData = await loadCVData();
  populateCurrentRole(cvData);

  // Add job listings container to job-market-bar if not present
  const jmb = document.getElementById('job-market-bar');
  if (jmb && !document.getElementById('job-listings')) {
    jmb.insertAdjacentHTML('afterend',
      '<div class="job-listings" id="job-listings" style="display:none;"></div>');
  }

  // Load AI-suggested pathways
  await loadPathways();

  window.addEventListener('resize', drawArrows);
}

document.addEventListener('DOMContentLoaded', init);
