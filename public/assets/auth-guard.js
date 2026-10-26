// Loaded in <head> of every protected page. It:
//  - hides the page until the server confirms there is a valid session (no flash of private content)
//  - sends you to /login.html if the session is missing or has timed out (idle OR absolute limit)
//  - keeps the session alive while you are actually using the page
//  - wires up the sidebar "Log out" link
// The real protection is server-side (every /api route checks the signed cookie); this is the user-facing half.
(function () {
  const root = document.documentElement;
  root.classList.add('auth-pending');   // paired with an inline <style> in each page's <head>

  const nativeFetch = window.fetch.bind(window);
  let leaving = false;
  let expiryTimer = null;
  let lastPing = Date.now();
  let pingEvery = 4 * 60 * 1000;

  function goLogin(reason) {
    if (leaving) return;
    leaving = true;
    location.replace('/login.html' + (reason ? `?reason=${reason}` : ''));
  }

  // The server tells us how much session is left on every response; sign out locally the moment it runs out.
  function arm(ms) {
    clearTimeout(expiryTimer);
    if (!Number.isFinite(ms)) return;
    pingEvery = Math.max(1000, Math.min(4 * 60 * 1000, ms / 3));
    expiryTimer = setTimeout(() => goLogin('expired'), Math.max(ms, 0) + 1500);
  }

  function noteResponse(res) {
    const left = Number(res.headers.get('X-Session-Remaining-Ms'));
    if (res.headers.has('X-Session-Remaining-Ms') && Number.isFinite(left)) arm(left);
  }

  async function verify() {
    try {
      const res = await nativeFetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
      if (res.status === 401) {
        const body = await res.json().catch(() => ({}));
        return goLogin(body.code === 'expired' ? 'expired' : '');
      }
      noteResponse(res);
    } catch (err) {
      // Offline or server hiccup: don't lock the page; the API calls will report their own errors.
    }
    root.classList.remove('auth-pending');
  }

  // Any app request that comes back 401 means the session is gone.
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== -1) {
      if (res.status === 401) goLogin('expired');
      else noteResponse(res);
    }
    return res;
  };

  // Real activity (typing, tapping, scrolling) counts as "not idle".
  function onActivity() {
    const now = Date.now();
    if (leaving || now - lastPing < pingEvery) return;
    lastPing = now;
    nativeFetch('/api/session/touch', { method: 'POST', credentials: 'same-origin' })
      .then((res) => (res.status === 401 ? goLogin('expired') : noteResponse(res)))
      .catch(() => {});
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((ev) =>
    window.addEventListener(ev, onActivity, { passive: true, capture: true })
  );

  // Coming back to a sleeping tab, or pressing Back after logging out: re-check immediately.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verify(); });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      root.classList.add('auth-pending');
      verify();
    }
  });

  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('#logoutLink');
    if (!link) return;
    e.preventDefault();
    leaving = true;
    nativeFetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(() => {})
      .finally(() => location.replace('/login.html?reason=loggedout'));
  });

  verify();
})();
