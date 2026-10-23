const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');

/**
 * Locate an installed package directory by walking the node_modules
 * resolution paths from the app root and from this file's location.
 */
function findPackageDir(name) {
  const searchFrom = [process.cwd(), __dirname];
  for (const from of searchFrom) {
    for (const nmDir of Module._nodeModulePaths(from)) {
      const dir = path.join(nmDir, name);
      try {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      } catch {}
    }
  }
  return null;
}

/**
 * Read the CreateTweet queryId straight out of the installed
 * agent-twitter-client package. The package maintainers keep the ID
 * current with each release, so this is the most reliable source and
 * requires no scraping at all.
 */
function getQueryIdFromAgentTwitterClient() {
  try {
    const dir = findPackageDir('agent-twitter-client');
    if (!dir) return { id: null, note: 'agent-twitter-client not found in node_modules' };

    const files = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory() && f !== 'node_modules') walk(p, depth + 1);
        else if (st.isFile() && f.endsWith('.js') && st.size < 5 * 1024 * 1024) files.push(p);
      }
    };
    walk(dir, 0);

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      let m = code.match(/graphql\/([a-zA-Z0-9_-]{10,})\/CreateTweet/);
      if (!m) m = code.match(/CreateTweet\w*QueryId\s*[:=]\s*['"]([a-zA-Z0-9_-]{10,})['"]/i);
      if (!m) m = code.match(/['"]([a-zA-Z0-9_-]{10,})['"]\s*,?\s*\/\* CreateTweet \*\//i);
      if (m) return { id: m[1], note: `extracted from ${path.relative(dir, file)}` };
    }
    return { id: null, note: 'package found but no CreateTweet queryId matched inside it' };
  } catch (e) {
    return { id: null, note: `package scan error: ${e.message}` };
  }
}


/* ---------- Ads API (OAuth 1.0a) helpers: used ONLY for media library + card creation ---------- */

const ADS_HOST = 'https://ads-api.x.com';
// X's docs say v12 but live servers have answered "Version 12.0 not available",
// so the version is negotiated at runtime and cached.
let adsVersionCache = null;

const enc = (s) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const buildQuery = (params) =>
  Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');

function oauthHeader({ method, url, params = {}, creds, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: '1.0'
  };
  const base = [method.toUpperCase(), enc(url), enc(buildQuery({ ...params, ...oauth }))].join('&');
  const key = `${enc(creds.consumerSecret)}&${enc(creds.tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
}

class TwitterClient {
  constructor(authToken, ct0, adsAccountId) {
    this.authToken = (authToken || '').trim();
    this.ct0 = (ct0 || '').trim();
    this.adsAccountId = (adsAccountId || '').trim();
    this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0};`;

    this.creds = {
      consumerKey: (process.env.TWITTER_API_KEY || '').trim(),
      consumerSecret: (process.env.TWITTER_API_SECRET || '').trim(),
      token: (process.env.TWITTER_ACCESS_TOKEN || '').trim(),
      tokenSecret: (process.env.TWITTER_ACCESS_TOKEN_SECRET || '').trim()
    };
    this.hasOAuth = Object.values(this.creds).every(Boolean);

    this.defaultHeaders = {
      'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': 'https://x.com',
      'Referer': 'https://x.com/',
      'Cookie': this.cookieHeader
    };

    this._scrapeNote = 'not attempted';
  }

  _wrapError(err, label) {
    const status = err.response?.status;
    const body = err.response?.data;
    const apiMsg =
      body?.errors?.[0]?.message || body?.errors?.[0]?.code || body?.error ||
      (typeof body === 'string' ? body.replace(/<[^>]*>/g, '').trim().slice(0, 200) : '') || err.message;
    const e = new Error(`${label} failed (${status || 'no response'}): ${apiMsg}`);
    e.status = status;
    e.response = err.response;
    return e;
  }

  _requireAds() {
    if (!this.hasOAuth) {
      throw new Error(
        'Creating the Website Card needs X Ads API credentials: set TWITTER_API_KEY, TWITTER_API_SECRET, ' +
        'TWITTER_ACCESS_TOKEN and TWITTER_ACCESS_TOKEN_SECRET.'
      );
    }
    if (!this.adsAccountId) {
      throw new Error('TWITTER_ADS_ACCOUNT_ID is not set (use the Ads account ID, e.g. 18ce55xmjw6).');
    }
  }

  async _oauthRequest(method, baseUrl, params, label) {
    const query = buildQuery(params);
    try {
      const res = await axios.request({
        method,
        url: query ? `${baseUrl}?${query}` : baseUrl,
        headers: { Authorization: oauthHeader({ method, url: baseUrl, params, creds: this.creds }) },
        timeout: 30000
      });
      return res.data;
    } catch (err) {
      throw this._wrapError(err, label);
    }
  }

  /** Ads API call with version negotiation. Only "version not available" errors trigger a retry. */
  async _adsRequest(method, path, params, label) {
    const norm = (v) => String(v || '').trim().split('.')[0];
    const queue = [];
    const tried = new Set();
    const enqueue = (v, front = false) => {
      v = norm(v);
      if (!/^\d+$/.test(v) || tried.has(v) || queue.includes(v)) return;
      front ? queue.unshift(v) : queue.push(v);
    };
    [adsVersionCache, process.env.TWITTER_ADS_API_VERSION, 12, 13, 11, 10].forEach((v) => enqueue(v));

    let lastErr;
    while (queue.length) {
      const v = queue.shift();
      tried.add(v);
      try {
        const data = await this._oauthRequest(method, `${ADS_HOST}/${v}${path}`, params, label);
        adsVersionCache = v;
        return data;
      } catch (err) {
        lastErr = err;
        if (!/version.*(not available|no longer|unsupported)/i.test(err.message)) throw err;
        enqueue(err.response?.headers?.['x-current-api-version'], true);
      }
    }
    throw new Error(`${lastErr.message} (tried Ads API versions: ${[...tried].join(', ')}). Set TWITTER_ADS_API_VERSION to the version your account supports.`);
  }

  /**
   * Resolve the current CreateTweet queryId, in order of reliability:
   *   1. the installed agent-twitter-client package (offline, maintained)
   *   2. a live scrape of X's client bundles
   * Returns null on total failure and fills this._scrapeNote with why.
   */
  async resolveCreateTweetQueryId() {
    const pkg = getQueryIdFromAgentTwitterClient();
    if (pkg.id) {
      console.log(`[GraphQL] CreateTweet queryId from agent-twitter-client (${pkg.note}): ${pkg.id}`);
      return pkg.id;
    }
    console.warn(`[GraphQL] agent-twitter-client scan failed: ${pkg.note}`);

    const scraped = await this.getLiveCreateTweetQueryId();
    if (scraped) return scraped;

    return null;
  }

  /**
   * Fallback: scrape the queryId from live X client bundles.
   */
  async getLiveCreateTweetQueryId() {
    const patterns = [
      /queryId\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*operationName\s*:\s*"CreateTweet"/,
      /operationName\s*:\s*"CreateTweet"[\s\S]{0,200}?queryId\s*:\s*"([a-zA-Z0-9_-]{10,})"/,
      /"queryId"\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*"operationName"\s*:\s*"CreateTweet"/,
      /"operationName"\s*:\s*"CreateTweet"[\s\S]{0,200}?"queryId"\s*:\s*"([a-zA-Z0-9_-]{10,})"/
    ];

    try {
      const homeRes = await axios.get('https://x.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 20000,
        validateStatus: () => true
      });

      if (homeRes.status !== 200) {
        this._scrapeNote = `homepage returned HTTP ${homeRes.status}`;
        return null;
      }

      const html = homeRes.data;
      const bundleUrls = new Set();

      (html.match(/https:\/\/[^"'<>\s]+?\.js/g) || []).forEach(u => {
        if (u.includes('client-web')) bundleUrls.add(u);
      });
      (html.match(/\/[^"'<>\s]+?client-web[^"'<>\s]+?\.js/g) || []).forEach(rel => {
        bundleUrls.add('https://abs.twimg.com' + rel);
      });

      if (bundleUrls.size === 0) {
        this._scrapeNote = `homepage loaded (${html.length} chars) but no client-web bundles matched — likely a JS-challenge page`;
        return null;
      }

      const ordered = [...bundleUrls].sort(
        (a, b) => Number(/main\./.test(b)) - Number(/main\./.test(a))
      );

      let searched = 0;
      for (const url of ordered.slice(0, 40)) {
        searched++;
        try {
          const jsRes = await axios.get(url, { responseType: 'text', timeout: 25000 });
          for (const re of patterns) {
            const m = jsRes.data.match(re);
            if (m && m[1]) {
              console.log(`[GraphQL] Found live CreateTweet queryId: ${m[1]} (from ${url.split('/').pop()})`);
              return m[1];
            }
          }
        } catch {
          // bundle unreachable -> try the next one
        }
      }
      this._scrapeNote = `searched ${searched} bundles, no CreateTweet queryId matched`;
    } catch (e) {
      this._scrapeNote = `scrape error: ${e.message}`;
    }
    return null;
  }

  /**
   * Upload video. media_category is amplify_video (not tweet_video): that is what makes the
   * video usable in the Ads Media Library and in video cards. Cookie session, as before.
   */
  async uploadMediaChunked(filePath, onProgress) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    const initRes = await axios.post(
      'https://upload.twitter.com/1.1/media/upload.json',
      null,
      {
        params: { command: 'INIT', media_type: 'video/mp4', total_bytes: totalBytes, media_category: 'amplify_video' },
        headers: this.defaultHeaders
      }
    );

    const mediaId = initRes.data.media_id_string;
    const chunkSize = 4 * 1024 * 1024;
    const fd = fs.openSync(filePath, 'r');
    let segmentIndex = 0;
    let bytesUploaded = 0;
    const buffer = Buffer.alloc(chunkSize);

    while (bytesUploaded < totalBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));

      const form = new (require('form-data'))();
      form.append('command', 'APPEND');
      form.append('media_id', mediaId);
      form.append('segment_index', segmentIndex.toString());
      form.append('media', chunk, { filename: 'video.mp4', contentType: 'application/octet-stream' });

      await axios.post('https://upload.twitter.com/1.1/media/upload.json', form, {
        headers: { ...this.defaultHeaders, ...form.getHeaders() }
      });

      segmentIndex++;
      bytesUploaded += bytesRead;
      if (onProgress) onProgress(Math.min(99, Math.round((bytesUploaded / totalBytes) * 100)));
    }
    fs.closeSync(fd);

    const finalizeRes = await axios.post(
      'https://upload.twitter.com/1.1/media/upload.json',
      null,
      { params: { command: 'FINALIZE', media_id: mediaId }, headers: this.defaultHeaders }
    );

    let processingInfo = finalizeRes.data.processing_info;
    while (processingInfo && (processingInfo.state === 'pending' || processingInfo.state === 'in_progress')) {
      await new Promise((r) => setTimeout(r, (processingInfo.check_after_secs || 2) * 1000));
      const statusRes = await axios.get('https://upload.twitter.com/1.1/media/upload.json', {
        params: { command: 'STATUS', media_id: mediaId },
        headers: this.defaultHeaders
      });
      processingInfo = statusRes.data.processing_info;
      if (processingInfo && processingInfo.state === 'failed') {
        throw new Error(processingInfo.error?.message || 'X failed to process video.');
      }
    }
    return mediaId;
  }

  /** Add the video to the Ads Media Library (a card can only use library videos). Errors are surfaced. */
  async addToAdsMediaLibrary(mediaId, title) {
    this._requireAds();
    return this._adsRequest(
      'POST',
      `/accounts/${this.adsAccountId}/media_library`,
      { media_key: `13_${mediaId}`, media_category: 'AMPLIFY_VIDEO', name: String(title || `video-${mediaId}`).slice(0, 100) },
      'Adding video to the Ads Media Library'
    );
  }

  /** Create the Video Website Card (the "Watch full video / from site.com" layout). Returns { card_uri }. */
  async createVideoWebsiteCard(mediaId, headline, websiteUrl) {
    this._requireAds();
    const res = await this._adsRequest(
      'POST',
      `/accounts/${this.adsAccountId}/cards/video_website`,
      {
        name: `Share2X ${headline}`.slice(0, 80),
        title: headline.slice(0, 70),
        media_key: `13_${mediaId}`,
        website_url: websiteUrl
      },
      'Creating the Website Card'
    );
    if (!res?.data?.card_uri) throw new Error('Creating the Website Card returned no card_uri.');
    return res.data;
  }

  /** Credential check used by /api/diagnose. */
  async checkAdsAccess() {
    this._requireAds();
    const res = await this._adsRequest('GET', `/accounts/${this.adsAccountId}`, {}, 'Checking Ads account access');
    return { id: res.data?.id, name: res.data?.name, adsApiVersion: adsVersionCache };
  }

  /**
   * Publish an organic post with the Website Card attached, via the cookie session
   * (the path that already works for you). The card carries the video, headline and URL,
   * so the post sends card_uri and NO media entities and NO appended headline/link text.
   */
  async postTweet(statusText, mediaId, websiteUrl, headline) {
    if (!/^https:\/\//i.test(websiteUrl)) throw new Error('Website URL must start with https://');

    // Step 1: create the card (nothing is posted yet, so a failure here is safe to retry)
    const card = await this.createVideoWebsiteCard(mediaId, headline, websiteUrl);

    // Step 2: post via the web session with card_uri
    const queryId = await this.resolveCreateTweetQueryId();
    if (!queryId) {
      throw new Error(
        'Could not resolve a live CreateTweet queryId. ' +
        `Bundle scrape: ${this._scrapeNote}. Run "npm install agent-twitter-client@latest" and retry.`
      );
    }

    const graphqlPayload = {
      variables: {
        tweet_text: (statusText || '').trim() || headline,
        card_uri: card.card_uri,
        media: { media_entities: [], possibly_sensitive: false },
        semantic_annotation_ids: [],
        dark_request: false
      },
      features: {
        interactive_text: true,
        longform_notetweets_consumption_enabled: true,
        longform_notetweets_inline_media_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        responsive_web_enhance_cards_enabled: false,
        responsive_web_graphql_exclude_directive_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_media_download_video_enabled: false,
        responsive_web_text_conversations_enabled: false,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        responsive_web_twitter_blue_verified_badge_is_enabled: true,
        rweb_video_timestamps_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_awards_web_tipping_enabled: false,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        tweetypie_unmention_optimization_enabled: true,
        verified_phone_label_enabled: false,
        vibe_api_enabled: true,
        view_counts_everywhere_api_enabled: true
      },
      fieldToggles: {
        withArticleRichContentState: true
      }
    };

    const gqlHeaders = { ...this.defaultHeaders, 'Content-Type': 'application/json' };

    let lastError = null;
    for (const host of ['https://api.x.com', 'https://x.com']) {
      const url = `${host}/i/api/graphql/${queryId}/CreateTweet`;
      try {
        const gqlRes = await axios.post(url, graphqlPayload, { headers: gqlHeaders, timeout: 30000 });
        const result = gqlRes.data?.data?.create_tweet?.tweet_results?.result;
        const postId = result?.rest_id || result?.tweet?.rest_id;
        if (postId) return { success: true, postId, cardUri: card.card_uri };
        if (gqlRes.data?.errors?.length) {
          throw new Error(gqlRes.data.errors[0]?.message || 'GraphQL mutation returned errors.');
        }
        return { success: true, raw: gqlRes.data, cardUri: card.card_uri };
      } catch (e) {
        lastError = e;
        const status = e.response?.status;
        const body = JSON.stringify(e.response?.data || e.message).slice(0, 300);
        console.warn(`[GraphQL] CreateTweet via ${host} failed: HTTP ${status || 'n/a'} — ${body}`);
        if (status && status !== 404) break;
      }
    }

    const status = lastError?.response?.status;
    const body = JSON.stringify(lastError?.response?.data ?? lastError?.message ?? '').slice(0, 300);
    const err = new Error(
      `Card created (${card.card_uri}) but CreateTweet failed (HTTP ${status || 'network'}): ${body} [queryId=${queryId}]`
    );
    err.response = lastError?.response;
    throw err;
  }
}

module.exports = TwitterClient;
module.exports.oauthHeader = oauthHeader;
  
