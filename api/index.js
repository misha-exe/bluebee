require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { TMP_DIR, downloadVideo, makeSquare800, generateThumbnail } = require('../services/videoProcessor');
const TwitterClient = require('../services/twitterClient');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 4.5 * 1024 * 1024 }
});

const progressClients = {};

app.get('/api/progress/:clientId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = req.params.clientId;
  progressClients[clientId] = res;
  req.on('close', () => delete progressClients[clientId]);
});

function sendProgress(clientId, status, percent = 0) {
  if (progressClients[clientId]) {
    progressClients[clientId].write(`data: ${JSON.stringify({ status, percent })}\n\n`);
  }
}

// Media Library Endpoint - fetches directly from X Ads
app.get('/api/media', async (req, res) => {
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

  if (authToken && ct0 && adsAccountId) {
    const client = new TwitterClient(authToken, ct0, adsAccountId);
    const remoteMedia = await client.fetchMediaLibrary();
    if (remoteMedia && remoteMedia.length > 0) {
      return res.json(remoteMedia);
    }
  }

  // Fallback default
  res.json([
    {
      id: "media_default",
      mediaId: "2104707817047224320",
      name: "59X2ZM5n0k8CFp5f.mp4",
      thumbnail: "https://pbs.twimg.com/amplify_video_thumb/2104707817047224320/img/Sk3kHH4uHdI8y-EU.jpg",
      meta: "Square · 800x800"
    }
  ]);
});

// URL Upload
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
    const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

    const client = new TwitterClient(authToken, ct0, adsAccountId);
    const mediaId = await client.uploadMediaChunked(squarePath, (p) => {
      sendProgress(clientId, `Uploading to X (${p}%)`, p);
    });

    sendProgress(clientId, 'X is processing the video', 85);
    sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
    await client.addToAdsMediaLibrary(mediaId, path.basename(videoUrl));

    sendProgress(clientId, 'Video added to the Ads Media Library and selected', 100);

    const thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`;
    const newMedia = {
      id: uuidv4(),
      mediaId: mediaId,
      name: path.basename(videoUrl),
      thumbnail: thumbBase64,
      meta: 'Square · 800x800'
    };

    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.json({ success: true, media: newMedia });
  } catch (err) {
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.status(500).json({ error: err.message });
  }
});

// Publish Tweet
app.post('/api/publish', async (req, res) => {
  const { postText, websiteUrl, headline, mediaId } = req.body;
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

  if (!websiteUrl || !headline || !mediaId) {
    return res.status(400).json({ error: 'Missing required card fields: websiteUrl, headline, or mediaId.' });
  }

  try {
    const client = new TwitterClient(authToken, ct0, adsAccountId);

    console.log(`[Publish] Creating Video Website Card for media: ${mediaId}...`);
    const cardUri = await client.createVideoWebsiteCard(mediaId, websiteUrl, headline);
    console.log(`[Publish] Card created: ${cardUri}`);

    console.log(`[Publish] Posting organic tweet...`);
    const result = await client.postTweetWithCard(postText || '', cardUri);
    console.log(`[Publish] Published successfully!`);

    return res.json({ success: true, cardUri, result });
  } catch (err) {
    const twitterError = err.response?.data;
    console.error('[Publish Error]', JSON.stringify(twitterError || err.message, null, 2));

    const errorMessage =
      twitterError?.errors?.[0]?.message ||
      twitterError?.error ||
      err.response?.statusText ||
      err.message;

    return res.status(err.response?.status || 500).json({
      error: `Twitter API Error: ${errorMessage}`,
      details: twitterError
    });
  }
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;