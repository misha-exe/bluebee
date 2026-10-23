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

  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    setTimeout(() => { toast.className = 'toast'; }, 5000);
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
    publishBtn.disabled = !isValid;
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

  // URL Upload
  uploadUrlBtn.addEventListener('click', async () => {
    const url = videoUrl.value.trim();
    if (!url) return showToast('Enter a valid video URL', true);

    try {
      const res = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url, clientId })
      });
      const data = await parseResponse(res);

      // Prepend newly uploaded item directly to memory and local storage
      mediaList.unshift(data.media);
      localStorage.setItem('share2x_db_media', JSON.stringify(mediaList));
      renderMediaGrid();

      // Auto-select the newly added video
      selectMedia(data.media);
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Direct File Upload
  uploadVideoBtn.addEventListener('click', async () => {
    if (!videoFile.files[0]) return showToast('Select a video file to upload', true);

    const formData = new FormData();
    formData.append('video', videoFile.files[0]);
    formData.append('clientId', clientId);

    uploadStatus.textContent = 'Preparing upload...';
    uploadProgress.hidden = false;
    uploadProgress.value = 5;

    try {
      const res = await fetch('/api/upload-file', { method: 'POST', body: formData });
      const data = await parseResponse(res);

      mediaList.unshift(data.media);
      localStorage.setItem('share2x_db_media', JSON.stringify(mediaList));
      renderMediaGrid();

      selectMedia(data.media);
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      showToast(err.message, true);
    }
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
      showToast(data.message || 'Website Card posted successfully!');
      postText.value = '';
      headline.value = '';
      postCount.textContent = '0/280';
      headlineCount.textContent = '0/70';
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