/* admin.js — owner panel SPA. */
'use strict';
(function () {
  let allUsers = [];
  let meObj = null;

  const el = id => document.getElementById(id);
  const toast = (msg) => { const t = el('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); };

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function fmt(n) { return Number(n || 0).toLocaleString(); }
  function when(d) { return d ? new Date(d).toLocaleString() : '—'; }

  async function load() {
    try {
      meObj = await Auth.me();
      if (!meObj || meObj.role !== 'owner') { location.href = '/auth'; return; }
      el('me-name').textContent = meObj.username;
      const [users, stats, settings] = await Promise.all([
        api('/api/admin/users'), api('/api/admin/stats'), api('/api/admin/settings'),
      ]);
      allUsers = users;
      renderUsers();
      renderStats(stats);
      if (settings.rtp) { el('rtp').value = settings.rtp; el('rtp-val').textContent = (+settings.rtp).toFixed(2); el('edge').textContent = Math.round((1 - (+settings.rtp)) * 100) + '%'; }
      if (settings.bullet_factor) { el('bf').value = settings.bullet_factor; el('bf-val').textContent = (+settings.bullet_factor).toFixed(1); }
    } catch (e) { toast(e.message); }
  }

  function renderStats(s) {
    el('stats').innerHTML = `
      <div class="stat"><div class="stat-num">${s.users}</div><div class="stat-lbl">Users</div></div>
      <div class="stat"><div class="stat-num">${fmt(s.inCirculation)}</div><div class="stat-lbl">Points in circulation</div></div>
      <div class="stat"><div class="stat-num">${fmt(s.totalWagered)}</div><div class="stat-lbl">Total wagered</div></div>
      <div class="stat"><div class="stat-num">${fmt(s.totalPaid)}</div><div class="stat-lbl">Total paid out</div></div>
      <div class="stat"><div class="stat-num">${fmt(s.houseProfit)}</div><div class="stat-lbl">House profit</div></div>`;
  }

  function renderUsers() {
    const q = el('search').value.trim().toLowerCase();
    const rows = allUsers.filter(u => !q || u.username.toLowerCase().includes(q));
    const tb = el('users-tbl').querySelector('tbody');
    tb.innerHTML = rows.map(u => `
      <tr>
        <td>${u.id}</td>
        <td><b>${u.username}</b></td>
        <td>${roleBadge(u.role)}</td>
        <td class="mono">${fmt(u.points)}</td>
        <td>${u.manager || '—'}</td>
        <td>${u.banned ? '<span class="ban">BANNED</span>' : '<span class="ok">active</span>'}</td>
        <td>${new Date(u.createdAt).toLocaleDateString()}</td>
        <td>${when(u.lastLogin)}</td>
        <td class="actions">${actionButtons(u)}</td>
      </tr>`).join('');
  }

  function roleBadge(role) { return role === 'owner' ? '<span class="role owner">OWNER</span>' : role === 'manager' ? '<span class="role manager">MANAGER</span>' : '<span class="role player">player</span>'; }
  function actionButtons(u) {
    if (u.role === 'owner') return '—';
    let btns = `<button class="btn mini" onclick="Admin.points(${u.id},'${u.username}')">± Points</button> `;
    btns += u.role === 'manager'
      ? `<button class="btn mini" onclick="Admin.role(${u.id},'player')">Remove manager</button> `
      : `<button class="btn mini" onclick="Admin.role(${u.id},'manager')">Make manager</button> `;
    btns += u.banned
      ? `<button class="btn mini" onclick="Admin.ban(${u.id},false)">Unban</button>`
      : `<button class="btn mini danger" onclick="Admin.ban(${u.id},true)">Ban</button>`;
    return btns;
  }

  const mod = {
    points(id, name) {
      modal(`Grant/deduct points — ${name}`, `
        <input id="m-amount" type="number" placeholder="amount (use negative to deduct)" style="width:60%">
        <input id="m-note" type="text" placeholder="note (optional)" style="width:100%;margin-top:8px">
        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button class="btn ghost" onclick="Admin.closeModal()">Cancel</button>
          <button class="btn primary" onclick="Admin.savePoints(${id})">Save</button>
        </div>`);
    },
    async savePoints(id) {
      const amount = parseInt(el('m-amount').value, 10);
      const note = el('m-note').value.trim() || null;
      if (!Number.isFinite(amount) || amount === 0) { toast('enter a non-zero amount'); return; }
      try { await api('/api/admin/users/' + id + '/points', { method: 'POST', body: JSON.stringify({ amount, note }) }); toast('Points updated'); closeModal(); await load(); }
      catch (e) { toast(e.message); }
    },
    async role(id, role) {
      try { await api('/api/admin/users/' + id + '/role', { method: 'POST', body: JSON.stringify({ role }) }); toast(role === 'manager' ? 'Promoted to manager' : 'Demoted to player'); await load(); }
      catch (e) { toast(e.message); }
    },
    async ban(id, banned) {
      try { await api('/api/admin/users/' + id + '/ban', { method: 'POST', body: JSON.stringify({ banned }) }); toast(banned ? 'User banned' : 'User unbanned'); await load(); }
      catch (e) { toast(e.message); }
    },
    closeModal() { el('modal').classList.add('hidden'); },
  };
  window.Admin = mod;

  function modal(title, body) { el('modal-title').textContent = title; el('modal-body').innerHTML = body; el('modal').classList.remove('hidden'); }

  el('search').addEventListener('input', renderUsers);
  el('rtp').addEventListener('input', e => { const v = e.target.value; el('rtp-val').textContent = (+v).toFixed(2); el('edge').textContent = Math.round((1 - (+v)) * 100) + '%'; });
  el('btn-rtp').addEventListener('click', async () => {
    try { await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ key: 'rtp', value: el('rtp').value }) }); toast('RTP saved — applies to all players within seconds'); }
    catch (e) { toast(e.message); }
  });
  el('bf').addEventListener('input', e => el('bf-val').textContent = (+e.target.value).toFixed(1));
  el('btn-bf').addEventListener('click', async () => {
    try { await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ key: 'bullet_factor', value: el('bf').value }) }); toast('Bullet factor saved'); }
    catch (e) { toast(e.message); }
  });
  el('btn-logout').addEventListener('click', async () => { await Auth.logout(); location.href = '/auth'; });

  load();
  setInterval(load, 12000);
})();