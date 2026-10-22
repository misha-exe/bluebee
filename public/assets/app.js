document.addEventListener('DOMContentLoaded', () => {
  const clientId = 'client_' + Math.random().toString(36).substring(2, 9);
  let mediaList = [];
  let selectedMediaItem = null;

  // DOM Elements
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

  // Server-Sent Events (SSE) for upload stages
  const evtSource = new EventSource(`/api/progress/${clientId}`);
  evtSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    uploadProgress.hidden = false;
    uploadProgress.value = data.percent;
    uploadStatus.textContent = data.status;
  };

  // Toast Helper
  function showToast(msg, isError = false) {
    toast.textContent = msg;
    toast.className = `toast show ${isError ? 'error' : ''}`;
    setTimeout(() => { toast.className = 'toast'; }, 4000);
  }

  // Text counters
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

  // Load Media Library
  async function loadMedia() {
    try {
      const res = await fetch('/api/media');
      mediaList = await res.json();
      renderMediaGrid();
    } catch (err) {
      console.error(err);
    }
  }

  function renderMediaGrid() {
    mediaGrid.innerHTML = '';
    mediaList.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.className = `media-card ${selectedMediaItem && selectedMediaItem.id === item.id ? 'selected' : ''}`;
      btn.innerHTML = `
        <img src="${item.thumbnail}" alt="${item.name}">
        <span class="play">▶</span>
        <span class="media-meta">
          <strong>${item.name}</strong>
          <small>${item.meta}</small>
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
        <small>${item.meta}</small>
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

  // Direct File Upload
  uploadVideoBtn.addEventListener('click', async () => {
    if (!videoFile.files[0]) {
      showToast('Select a video file to upload', true);
      return;
    }
    const formData = new FormData();
    formData.append('video', videoFile.files[0]);
    formData.append('clientId', clientId);

    uploadStatus.textContent = 'Checking video file...';
    uploadProgress.hidden = false;
    uploadProgress.value = 5;

    try {
      const res = await fetch('/api/upload-file', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      selectMedia(data.media);
      loadMedia();
      showToast('Video added to the Ads Media Library and selected');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // URL Upload
  uploadUrlBtn.addEventListener('click', async () => {
    const url = videoUrl.value.trim();
    if (!url) {
      showToast('Enter a valid video URL', true);
      return;
    }

    try {
      const res = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: url, clientId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      selectMedia(data.media);
      loadMedia();
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

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

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

  // Mobile Drawer Toggle
  if (menuToggle) menuToggle.addEventListener('click', () => document.body.classList.add('nav-open'));
  if (sidebarClose) sidebarClose.addEventListener('click', () => document.body.classList.remove('nav-open'));
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', () => document.body.classList.remove('nav-open'));
  refreshBtn.addEventListener('click', loadMedia);

  loadMedia();
});