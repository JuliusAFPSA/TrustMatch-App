/* ─────────────────────────────────────────────
   Skillbridge – Shared Navigation Component
   Usage: add <div id="app-nav"></div> at top of
   <body>, then call Nav.init('past'|'resume'|'future')
   ───────────────────────────────────────────── */
'use strict';

const Nav = (() => {
  const STEPS = [
    { id: 'past',   label: 'Past',    href: 'past.html' },
    { id: 'resume', label: 'Present', href: 'resume.html' },
    { id: 'future', label: 'Future',  href: 'future.html' },
  ];

  function getUser()  { try { return JSON.parse(localStorage.getItem('sb_user')); } catch { return null; } }
  function getToken() { return localStorage.getItem('sb_token'); }

  function initials(name = '') {
    return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  }

  function esc(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render(activeStep) {
    const mount = document.getElementById('app-nav');
    if (!mount) return;

    const user = getUser();

    const stepsHTML = STEPS.map((s, i) => `
      <a href="${s.href}" class="nav-crumb ${activeStep === s.id ? 'active' : ''}">
        <span>${i + 1}</span>${s.label}
      </a>`).join('');

    const userHTML = user ? `
      <div class="nav-user">
        <div class="nav-avatar">${initials(user.name)}</div>
        <span class="nav-name">${esc(user.name)}</span>
        <span class="nav-role-pill">${user.role === 'employer' ? 'Employer' : 'Job Seeker'}</span>
        <button class="nav-logout-btn" id="nav-logout-btn">Sign out</button>
      </div>` : `
      <div class="nav-guest">
        <a href="index.html" class="nav-signin-link">Sign in →</a>
      </div>`;

    mount.innerHTML = `
      <nav class="app-nav">
        <a href="index.html" class="nav-logo">Skillbridge<span class="nav-logo-dot"></span></a>
        <div class="nav-steps">${stepsHTML}</div>
        ${userHTML}
      </nav>`;

    document.getElementById('nav-logout-btn')?.addEventListener('click', logout);

    if (!user && !window._navAllowGuest) {
      window.location.href = 'index.html';
    }
  }

  async function logout() {
    const token = getToken();
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
    window.location.href = 'index.html';
  }

  // Silently verify token in background and refresh stored user
  function verifySession() {
    const token = getToken();
    if (!token) return;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (d.user) {
          localStorage.setItem('sb_user', JSON.stringify(d.user));
          // Re-render nav with fresh name (in case it changed)
          render(_activeStep);
        } else {
          localStorage.removeItem('sb_token');
          localStorage.removeItem('sb_user');
          window.location.href = 'index.html';
        }
      })
      .catch(() => {});
  }

  let _activeStep = '';

  return {
    init(activeStep) {
      _activeStep = activeStep;
      // Fix: DOMContentLoaded may already have fired when scripts are at bottom of body
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          render(activeStep);
          verifySession();
        });
      } else {
        render(activeStep);
        verifySession();
      }
    }
  };
})();
