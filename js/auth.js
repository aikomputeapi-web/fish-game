/* Reef Fortune — Supabase auth + profile balance sync.
   Depends on config.js and the Supabase JS v2 CDN. */
'use strict';

const sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
window.sbClient = sbClient;

// ---- modal --------------------------------------------------------------
const modal = document.getElementById('auth-modal');
const authMsg = document.getElementById('auth-msg');

function emailVal() { return document.getElementById('auth-email').value.trim(); }
function pwdVal()  { return document.getElementById('auth-pwd').value; }

// ---- tab state (login vs signup) ----------------------------------------
let authMode = 'login';
const tabLogin  = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const submitBtn = document.getElementById('auth-submit');
const subText   = document.getElementById('auth-sub');

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  tabLogin.classList.toggle('on', isLogin);
  tabSignup.classList.toggle('on', !isLogin);
  submitBtn.textContent = isLogin ? 'LOG IN' : 'CREATE ACCOUNT';
  subText.textContent = isLogin
    ? 'Welcome back — sign in to keep your coin balance.'
    : 'New here? Create an account to save your progress.';
  authMsg.textContent = '';
}
tabLogin.addEventListener('click', () => setAuthMode('login'));
tabSignup.addEventListener('click', () => setAuthMode('signup'));
setAuthMode('login');

async function auth(email, password, mode) {
  authMsg.textContent = '';
  try {
    const res = mode === 'signup'
      ? await sbClient.auth.signUp({ email, password })
      : await sbClient.auth.signInWithPassword({ email, password });
    if (res.error) throw res.error;
    if (res.data.session) { onAuth(res.data.user); return; }
    authMsg.textContent = 'Check your email to confirm your account.';
  } catch (e) {
    authMsg.textContent = e.message || String(e);
  }
}

submitBtn.addEventListener('click', () => auth(emailVal(), pwdVal(), authMode));
document.getElementById('auth-pwd').addEventListener('keydown', e => {
  if (e.key === 'Enter') auth(emailVal(), pwdVal(), authMode);
});

// ---- main auth state handler -------------------------------------------
async function onAuth(user) {
  window._authReady = true;
  modal.classList.add('hidden');
  document.getElementById('auth-user').textContent = user.email;
  document.getElementById('auth-bar').classList.remove('hidden');
  await loadBalanceFromServer();
  refreshHUD();
  startResync();
}

// expose logout to the topbar button
async function logout() {
  stopResync();
  window._authReady = false;
  await sbClient.auth.signOut();
  document.getElementById('auth-bar').classList.add('hidden');
  modal.classList.remove('hidden');
  state.balance = 2000;
  state.totalWin = 0;
  refreshHUD();
}
document.getElementById('auth-logout').addEventListener('click', logout);
window._logout = logout;

// bootstrap from any existing session
(async () => {
  const { data } = await sbClient.auth.getSession();
  if (data.session) onAuth(data.user);
  else modal.classList.remove('hidden');
})();

sbClient.auth.onAuthStateChange((_e, session) => {
  if (session && session.user) onAuth(session.user);
});

// ---- balance sync (server is the source of truth) ----------------------

// fetch profile row -> set state.balance / state.totalWin
window.loadBalanceFromServer = async function loadBalanceFromServer() {
  const { data: { user } } = await sbClient.auth.getUser();
  if (!user) return;
  const { data, error } = await sbClient
    .from('profiles')
    .select('balance,total_win')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error || !data) return;
  if (typeof state !== 'undefined') {
    state.balance = Number(data.balance);
    state.totalWin = Number(data.total_win);
    refreshHUD();
  }
};

// debit on fire: returns true if server accepted (enough balance)
window.debitServer = async function debitServer(amount) {
  const { data, error } = await sbClient.rpc('debit_balance', { amt: amount });
  if (error) return false;
  if (data === null) { // insufficient on server — resync and bail
    await loadBalanceFromServer();
    return false;
  }
  state.balance = Number(data);
  refreshHUD();
  return true;
};

// credit on kill (with total_win accumulator)
window.creditServer = async function creditServer(amount) {
  const { data, error } = await sbClient.rpc('credit_balance', { amt: amount });
  if (error) return;
  if (data !== null) {
    state.balance = Number(data);
    refreshHUD();
  }
};

// +1000 free coins (top-up)
window.grantServer = async function grantServer(amount) {
  const { data, error } = await sbClient.rpc('grant_balance', { amt: amount });
  if (error) return;
  if (data !== null) {
    state.balance = Number(data);
    refreshHUD();
  }
};

// ---- periodic resync (catches multi-tab drift / cheating) ---------------
let resyncTimer = null;
function startResync() {
  stopResync();
  resyncTimer = setInterval(loadBalanceFromServer, 10000);
}
function stopResync() { if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; } }

// pause sync when tab is hidden (saves requests)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopResync();
  else if (window._authReady) startResync();
});