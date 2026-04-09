/* ─────────────────────────────────────────────
   Skillbridge – Frontend Auth Client
   Talks to Express backend at /api/auth/*
   ───────────────────────────────────────────── */
'use strict';

const API = '/api/auth';

// ── Token helpers ─────────────────────────────
function saveToken(token, user) {
  localStorage.setItem('sb_token', token);
  localStorage.setItem('sb_user', JSON.stringify(user));
}
function clearToken() {
  localStorage.removeItem('sb_token');
  localStorage.removeItem('sb_user');
}
function getToken()   { return localStorage.getItem('sb_token'); }
function getUser()    {
  try { return JSON.parse(localStorage.getItem('sb_user')); } catch { return null; }
}

// ── UI helpers ────────────────────────────────
function showError(baseId, msg) {
  const wrap = document.getElementById(baseId);
  const msgEl = document.getElementById(baseId + '-msg');
  if (!wrap) return;
  if (msgEl) msgEl.textContent = msg;
  wrap.classList.toggle('show', !!msg);
}
function showSuccess(baseId, msg) {
  const wrap = document.getElementById(baseId);
  const msgEl = document.getElementById(baseId + '-msg');
  if (!wrap) return;
  if (msgEl) msgEl.textContent = msg;
  wrap.classList.toggle('show', !!msg);
}
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.classList.toggle('loading', loading);
}

// ── Tab / role / toggle handled inline in HTML ──

// ── Session check – show welcome bar if already logged in ──
function checkExistingSession() {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) return;

  // Verify token is still valid against the server
  fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json())
    .then(data => {
      if (data.user) {
        showWelcomeBar(data.user);
      } else {
        clearToken();
      }
    })
    .catch(() => { /* server offline, keep local state */ showWelcomeBar(user); });
}

function showWelcomeBar(user) {
  const banner   = document.getElementById('sessionBanner');
  const authTabs = document.getElementById('authTabs');
  if (!banner) return;

  const initials = (user.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const elInit = document.getElementById('sessionInitials');
  const elName = document.getElementById('sessionName');
  const elRole = document.getElementById('sessionRole');
  if (elInit) elInit.textContent = initials;
  if (elName) elName.textContent = user.name;
  if (elRole) elRole.textContent = user.role === 'employer' ? 'Employer' : 'Job Seeker';

  // Point continue button at the right page
  const continueBtn = document.getElementById('continueBtn');
  if (continueBtn) continueBtn.href = user.role === 'employer' ? 'future.html' : 'past.html';

  banner.classList.add('show');
  if (authTabs) authTabs.style.display = 'none';
}

// ── Logout ────────────────────────────────────
function initLogout() {
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    const token = getToken();
    if (token) {
      fetch(`${API}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    clearToken();
    location.reload();
  });
}

// ── Redirect target based on role ─────────────
function redirectAfterLogin(user) {
  if (user.role === 'employer') {
    window.location.href = 'future.html'; // employer goes to talent grid
  } else {
    window.location.href = 'past.html';
  }
}

// ── Sign In ───────────────────────────────────
function initSignIn() {
  document.getElementById('signInForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    showError('signin-error', '');
    showSuccess('signin-success', '');
    setLoading('si-submit', true);

    const email    = document.getElementById('si-email').value.trim();
    const password = document.getElementById('si-password').value;

    try {
      const res  = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();

      if (!res.ok) {
        showError('signin-error', data.error || 'Login failed.');
        return;
      }

      saveToken(data.token, data.user);
      showSuccess('signin-success', `Welcome back, ${data.user.name}! Redirecting…`);
      setTimeout(() => redirectAfterLogin(data.user), 800);

    } catch {
      showError('signin-error', 'Could not reach the server. Please try again.');
    } finally {
      setLoading('si-submit', false);
    }
  });
}

// ── Sign Up ───────────────────────────────────
function initSignUp() {
  document.getElementById('signUpForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    showError('signup-error', '');
    showSuccess('signup-success', '');

    const name     = document.getElementById('su-name').value.trim();
    const email    = document.getElementById('su-email').value.trim();
    const password = document.getElementById('su-password').value;
    const confirm  = document.getElementById('su-confirm').value;
    const role     = document.getElementById('su-role').value;

    if (password !== confirm) {
      showError('signup-error', 'Passwords do not match.');
      return;
    }

    setLoading('su-submit', true);

    try {
      const res  = await fetch(`${API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role })
      });
      const data = await res.json();

      if (!res.ok) {
        showError('signup-error', data.error || 'Registration failed.');
        return;
      }

      saveToken(data.token, data.user);
      showSuccess('signup-success', `Account created! Welcome, ${data.user.name}! Redirecting…`);
      setTimeout(() => redirectAfterLogin(data.user), 900);

    } catch {
      showError('signup-error', 'Could not reach the server. Please try again.');
    } finally {
      setLoading('su-submit', false);
    }
  });
}

// ── Bootstrap ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initLogout();
  initSignIn();
  initSignUp();
  checkExistingSession();
});
