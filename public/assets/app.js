document.addEventListener('DOMContentLoaded', () => {
  let mediaList = [];
  let selectedMediaItem = null;

  const postText = document.getElementById('postText');
  const postCount = document.getElementById('postCount');
  const headline = document.getElementById('headline');
  const headlineCount = document.getElementById('headlineCount');
  const websiteUrl = document.getElementById('websiteUrl');
  const websiteUrlError = document.getElementById('websiteUrlError');
  const selectedMediaContainer = document.getElementById('selectedMedia');
  const selectedCount = document.getElementById('selectedCount');
  const publishBtn = document.getElementById('publishBtn');

  const uploadProgress = document.getElementById('uploadProgress');
  const uploadStatus = document.getElementById('uploadStatus');
  const videoFile = document.getElementById('videoFile');
  const uploadVideoBtn = document.getElementById('uploadVideoBtn');
  const videoUrl = document.getElementById('videoUrl');
  const uploadUrlBtn = document.getElementById('uploadUrlBtn');
  const mediaGrid = document.getElementById('mediaGrid');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const accountSelect = document.getElementById('accountSelect');
  // NOTE: mediaSearch / searchBtn are intentionally never locked.

  let uploading = false;
  let toastTimer = null;

  const toast = document.getElementById('toast');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarClose = document.getElementById('sidebarClose');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  // Load from local database cache first
  try {
    const cached = localStorage.getItem('share2x_db_media');
    if (cached) {
      mediaList = JSON.parse(cached);
      renderMediaGrid();
    }
  } catch {}

  async function parseResponse(res) {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      return data;
    }
    const htmlText = await res.text();
    throw new Error(`Server status ${res.status}: ${htmlText.replace(/<[^>]*>/g, '').trim().substring(0, 100)}`);
  }

  // ---- Upload progress ----
  // The bar is shown the instant an upload starts (so it never depends on the server), then fed by polling the
  // server's progress record. A fresh id per upload means a previous upload's "100%" can never leak into the next.
  const defaultStatus = uploadStatus.textContent;
  let shownPercent = 0;
  let hideTimer = null;

  const newUploadId = () => 'up_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

  function startProgress() {
    clearTimeout(hideTimer);
    shownPercent = 0;
    uploadProgress.removeAttribute('value');   // no value = animated "working…" bar until real numbers arrive
    uploadProgress.hidden = false;
    uploadStatus.textContent = 'Starting upload…';
  }

  function applyProgress(status, percent) {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < shownPercent) return;   // never move backwards (stale or out-of-order update)
    shownPercent = pct;
    uploadProgress.hidden = false;
    uploadProgress.value = pct;
    if (status) uploadStatus.textContent = status;
  }

  function finishProgress(success) {
    clearTimeout(hideTimer);
    if (success) {
      applyProgress('Video added to the Ads Media Library and selected', 100);
      hideTimer = setTimeout(resetProgress, 1500);   // let the 100% register before the bar goes away
    } else {
      resetProgress();
    }
  }

  function resetProgress() {
    uploadProgress.hidden = true;
    uploadProgress.value = 0;
    uploadStatus.textContent = defaultStatus;
    shownPercent = 0;
  }

  function pollProgress(uploadId) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/upload-progress/${encodeURIComponent(uploadId)}`, { cache: 'no-store' });
        if (res.ok && !stopped) {
          const d = await res.json();
          if (d && d.status) applyProgress(d.status, d.percent);
        }
      } catch { /* a missed poll is harmless; the next one catches up */ }
      if (!stopped) timer = setTimeout(tick, 700);
    };
    timer = setTimeout(tick, 400);
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  // link (optional): { href, text }. Built with DOM nodes, never innerHTML, so nothing is injected.
  function showToast(msg, isError = false, link = null) {
    toast.textContent = msg;
    if (link && link.href) {
      toast.appendChild(document.createTextNode(' '));
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text || 'View Post';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      toast.appendChild(a);
    }
    toast.className = `toast show ${isError ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, link ? 10000 : 5000);
  }

  // Disable everything except the search bar while a video is uploading (prevents conflicting operations).
  function setUploading(flag) {
    uploading = flag;
    [accountSelect, postText, websiteUrl, headline, videoFile, uploadVideoBtn, videoUrl, uploadUrlBtn, refreshBtn, loadMoreBtn]
      .forEach((el) => { if (el) el.disabled = flag; });
    const clearBtn = document.getElementById('clearSelected');
    if (clearBtn) clearBtn.disabled = flag;
    mediaGrid.querySelectorAll('button').forEach((b) => { b.disabled = flag; });
    document.body.classList.toggle('is-uploading', flag);
    validateForm();
  }

  postText.addEventListener('input', () => {
    postCount.textContent = `${postText.value.length}/280`;
    validateForm();
  });

  headline.addEventListener('input', () => {
    headlineCount.textContent = `${headline.value.length}/70`;
    validateForm();
  });

  // ---- Website URL validation ----
  // Can be published: http(s):// followed by a host.
  const isPublishableUrl = (v) => /^https?:\/\/[^\s/?#]+/i.test(v);
  // Show the error as soon as the text can no longer become an http(s):// URL. Text that is still a
  // prefix of "http://" or "https://" (e.g. "ht", "https:") is mid-typing, so it doesn't flash red.
  function urlNeedsError(v) {
    if (!v || /^https?:\/\//i.test(v)) return false;
    const lower = v.toLowerCase();
    return !['http://', 'https://'].some((p) => p.startsWith(lower));
  }
  function updateUrlError() {
    const show = urlNeedsError(websiteUrl.value.trim());
    websiteUrlError.hidden = !show;
    websiteUrl.classList.toggle('invalid', show);
    websiteUrl.setAttribute('aria-invalid', show ? 'true' : 'false');
  }
  websiteUrl.addEventListener('input', () => { updateUrlError(); validateForm(); });

  function validateForm() {
    const isValid = isPublishableUrl(websiteUrl.value.trim()) && headline.value.trim() && selectedMediaItem;
    publishBtn.disabled = uploading || !isValid;
  }

  async function loadMedia() {
    try {
      const res = await fetch('/api/media');
      const serverMedia = await parseResponse(res);
      
      // Merge server media with local items, avoiding duplicates
      const seen = new Set();
      const merged = [];

      [...mediaList, ...serverMedia].forEach(item => {
        if (!seen.has(item.mediaId)) {
          seen.add(item.mediaId);
          merged.push(item);
        }
      });

      mediaList = merged;
      localStorage.setItem('share2x_db_media', JSON.stringify(mediaList));
      renderMediaGrid();
    } catch (err) {
      console.warn('Could not sync media from backend:', err.message);
    }
  }

  function renderMediaGrid() {
    mediaGrid.innerHTML = '';
    mediaList.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.className = `media-card ${selectedMediaItem && selectedMediaItem.mediaId === item.mediaId ? 'selected' : ''}`;
      btn.setAttribute('data-i', item.id || index);
      btn.disabled = uploading;
      btn.innerHTML = `
        <img src="${item.thumbnail}" alt="${item.name}">
        <span class="play">▶</span>
        <span class="media-meta">
          <strong>${item.name}</strong>
          <small>${item.meta || 'Square · 800x800'}</small>
        </span>
      `;
      btn.addEventListener('click', () => selectMedia(item));
      mediaGrid.appendChild(btn);
    });
  }

  function selectMedia(item) {
    selectedMediaItem = item;
    selectedCount.textContent = '1 selected';
    selectedMediaContainer.innerHTML = `
      <img src="${item.thumbnail}" alt="${item.name}">
      <div>
        <strong>${item.name}</strong>
        <small>${item.meta || 'Square · 800x800'}</small>
      </div>
      <button type="button" id="clearSelected">×</button>
    `;

    document.getElementById('clearSelected').disabled = uploading;
    document.getElementById('clearSelected').addEventListener('click', (e) => {
      e.stopPropagation();
      selectedMediaItem = null;
      selectedCount.textContent = 'None selected';
      selectedMediaContainer.innerHTML = '<p>Select one compatible square video.</p>';
      renderMediaGrid();
      validateForm();
    });

    renderMediaGrid();
    validateForm();
  }

  // Shared upload flow: lock the form, upload, then (in one step) clear the source field,
  // unlock the form and show the success popup.
  async function runUpload(uploadId, doRequest) {
    if (uploading) return;
    setUploading(true);
    startProgress();
    const poller = pollProgress(uploadId);
    try {
      const data = await doRequest();

      mediaList.unshift(data.media);
      localStorage.setItem('share2x_db_media', JSON.stringify(mediaList));
      renderMediaGrid();
      selectMedia(data.media);

      poller.stop();
      finishProgress(true);
      videoUrl.value = '';
      videoFile.value = '';
      setUploading(false);
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      // On failure keep the URL/file so it can be retried, but unlock the form.
      poller.stop();
      finishProgress(false);
      setUploading(false);
      showToast(err.message, true);
    }
  }

  // URL Upload
  uploadUrlBtn.addEventListener('click', () => {
    const url = videoUrl.value.trim();
    if (!url) return showToast('Enter a valid video URL', true);

    const uploadId = newUploadId();
    runUpload(uploadId, async () => {
      const res = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url, clientId: uploadId })
      });
      return parseResponse(res);
    });
  });

  // Direct File Upload
  uploadVideoBtn.addEventListener('click', () => {
    const file = videoFile.files[0];
    if (!file) return showToast('Select a video file to upload', true);

    const uploadId = newUploadId();
    const formData = new FormData();
    formData.append('clientId', uploadId);   // before the file, so the server can read it as soon as the form starts arriving
    formData.append('video', file);

    runUpload(uploadId, async () => {
      const res = await fetch('/api/upload-file', { method: 'POST', body: formData });
      return parseResponse(res);
    });
  });

  // Publish
  publishBtn.addEventListener('click', async () => {
    publishBtn.disabled = true;
    publishBtn.textContent = 'Posting...';

    try {
      const res = await fetch('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postText: postText.value,
          websiteUrl: websiteUrl.value,
          headline: headline.value,
          mediaId: selectedMediaItem.mediaId,
          accountLabel: (accountSelect.selectedOptions[0]?.textContent || '').split('·')[0].trim()
        })
      });

      const data = await parseResponse(res);
      const link = data.postUrl ? { href: data.postUrl, text: 'View Post' } : null;
      showToast(data.message || 'Website Card posted successfully!', false, link);

      // Clear ONLY the post text and the selected media. Headline and website URL stay for the next post.
      postText.value = '';
      postCount.textContent = '0/280';
      selectedMediaItem = null;
      selectedCount.textContent = 'None selected';
      selectedMediaContainer.innerHTML = '<p>Select one compatible square video.</p>';
      renderMediaGrid();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      publishBtn.disabled = false;
      publishBtn.textContent = 'Post Website Card';
      validateForm();
    }
  });

  if (menuToggle) menuToggle.addEventListener('click', () => document.body.classList.add('nav-open'));
  if (sidebarClose) sidebarClose.addEventListener('click', () => document.body.classList.remove('nav-open'));
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', () => document.body.classList.remove('nav-open'));
  refreshBtn.addEventListener('click', loadMedia);

  loadMedia();
});
