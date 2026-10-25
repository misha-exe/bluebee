document.addEventListener('DOMContentLoaded', () => {
  const { initShell, api, el, buildPostItem } = window.Bluebee;
  initShell();

  const statToday = document.getElementById('statToday');
  const statTotal = document.getElementById('statTotal');
  const statFailed = document.getElementById('statFailed');
  const list = document.getElementById('activityList');
  const empty = document.getElementById('activityEmpty');

  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  function showMessage(text, retry = false) {
    empty.hidden = false;
    empty.textContent = text;
    if (retry) {
      const b = el('button', 'button secondary small', 'Retry');
      b.type = 'button';
      b.addEventListener('click', load);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(b);
    }
  }

  async function load() {
    try {
      // getTimezoneOffset lets the server decide what "today" means for you
      const { stats, recent } = await api(`/api/posts/summary?tz=${new Date().getTimezoneOffset()}`);
      statToday.textContent = fmt(stats.todayPublished);
      statTotal.textContent = fmt(stats.totalPublished);
      statFailed.textContent = fmt(stats.failed);

      list.replaceChildren(...recent.map((p) => buildPostItem(p)));
      if (recent.length) {
        empty.hidden = true;
      } else {
        showMessage('No posts yet. Publish a Website Card from the Composer and it will show up here.');
      }
    } catch (err) {
      showMessage(`Could not load your posts. ${err.message}`, true);
    }
  }

  load();
  // Refresh when you come back to this tab/page after posting
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) load(); });
});
