require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { TMP_DIR, downloadVideo, makeSquare800, generateThumbnail } = require('../services/videoProcessor');
const TwitterClient = require('../services/twitterClient');
const db = require('../services/db');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 4.5 * 1024 * 1024 }
});

const progressClients = {};
const router = express.Router();

router.get('/progress/:clientId', (req, res) => {
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

// GET Media Library from DB
router.get('/media', async (req, res) => {
  const items = await db.getAllMedia();
  return res.json(items);
});

// URL Upload Route
router.post('/upload-url', async (req, res) => {
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

    // SAVE TO DATABASE
    const savedRecord = await db.saveMedia({
      mediaId: mediaId,
      name: path.basename(videoUrl),
      thumbnail: thumbBase64,
      meta: 'Square · 800x800'
    });

    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.json({ success: true, media: savedRecord });
  } catch (err) {
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.status(500).json({ error: err.message });
  }
});

// File Upload Route
router.post('/upload-file', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded or file exceeds 4.5MB' });
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
    const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

    const client = new TwitterClient(authToken, ct0, adsAccountId);
    const mediaId = await client.uploadMediaChunked(squarePath, (p) => {
      sendProgress(clientId, `Uploading to X (${p}%)`, p);
    });

    sendProgress(clientId, 'X is processing the video', 85);
    sendProgress(clientId, 'Adding video to the Ads Media Library', 95);
    await client.addToAdsMediaLibrary(mediaId, req.file.originalname);

    sendProgress(clientId, 'Video added to the Ads Media Library and selected', 100);

    const thumbBase64 = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString('base64')}`;

    // SAVE TO DATABASE
    const savedRecord = await db.saveMedia({
      mediaId: mediaId,
      name: req.file.originalname,
      thumbnail: thumbBase64,
      meta: 'Square · 800x800'
    });

    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.json({ success: true, media: savedRecord });
  } catch (err) {
    [rawPath, squarePath, thumbPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
    return res.status(500).json({ error: err.message });
  }
});

// Publish
router.post('/publish', async (req, res) => {
  const { postText, websiteUrl, headline, mediaId } = req.body;
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

  if (!websiteUrl || !headline || !mediaId) {
    return res.status(400).json({ error: 'Missing required card fields: websiteUrl, headline, or mediaId.' });
  }

  const client = new TwitterClient(authToken, ct0, adsAccountId);

  try {
    console.log(`[Publish] Posting 800x800 square video with headline & destination link...`);
    const result = await client.postTweet(postText, mediaId, websiteUrl, headline);

    const postId = result.postId || 'posted';
    return res.json({
      success: true,
      postId: postId,
      message: `X created the Website Card post. View post: https://x.com/i/status/${postId}`
    });
  } catch (postErr) {
    const errObj = postErr.response?.data?.errors?.[0];
    const code = errObj?.code || postErr.response?.status || 'Unknown';
    const message = errObj?.message || postErr.message;

    return res.status(400).json({
      error: `Authorization: ${message} (${code}) The post could not be confirmed. Check your X timeline before retrying.`,
      details: postErr.response?.data
    });
  }
});

app.use('/api', router);
app.use('/', router);

module.exports = app;