(function () {
  const form = document.getElementById('loginForm');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const toggle = document.getElementById('passwordToggle');
  const submitBtn = document.getElementById('submitBtn');
  const errorBox = document.getElementById('authError');
  const notice = document.getElementById('authNotice');

  // Why the user landed here
  const NOTICES = {
    expired: 'Your session expired. Please sign in again.',
    loggedout: 'You have been signed out.'
  };
  const reason = new URLSearchParams(location.search).get('reason');
  if (NOTICES[reason]) {
    notice.textContent = NOTICES[reason];
    notice.hidden = false;
  }

  // Already signed in? Go straight to the composer.
  fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' })
    .then((res) => { if (res.ok) location.replace('/'); })
    .catch(() => {});

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.setAttribute('aria-pressed', String(show));
    password.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;

    if (!email.value.trim() || !password.value) {
      return showError('Enter your email and password.');
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    let redirecting = false;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email.value.trim(), password: password.value })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        redirecting = true;
        location.replace(data.redirect || '/');
        return;
      }
      showError(data.error || 'Could not sign in. Please try again.');
      password.value = '';
      password.focus();
    } catch (err) {
      showError('Could not reach the server. Check your connection and try again.');
    } finally {
      if (!redirecting) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign in';
      }
    }
  });
})();
