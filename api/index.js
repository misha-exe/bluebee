require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const { TMP_DIR, downloadVideo, makeSquare800, generateThumbnail } = require('../services/videoProcessor');
const TwitterClient = require('../services/twitterClient');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer stores incoming files in /tmp
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 4.5 * 1024 * 1024 } // Vercel limit for direct uploads
});

const mediaLibrary = [
  {
    id: "media_default",
    mediaId: "2104707817047224320",
    name: "59X2ZM5n0k8CFp5f.mp4",
    thumbnail: "https://pbs.twimg.com/amplify_video_thumb/2104707817047224320/img/Sk3kHH4uHdI8y-EU.jpg",
    meta: "Square · 800x800"
  }
];

const progressClients = {};

// SSE Route
app.get('/api/progress/:clientId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = req.params.clientId;
  progressClients[clientId] = res;

  req.on('close', () => {
    delete progressClients[clientId];
  });
});

function sendProgress(clientId, status, percent = 0) {
  if (progressClients[clientId]) {
    progressClients[clientId].write(`data: ${JSON.stringify({ status, percent })}\n\n`);
  }
}

// URL Upload Route (Best for Vercel)
app.post('/api/upload-url', async (req, res) => {
  const { videoUrl, clientId } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'Missing video URL' });

  const rawPath = path.join(TMP_DIR, `raw-${Date.now()}.mp4`);
  const squarePath = path.join(TMP_DIR, `square-${Date.now()}.mp4`);
  const thumbPath = path.join(TMP_DIR, `thumb-${Date.now()}.jpg`);

  try {
    sendProgress(clientId, 'Downloading video from URL', 0);
    await downloadVideo(videoUrl, rawPath, (pct) => {
      sendProgress(clientId, 'Downloading video from URL', pct);
    });

    sendProgress(clientId, 'Downloading complete', 100);

    sendProgress(clientId, 'Preparing an 800x800 website card without cropping', 15);
    await makeSquare800(rawPath, squarePath);
    await generateThumbnail(squarePath, thumbPath);

    sendProgress(clientId, 'Square video is ready. Starting X upload.', 35);

    const authToken = process.env.TWITTER_AUTH_TOKEN;
    const ct0 = process.env.TWITTER_CT0;
    const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID || '37';

    let mediaId = `sim_${Date.now()}`;
    if (authToken && ct0) {
      const client = new TwitterClient(authToken, ct0, adsAccountId);
      mediaId = await client.uploadMediaChunked(squarePath, (p) => {
        sendProgress(clientId, `Uploading to X (${p}%)`, p);
      });
      sendProgress(clientId, 'X is processing the video', 85);
      sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
      await client.addToAdsMediaLibrary(mediaId, path.basename(videoUrl));
    } else {
      sendProgress(clientId, 'Uploading to X (100%)', 80);
      sendProgress(clientId, 'X is processing the video', 90);
      sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
    }

    sendProgress(clientId, 'Video added to the Ads Media Library and selected', 100);

    // Read generated thumbnail as a base64 Data URL because /tmp is ephemeral
    const thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`;

    const newMedia = {
      id: uuidv4(),
      mediaId: mediaId,
      name: path.basename(videoUrl),
      thumbnail: thumbBase64,
      meta: 'Square · 800x800'
    };

    mediaLibrary.unshift(newMedia);

    // Cleanup /tmp
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));

    return res.json({ success: true, media: newMedia });
  } catch (err) {
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.status(500).json({ error: err.message });
  }
});

// Direct File Upload Route (< 4.5MB on Vercel)
app.post('/api/upload-file', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded or file > 4.5MB' });
  const clientId = req.body.clientId;

  const rawPath = req.file.path;
  const squarePath = path.join(TMP_DIR, `square-${Date.now()}.mp4`);
  const thumbPath = path.join(TMP_DIR, `thumb-${Date.now()}.jpg`);

  try {
    sendProgress(clientId, 'Preparing an 800x800 website card without cropping', 20);
    await makeSquare800(rawPath, squarePath);
    await generateThumbnail(squarePath, thumbPath);

    sendProgress(clientId, 'Square video is ready. Starting X upload.', 50);

    const authToken = process.env.TWITTER_AUTH_TOKEN;
    const ct0 = process.env.TWITTER_CT0;
    const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID || '37';

    let mediaId = `sim_${Date.now()}`;
    if (authToken && ct0) {
      const client = new TwitterClient(authToken, ct0, adsAccountId);
      mediaId = await client.uploadMediaChunked(squarePath, (p) => {
        sendProgress(clientId, `Uploading to X (${p}%)`, p);
      });
      sendProgress(clientId, 'X is processing the video', 85);
      sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
      await client.addToAdsMediaLibrary(mediaId, req.file.originalname);
    }

    sendProgress(clientId, 'Video added to the Ads Media Library and selected', 100);

    const thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`;

    const newMedia = {
      id: uuidv4(),
      mediaId: mediaId,
      name: req.file.originalname,
      thumbnail: thumbBase64,
      meta: 'Square · 800x800'
    };

    mediaLibrary.unshift(newMedia);

    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));

    return res.json({ success: true, media: newMedia });
  } catch (err) {
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.status(500).json({ error: err.message });
  }
});

// Library List
app.get('/api/media', (req, res) => res.json(mediaLibrary));

// Post Tweet Card
app.post('/api/publish', async (req, res) => {
  const { postText, websiteUrl, headline, mediaId } = req.body;
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;

  if (!authToken || !ct0) {
    return res.json({
      success: true,
      simulated: true,
      message: 'Card validated and posted in test mode. (Supply TWITTER_AUTH_TOKEN & TWITTER_CT0 in Vercel Environment Variables to publish live).'
    });
  }

  try {
    const client = new TwitterClient(authToken, ct0, process.env.TWITTER_ADS_ACCOUNT_ID);
    const cardUri = await client.createVideoWebsiteCard(mediaId, websiteUrl, headline);
    const result = await client.postTweetWithCard(postText, cardUri);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// If running locally, listen; on Vercel, export the app
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local dev server on port ${PORT}`));
}

module.exports = app;