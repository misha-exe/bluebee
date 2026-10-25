document.addEventListener('DOMContentLoaded', () => {
  const clientId = 'client_' + Math.random().toString(36).substring(2, 9);
  let mediaList = [];
  let selectedMediaItem = null;

  const postText = document.getElementById('postText');
  const postCount = document.getElementById('postCount');
  const headline = document.getElementById('headline');
  const headlineCount = document.getElementById('headlineCount');
  const websiteUrl = document.getElementById('websiteUrl');
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

  // SSE setup
  const evtSource = new EventSource(`/api/progress/${clientId}`);
  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      uploadProgress.hidden = false;
      uploadProgress.value = data.percent;
      uploadStatus.textContent = data.status;
    } catch {}
  };

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

  websiteUrl.addEventListener('input', validateForm);

  function validateForm() {
    const isValid = websiteUrl.value.trim() && headline.value.trim() && selectedMediaItem;
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
  async function runUpload(doRequest) {
    if (uploading) return;
    setUploading(true);
    try {
      const data = await doRequest();

      mediaList.unshift(data.media);
      localStorage.setItem('share2x_db_media', JSON.stringify(mediaList));
      renderMediaGrid();
      selectMedia(data.media);

      videoUrl.value = '';
      videoFile.value = '';
      setUploading(false);
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      // On failure keep the URL/file so it can be retried, but unlock the form.
      setUploading(false);
      showToast(err.message, true);
    }
  }

  // URL Upload
  uploadUrlBtn.addEventListener('click', () => {
    const url = videoUrl.value.trim();
    if (!url) return showToast('Enter a valid video URL', true);

    runUpload(async () => {
      const res = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url, clientId })
      });
      return parseResponse(res);
    });
  });

  // Direct File Upload
  uploadVideoBtn.addEventListener('click', () => {
    const file = videoFile.files[0];
    if (!file) return showToast('Select a video file to upload', true);

    const formData = new FormData();
    formData.append('video', file);
    formData.append('clientId', clientId);

    uploadStatus.textContent = 'Preparing upload...';
    uploadProgress.hidden = false;
    uploadProgress.value = 5;

    runUpload(async () => {
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
          mediaId: selectedMediaItem.mediaId
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
