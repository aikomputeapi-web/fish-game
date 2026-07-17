/* manager.js — manager dashboard SPA. */
'use strict';
(function () {
  const el = id => document.getElementById(id);
  const toast = (msg) => { const t = el('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2400); };
  const fmt = n => Number(n || 0).toLocaleString();
  const when = d => d ? new Date(d).toLocaleString() : '—';
  let meObj = null;

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  async function load() {
    try {
      meObj = await Auth.me();
      if (!meObj || meObj.role !== 'manager') { location.href = '/auth'; return; }
      el('me-name').textContent = meObj.username;
      const [ov, players, requests, history] = await Promise.all([
        api('/api/manager/overview'), api('/api/manager/players'), api('/api/manager/requests'), api('/api/manager/history'),
      ]);
      el('me-balance').textContent = fmt(ov.points);
      el('req-count').textContent = ov.pendingRequests;
      renderRequests(requests);
      renderPlayers(players);
      renderHistory(history);
    } catch (e) { toast(e.message); }
  }

  function renderRequests(reqs) {
    const box = el('requests');
    if (!reqs || reqs.length === 0) { box.innerHTML = '<p class="muted small">No requests.</p>'; return; }
    box.innerHTML = reqs.map(r => `
      <div class="req-row ${r.status}">
        <div><b>${r.username}</b> wants <span class="mono">${fmt(r.amount)}</span></div>
        <div class="muted small">${when(r.createdAt)} · ${r.status}</div>
        ${r.status === 'pending' ? `
          <div class="row" style="margin-top:4px">
            <button class="btn mini primary" onclick="Mgr.resolve(${r.id},'approve')">Approve</button>
            <button class="btn mini ghost" onclick="Mgr.resolve(${r.id},'reject')">Reject</button>
          </div>` : ''}
      </div>`).join('');
  }

  function renderPlayers(players) {
    const tb = el('players-tbl').querySelector('tbody');
    tb.innerHTML = players.map(p => `
      <tr>
        <td><b>${p.username}</b></td>
        <td class="mono">${fmt(p.points)}</td>
        <td class="mono">${fmt(p.wagered)}</td>
        <td class="mono">${fmt(p.won)}</td>
        <td>${p.banned ? '<span class="ban">BANNED</span>' : '<span class="ok">active</span>'}</td>
      </tr>`).join('');
  }

  function renderHistory(hist) {
    const tb = el('hist-tbl').querySelector('tbody');
    tb.innerHTML = hist.map(h => `
      <tr>
        <td>${h.type === 'manager_grant' ? (h.amount < 0 ? 'grant out' : 'received') : (h.amount > 0 ? 'redeemed in' : 'redeemed out')}</td>
        <td class="mono ${h.amount < 0 ? 'neg' : 'pos'}">${h.amount > 0 ? '+' : ''}${fmt(h.amount)}</td>
        <td class="muted small">${new Date(h.createdAt).toLocaleString()}</td>
      </tr>`).join('');
  }

  window.Mgr = {
    async resolve(id, action) {
      try { await api(`/api/manager/requests/${id}/${action}`, { method: 'POST' }); toast(action === 'approve' ? 'Approved — points returned' : 'Rejected'); await load(); }
      catch (e) { toast(e.message); }
    },
  };

  el('btn-grant').addEventListener('click', async () => {
    const username = el('g-username').value.trim();
    const amount = parseInt(el('g-amount').value, 10);
    const note = el('g-note').value.trim() || null;
    if (!username || !Number.isFinite(amount) || amount <= 0) { toast('enter username and a positive amount'); return; }
    try {
      const r = await api('/api/manager/grant', { method: 'POST', body: JSON.stringify({ username, amount, note }) });
      toast(`Granted ${fmt(amount)} to ${r.player.username}`);
      el('g-username').value = ''; el('g-amount').value = ''; el('g-note').value = '';
      await load();
    } catch (e) { toast(e.message); }
  });
  el('btn-logout').addEventListener('click', async () => { await Auth.logout(); location.href = '/auth'; });

  load();
  setInterval(load, 10000);
})();