require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { TMP_DIR, downloadVideo, makeSquare800, generateThumbnail } = require('../services/videoProcessor');
const TwitterClient = require('../services/twitterClient');
const db = require('../services/db');
const auth = require('../services/auth');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 4.5 * 1024 * 1024 }
});

const progressClients = {};
const router = express.Router();

// ---------- Authentication ----------
// Everything below the "requireAuth" line needs a valid, unexpired session cookie.
router.use(auth.sameOrigin);

router.post('/login', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.isConfigured()) {
    return res.status(503).json({
      error: 'Login is not set up on the server yet. Add AUTH_EMAIL, AUTH_PASSWORD_HASH and AUTH_SECRET to the environment variables.',
      code: 'unconfigured'
    });
  }

  const ip = auth.clientIp(req);
  if (await auth.isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.', code: 'locked' });
  }

  const { email, password } = req.body || {};
  if (!(await auth.verifyLogin(email, password))) {
    await auth.recordFailure(ip);
    await new Promise((r) => setTimeout(r, 400));   // slows down guessing
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  await auth.clearFailures(ip);
  const now = Date.now();
  auth.setSessionCookie(req, res, auth.issueToken(auth.getConfig().email, { iat: now, la: now }), now);
  return res.json({ success: true, redirect: '/' });
});

router.post('/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ success: true });
});

router.use(auth.requireAuth);

router.get('/session', (req, res) =>
  res.json({ authenticated: true, user: req.user, remainingMs: Number(res.getHeader('X-Session-Remaining-Ms')) })
);
router.post('/session/touch', (req, res) => res.json({ success: true }));

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
const URL_RULE_MESSAGE = 'Your URL needs to start with https:// or http://. Check the address and try again';

// History logging must never break (or change the result of) a publish.
async function logAttempt(entry) {
  try {
    await db.addPost(entry);
  } catch (err) {
    console.warn('[History] Could not record post attempt:', err.message);
  }
}

router.post('/publish', async (req, res) => {
  const { postText, websiteUrl, headline, mediaId } = req.body;
  const accountLabel = String(req.body.accountLabel || '').slice(0, 60);
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  const adsAccountId = process.env.TWITTER_ADS_ACCOUNT_ID;

  if (!websiteUrl || !headline || !mediaId) {
    return res.status(400).json({ error: 'Missing required card fields: websiteUrl, headline, or mediaId.' });
  }
  if (!/^https?:\/\//i.test(String(websiteUrl).trim())) {
    return res.status(400).json({ error: URL_RULE_MESSAGE });
  }

  const client = new TwitterClient(authToken, ct0, adsAccountId);
  const base = { headline, postText, websiteUrl: String(websiteUrl).trim(), mediaId, accountLabel };

  try {
    console.log('[Publish] Creating Video Website Card and posting...');
    const result = await client.postTweet(postText, mediaId, String(websiteUrl).trim(), headline);

    const postId = result.postId && /^\d+$/.test(String(result.postId)) ? String(result.postId) : null;
    const postUrl = postId ? `https://x.com/i/status/${postId}` : null;
    await logAttempt({ ...base, status: 'published', postId, postUrl });

    return res.json({
      success: true,
      postId,
      postUrl,
      cardUri: result.cardUri,
      message: 'X created the Website Card post.'
    });
  } catch (postErr) {
    console.error('[Publish] failed:', postErr.message, JSON.stringify(postErr.response?.data || {}));
    await logAttempt({ ...base, status: 'failed', error: postErr.message });
    return res.status(400).json({
      error: postErr.message,
      details: postErr.response?.data
    });
  }
});

// ---- Post history ----
router.get('/posts/summary', async (req, res) => {
  try {
    let tz = parseInt(req.query.tz, 10);
    if (!Number.isFinite(tz) || tz < -840 || tz > 840) tz = 0;
    return res.json(await db.getPostSummary(tz, 30));
  } catch (err) {
    return res.status(500).json({ error: `Could not load post history: ${err.message}` });
  }
});

router.get('/posts', async (req, res) => {
  try {
    return res.json({ posts: await db.getPostHistory() });
  } catch (err) {
    return res.status(500).json({ error: `Could not load post history: ${err.message}` });
  }
});

router.delete('/posts/:id', async (req, res) => {
  try {
    const removed = await db.deletePost(req.params.id);
    if (!removed) return res.status(404).json({ error: 'That history entry no longer exists.' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: `Could not delete the entry: ${err.message}` });
  }
});

router.delete('/posts', async (req, res) => {
  try {
    return res.json({ success: true, deleted: await db.clearPostHistory() });
  } catch (err) {
    return res.status(500).json({ error: `Could not delete post history: ${err.message}` });
  }
});

// Setup check: GET /api/diagnose (requires sign-in)
router.get('/diagnose', async (req, res) => {
  const client = new TwitterClient(
    process.env.TWITTER_AUTH_TOKEN,
    process.env.TWITTER_CT0,
    process.env.TWITTER_ADS_ACCOUNT_ID
  );
  const report = {
    hasAdsAccountId: !!client.adsAccountId,
    hasAdsBearer: !!client.adsBearer,
    hasWebSession: !!(client.authToken && client.ct0),
    adsApiHost: 'ads-api.x.com'
  };
  try {
    report.adsAccount = await client.checkAdsAccess();
    const qid = await client.resolveCreateTweetQueryId();
    report.createTweetQueryId = qid ? { ok: true, source: client._queryIdSource } : { ok: false, packageScan: client._pkgNote, liveScrape: client._scrapeNote };
    report.ok = !!qid;
  } catch (err) {
    report.ok = false;
    report.error = err.message;
  }
  return res.json(report);
});

app.use('/api', router);
app.use('/', router);

module.exports = app;
