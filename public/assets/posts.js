document.addEventListener('DOMContentLoaded', () => {
  const { initShell, api, showToast, el, buildPostItem } = window.Bluebee;
  initShell();

  const list = document.getElementById('postsList');
  const empty = document.getElementById('postsEmpty');
  const subtitle = document.getElementById('postsSubtitle');
  const deleteAllBtn = document.getElementById('deleteAllBtn');
  const modal = document.getElementById('confirmModal');
  const confirmText = document.getElementById('confirmText');
  const confirmOk = document.getElementById('confirmOk');
  const confirmCancel = document.getElementById('confirmCancel');

  let count = 0;

  function refreshChrome() {
    deleteAllBtn.disabled = count === 0;
    subtitle.textContent = count
      ? `${count.toLocaleString('en-US')} ${count === 1 ? 'post' : 'posts'} in your history, newest first.`
      : 'Every Website Card post you have tried, published or failed.';
    if (count === 0) {
      empty.hidden = false;
      empty.textContent = 'No post history. Publish a Website Card from the Composer and it will show up here.';
    } else {
      empty.hidden = true;
    }
  }

  async function load() {
    try {
      const { posts } = await api('/api/posts');
      count = posts.length;
      list.replaceChildren(...posts.map((p) => buildPostItem(p, { detailed: true })));
      refreshChrome();
    } catch (err) {
      empty.hidden = false;
      empty.textContent = `Could not load your posts. ${err.message}`;
      const b = el('button', 'button secondary small', 'Retry');
      b.type = 'button';
      b.addEventListener('click', load);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(b);
    }
  }

  // ---- delete one ----
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-delete]');
    if (!btn) return;
    btn.disabled = true;
    try {
      await api(`/api/posts/${encodeURIComponent(btn.dataset.delete)}`, { method: 'DELETE' });
      btn.closest('li').remove();
      count -= 1;
      refreshChrome();
      showToast('History entry deleted');
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, true);
    }
  });

  // ---- delete all (with confirmation) ----
  function openModal() {
    confirmText.textContent =
      `This removes all ${count.toLocaleString('en-US')} ${count === 1 ? 'entry' : 'entries'} from Bluebee’s history and resets your dashboard numbers. ` +
      'Posts already on X are not deleted.';
    modal.hidden = false;
    confirmCancel.focus();
  }
  function closeModal() { modal.hidden = true; deleteAllBtn.focus(); }

  deleteAllBtn.addEventListener('click', openModal);
  confirmCancel.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  confirmOk.addEventListener('click', async () => {
    confirmOk.disabled = true;
    try {
      const { deleted } = await api('/api/posts', { method: 'DELETE' });
      list.replaceChildren();
      count = 0;
      refreshChrome();
      modal.hidden = true;
      showToast(`Deleted ${deleted.toLocaleString('en-US')} ${deleted === 1 ? 'entry' : 'entries'} from history`);
    } catch (err) {
      showToast(err.message, true);
    } finally {
      confirmOk.disabled = false;
    }
  });

  load();
});
