/* ─────────────────────────────────────────────
   Skillbridge – Resume Builder
   ───────────────────────────────────────────── */

// ── Seed data ────────────────────────────────
const SEED_EXPERIENCE = [
  {
    role: 'Senior UX Designer', company: 'TechCorp',
    start: 'Jan 2022', end: 'Present',
    desc: '• Led end-to-end redesign of flagship mobile app, improving task completion by 38%\n• Built and maintained the company design system used by 12 product teams\n• Partnered with engineers and PMs to ship 3 major feature launches'
  },
  {
    role: 'UX Designer', company: 'StartupLab',
    start: 'Mar 2019', end: 'Dec 2021',
    desc: '• Conducted 60+ user interviews and usability studies to inform product direction\n• Designed onboarding flow that increased D7 retention by 22%\n• Created interactive Figma prototypes for investor demos'
  },
  {
    role: 'Junior UI/UX Designer', company: 'CreativeHub',
    start: 'Jul 2017', end: 'Feb 2019',
    desc: '• Designed marketing websites and mobile screens for 15+ client projects\n• Collaborated with developers to implement pixel-perfect UI components'
  }
];

const SEED_EDUCATION = [
  { degree: 'B.Sc. Information Systems', school: 'National University of Singapore', year: '2017', gpa: 'Honours (Distinction)' }
];

const SEED_CERTS = [
  { name: 'Google UX Design Certificate', issuer: 'Google / Coursera', date: 'Mar 2023', id: 'GUX-2023-0042' },
  { name: 'Certified Usability Analyst', issuer: 'Human Factors International', date: 'Aug 2021', id: 'CUA-21-9812' }
];

// ── State ─────────────────────────────────────
let skills = [];

// ── Utilities ─────────────────────────────────
function esc(str) {
  return (str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Parse a CV description into clean bullet strings, handling two formats:
//
// Format A — explicit bullet markers (•, -, *, ►, ▸, –, —):
//   Each line that starts with a marker is a new bullet.
//   Lines without a marker are continuations joined onto the previous bullet.
//
// Format B — PDF-extracted prose (no markers):
//   \n inside a sentence is just word-wrap → replaced with a space.
//   A new bullet only starts when the previous sentence ends with . ! or ?
//   followed immediately by \n.
//
function parseBullets(desc) {
  if (!desc || !desc.trim()) return [];

  const BULLET_LINE = /^[•\-\*►▸–—]\s+\S/;   // line that starts with a marker + content
  const hasMarkers  = desc.split('\n').some(l => BULLET_LINE.test(l.trim()));

  if (hasMarkers) {
    // ── Format A: explicit bullets ──────────────
    const STRIP = /^[•\-\*►▸–—]\s*/;
    const bullets = [];
    let current   = null;
    for (const raw of desc.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (STRIP.test(line)) {
        if (current !== null) bullets.push(current);
        current = line.replace(STRIP, '');
      } else if (current !== null) {
        current += ' ' + line;   // continuation of previous bullet
      } else {
        current = line;
      }
    }
    if (current !== null) bullets.push(current);
    return bullets.filter(Boolean);
  }

  // ── Format B: PDF-wrapped prose ─────────────
  // Replace \n that does NOT immediately follow a sentence-ending punctuation
  // with a space (i.e. it's just word-wrap).
  // Then split on the remaining \n — those are the true bullet boundaries.
  const joined = desc.replace(/([^.!?])\n/g, '$1 ');
  return joined
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

function getEntries(containerId) {
  return [...document.getElementById(containerId).querySelectorAll('.rb-entry')];
}

function fieldVal(entry, name) {
  const el = entry.querySelector(`[name="${name}"]`);
  return el ? el.value.trim() : '';
}

// ── Collapsible sections ──────────────────────
function initToggles() {
  document.querySelectorAll('.rb-section-header').forEach(header => {
    // Open first two by default
    const section = header.closest('.rb-section');
    header.addEventListener('click', () => {
      section.classList.toggle('open');
    });
  });
  // Open personal & experience by default
  document.getElementById('sec-personal').classList.add('open');
  document.getElementById('sec-experience').classList.add('open');
  document.getElementById('sec-skills').classList.add('open');
  document.getElementById('sec-certs').classList.add('open');
  document.getElementById('sec-education').classList.add('open');
}

// ── Dynamic entry creation ────────────────────
function cloneTemplate(templateId) {
  const tpl = document.getElementById(templateId);
  return tpl.content.cloneNode(true);
}

function bindRemove(container) {
  container.querySelectorAll('.rb-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.rb-entry').remove();
      renderPreview();
    });
  });
}

function bindEntryInputs(container) {
  container.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', renderPreview);
    // Update entry label from first input
    if (el.name && (el.name.includes('-role') || el.name.includes('-degree') || el.name.includes('-name'))) {
      el.addEventListener('input', () => {
        const entry = el.closest('.rb-entry');
        const label = entry.querySelector('.rb-entry-label');
        if (label) label.textContent = el.value || 'New Entry';
      });
    }
  });
}

function addEntry(listId, templateId, seedData, fillFn) {
  const list = document.getElementById(listId);
  const clone = cloneTemplate(templateId);
  const tempDiv = document.createElement('div');
  tempDiv.appendChild(clone);
  if (seedData) fillFn(tempDiv, seedData);
  bindRemove(tempDiv);
  bindEntryInputs(tempDiv);
  list.appendChild(tempDiv);
  renderPreview();
}

function fillExperience(container, d) {
  if (d.role) container.querySelector('[name="exp-role"]').value = d.role;
  if (d.company) container.querySelector('[name="exp-company"]').value = d.company;
  if (d.start) container.querySelector('[name="exp-start"]').value = d.start;
  if (d.end) container.querySelector('[name="exp-end"]').value = d.end;
  if (d.desc) container.querySelector('[name="exp-desc"]').value = d.desc;
  const label = container.querySelector('.rb-entry-label');
  if (label && d.role) label.textContent = d.role;
}

function fillEducation(container, d) {
  if (d.degree) container.querySelector('[name="edu-degree"]').value = d.degree;
  if (d.school) container.querySelector('[name="edu-school"]').value = d.school;
  if (d.year) container.querySelector('[name="edu-year"]').value = d.year;
  if (d.gpa) container.querySelector('[name="edu-gpa"]').value = d.gpa;
  const label = container.querySelector('.rb-entry-label');
  if (label && d.degree) label.textContent = d.degree;
}

function fillCert(container, d) {
  if (d.name) container.querySelector('[name="cert-name"]').value = d.name;
  if (d.issuer) container.querySelector('[name="cert-issuer"]').value = d.issuer;
  if (d.date) container.querySelector('[name="cert-date"]').value = d.date;
  if (d.id) container.querySelector('[name="cert-id"]').value = d.id;
  const label = container.querySelector('.rb-entry-label');
  if (label && d.name) label.textContent = d.name;
}

// ── Skills ────────────────────────────────────
function buildSkillsFromInput() {
  const raw = document.getElementById('f-skills').value;
  skills = raw.split(',').map(s => s.trim()).filter(Boolean);
  renderSkillTags();
  renderPreview();
}

function renderSkillTags() {
  const container = document.getElementById('skill-tags');
  container.innerHTML = '';
  skills.forEach((skill, i) => {
    const tag = document.createElement('span');
    tag.className = 'skill-tag';
    tag.innerHTML = `${esc(skill)}<button data-i="${i}" title="Remove">✕</button>`;
    tag.querySelector('button').addEventListener('click', () => {
      skills.splice(i, 1);
      document.getElementById('f-skills').value = skills.join(', ');
      renderSkillTags();
      renderPreview();
    });
    container.appendChild(tag);
  });
}

// ── Preview rendering ─────────────────────────
function renderPreview() {
  // Personal
  const name = document.getElementById('f-name').value || 'Your Name';
  const title = document.getElementById('f-title').value || 'Job Title';
  const email = document.getElementById('f-email').value;
  const phone = document.getElementById('f-phone').value;
  const location = document.getElementById('f-location').value;
  const linkedin = document.getElementById('f-linkedin').value;
  const summary = document.getElementById('f-summary').value;

  document.getElementById('rv-name').textContent = name;
  document.getElementById('rv-title').textContent = title;

  // Contact block
  const contactParts = [email, phone, location, linkedin].filter(Boolean);
  document.getElementById('rv-contact').innerHTML = contactParts.map(c => `<div>${esc(c)}</div>`).join('');

  // Summary
  const summaryEl = document.getElementById('rv-summary');
  summaryEl.textContent = summary;
  document.getElementById('rv-summary-wrap').style.display = summary ? '' : 'none';

  // Experience
  const expContainer = document.getElementById('rv-experience');
  expContainer.innerHTML = '';
  getEntries('experience-list').forEach(entry => {
    const role = fieldVal(entry, 'exp-role');
    const company = fieldVal(entry, 'exp-company');
    const start = fieldVal(entry, 'exp-start');
    const end = fieldVal(entry, 'exp-end');
    const desc = fieldVal(entry, 'exp-desc');
    if (!role && !company) return;
    const dateStr = [start, end].filter(Boolean).join(' – ');
    expContainer.innerHTML += `
      <div class="rv-exp-item">
        <div class="rv-item-top">
          <span class="rv-item-role">${esc(role)}</span>
          <span class="rv-item-date">${esc(dateStr)}</span>
        </div>
        <div class="rv-item-org">${esc(company)}</div>
        ${desc ? `<ul class="rv-desc-list">${parseBullets(desc).map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      </div>`;
  });
  document.getElementById('rv-exp-wrap').style.display = expContainer.innerHTML ? '' : 'none';

  // Education
  const eduContainer = document.getElementById('rv-education');
  eduContainer.innerHTML = '';
  getEntries('education-list').forEach(entry => {
    const degree = fieldVal(entry, 'edu-degree');
    const school = fieldVal(entry, 'edu-school');
    const year = fieldVal(entry, 'edu-year');
    const gpa = fieldVal(entry, 'edu-gpa');
    if (!degree && !school) return;
    eduContainer.innerHTML += `
      <div class="rv-edu-item">
        <div class="rv-item-top">
          <span class="rv-item-role">${esc(degree)}</span>
          <span class="rv-item-date">${esc(year)}</span>
        </div>
        <div class="rv-item-org">${esc(school)}${gpa ? ' · ' + esc(gpa) : ''}</div>
      </div>`;
  });
  document.getElementById('rv-edu-wrap').style.display = eduContainer.innerHTML ? '' : 'none';

  // Skills
  const skillsContainer = document.getElementById('rv-skills');
  skillsContainer.innerHTML = skills.map(s => `<span class="rv-skill-chip">${esc(s)}</span>`).join('');
  document.getElementById('rv-skills-wrap').style.display = skills.length ? '' : 'none';

  // Certifications
  const certsContainer = document.getElementById('rv-certs');
  certsContainer.innerHTML = '';
  getEntries('certs-list').forEach(entry => {
    const name = fieldVal(entry, 'cert-name');
    const issuer = fieldVal(entry, 'cert-issuer');
    const date = fieldVal(entry, 'cert-date');
    const id = fieldVal(entry, 'cert-id');
    if (!name) return;
    certsContainer.innerHTML += `
      <div class="rv-cert-item">
        <div class="rv-item-top">
          <span class="rv-item-role">${esc(name)}</span>
          <span class="rv-item-date">${esc(date)}</span>
        </div>
        <div class="rv-item-org">${esc(issuer)}${id ? ' · ' + esc(id) : ''}</div>
      </div>`;
  });
  document.getElementById('rv-certs-wrap').style.display = certsContainer.innerHTML ? '' : 'none';
}

// ── Theme switcher ────────────────────────────
function initThemeSwitcher() {
  const preview = document.getElementById('resume-preview');
  document.querySelectorAll('.tmpl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tmpl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      preview.setAttribute('data-theme', btn.dataset.theme);
    });
  });
}

// ── PDF download (print) ──────────────────────
function initDownload() {
  document.getElementById('btn-download').addEventListener('click', () => {
    // Clone the resume doc into a print-only overlay
    const doc = document.getElementById('resume-preview').cloneNode(true);
    doc.id = 'print-clone';
    const overlay = document.createElement('div');
    overlay.id = 'print-overlay';
    overlay.appendChild(doc);
    document.body.appendChild(overlay);

    const style = document.createElement('style');
    style.id = 'print-style';
    style.textContent = `
      @media print {
        body > *:not(#print-overlay) { display: none !important; }
        #print-overlay {
          display: block !important;
          position: fixed; inset: 0; background: #fff; z-index: 99999;
        }
        #print-clone { box-shadow: none; width: 100%; }
      }`;
    document.head.appendChild(style);

    window.print();

    // Clean up after dialog closes
    setTimeout(() => {
      overlay.remove();
      style.remove();
    }, 1500);
  });
}

// ── Personal field listeners ──────────────────
function initPersonalListeners() {
  ['f-name','f-title','f-email','f-phone','f-location','f-linkedin','f-summary'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderPreview);
  });
}

// ── Add-entry buttons ─────────────────────────
function initAddButtons() {
  document.getElementById('add-experience').addEventListener('click', () =>
    addEntry('experience-list', 'tpl-experience', null, fillExperience));

  document.getElementById('add-education').addEventListener('click', () =>
    addEntry('education-list', 'tpl-education', null, fillEducation));

  document.getElementById('add-cert').addEventListener('click', () =>
    addEntry('certs-list', 'tpl-cert', null, fillCert));
}

// ── Skills input listener ─────────────────────
function initSkillsInput() {
  document.getElementById('f-skills').addEventListener('input', buildSkillsFromInput);
}

// ── Load CV data from API ─────────────────────
async function loadFromCVData() {
  const token = localStorage.getItem('sb_token');
  if (!token) return false;
  try {
    const resp = await fetch('/api/cv/data', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) return false;
    const hasData = data.experiences.length || data.education.length ||
                    data.certifications.length || data.skills.length;
    if (!hasData) return false;

    // Personal info — prefer CV-extracted data, fall back to localStorage user
    const user = (() => { try { return JSON.parse(localStorage.getItem('sb_user')); } catch { return null; } })();
    const p = data.personal;

    // Clear placeholder defaults before populating
    ['f-name','f-title','f-email','f-phone','f-location','f-linkedin','f-summary'].forEach(id => {
      document.getElementById(id).value = '';
    });

    if (p && p.name)     document.getElementById('f-name').value     = p.name;
    else if (user?.name) document.getElementById('f-name').value     = user.name;

    if (p && p.title)    document.getElementById('f-title').value    = p.title;
    if (p && p.email)    document.getElementById('f-email').value    = p.email;
    if (p && p.phone)    document.getElementById('f-phone').value    = p.phone;
    if (p && p.location) document.getElementById('f-location').value = p.location;
    if (p && p.summary)  document.getElementById('f-summary').value  = p.summary;

    // Experience
    document.getElementById('experience-list').innerHTML = '';
    for (const e of data.experiences) {
      addEntry('experience-list', 'tpl-experience', {
        role: e.role, company: e.company,
        start: e.start_date, end: e.end_date, desc: e.description
      }, fillExperience);
    }

    // Education
    document.getElementById('education-list').innerHTML = '';
    for (const e of data.education) {
      addEntry('education-list', 'tpl-education', {
        degree: e.degree, school: e.institution, year: e.year, gpa: e.grade
      }, fillEducation);
    }

    // Certifications
    document.getElementById('certs-list').innerHTML = '';
    for (const c of data.certifications) {
      addEntry('certs-list', 'tpl-cert', {
        name: c.name, issuer: c.issuer, date: c.date, id: c.credential_id
      }, fillCert);
    }

    // Skills
    if (data.skills.length) {
      document.getElementById('f-skills').value = data.skills.join(', ');
      buildSkillsFromInput();
    }

    return true;
  } catch { return false; }
}

// ── Bootstrap ─────────────────────────────────
async function init() {
  initToggles();
  initThemeSwitcher();
  initDownload();
  initPersonalListeners();
  initAddButtons();
  initSkillsInput();

  // Load from CV data first; fall back to seed data if none exists
  const loaded = await loadFromCVData();
  if (!loaded) {
    SEED_EXPERIENCE.forEach(d => addEntry('experience-list', 'tpl-experience', d, fillExperience));
    SEED_EDUCATION.forEach(d => addEntry('education-list', 'tpl-education', d, fillEducation));
    SEED_CERTS.forEach(d => addEntry('certs-list', 'tpl-cert', d, fillCert));
    buildSkillsFromInput();
  }

  renderPreview();
}

document.addEventListener('DOMContentLoaded', init);
