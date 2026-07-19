/* auth.js — shared auth client for all pages. */
'use strict';

window.Auth = (() => {
  async function me() {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (!r.ok) return null;
    const j = await r.json();
    return j;
  }
  async function login(username, password) {
    const r = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : await r.json() };
  }
  async function register(username, email, password) {
    const r = await fetch('/api/auth/register', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    });
    return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : await r.json() };
  }
  async function resend(username, password) {
    const r = await fetch('/api/auth/resend', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  }
  // Redirect by role. Falls back to the login page.
  function redirectByRole(role, { ownerPath = '/admin', managerPath = '/manager', playerPath = '/game' } = {}) {
    if (role === 'owner') location.href = ownerPath;
    else if (role === 'manager') location.href = managerPath;
    else if (role === 'player') location.href = playerPath;
    else location.href = '/auth';
  }
  return { me, login, register, resend, logout, redirectByRole };
})();