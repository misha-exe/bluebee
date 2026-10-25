// Shared helpers for the Dashboard and Posts pages.
(function () {
  let toastTimer = null;

  function initShell() {
    const open = () => document.body.classList.add('nav-open');
    const close = () => document.body.classList.remove('nav-open');
    const t = document.getElementById('menuToggle');
    const c = document.getElementById('sidebarClose');
    const o = document.getElementById('sidebarOverlay');
    if (t) t.addEventListener('click', open);
    if (c) c.addEventListener('click', close);
    if (o) o.addEventListener('click', close);
  }

  function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 5000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error(`Server status ${res.status}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Server error');
    return data;
  }

  // e.g. "Oct 23, 2026 10:05 PM" (in the viewer's own timezone)
  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `${date} ${time}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;   // textContent only: headlines/errors are never parsed as HTML
    return node;
  }

  // One history entry. detailed=false is the compact dashboard row; detailed=true adds text, URL, error, actions.
  function buildPostItem(post, { detailed = false } = {}) {
    const published = post.status === 'published';
    const li = el('li', 'activity-item');
    li.dataset.id = post.id;

    li.appendChild(el('div', `status-icon ${published ? 'published' : 'failed'}`, published ? '✓' : '!'));

    const body = el('div', 'activity-body');
    body.appendChild(el('div', 'activity-title', post.headline || 'Untitled post'));
    body.appendChild(el('div', 'activity-meta', `${post.accountLabel || 'Account'} · ${formatDate(post.createdAt)}`));

    if (detailed) {
      if (post.postText) body.appendChild(el('p', 'post-text', post.postText));
      if (post.websiteUrl) body.appendChild(el('p', 'post-url', post.websiteUrl));
      if (!published && post.error) body.appendChild(el('p', 'post-error', post.error));
    }

    const foot = el('div', 'post-foot');
    foot.appendChild(el('span', `badge ${published ? 'published' : 'failed'}`, published ? 'Published' : 'Failed'));
    if (detailed) {
      if (published && post.postUrl) {
        const a = el('a', 'post-link', 'View Post');
        a.href = post.postUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        foot.appendChild(a);
      }
      const del = el('button', 'button danger small', 'Delete');
      del.type = 'button';
      del.dataset.delete = post.id;
      del.setAttribute('aria-label', `Delete history entry: ${post.headline || 'Untitled post'}`);
      foot.appendChild(del);
    }
    body.appendChild(foot);
    li.appendChild(body);
    return li;
  }

  window.Bluebee = { initShell, showToast, api, formatDate, el, buildPostItem };
})();
