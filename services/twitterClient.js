const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Module = require('module');

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
        else if (st.isFile() && /\.(c|m)?js$/.test(f) && st.size < 5 * 1024 * 1024) files.push(p);
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


/* ---------- Ads site (ads-api.x.com) via the logged-in web session ----------
 * Captured from ads.x.com itself: POST https://ads-api.x.com/11/accounts/{id}/cards with a JSON body,
 * authenticated by the same cookies (auth_token + ct0) plus the Ads site's own bearer token.
 * No Ads API developer keys are involved.
 */
const ADS_HOST = 'https://ads-api.x.com';
let adsVersionCache = null; // the Ads site currently uses 11; others are tried only if 11 is rejected

/**
 * Turn whatever X returned into the plain message a person should see.
 * e.g. 'Authorization: This request looks like it might be automated... Please try again later. (226)'
 *   -> 'Authorization: This request looks like it might be automated... Please try again later.'
 * Full technical detail (HTTP status, queryId, card_uri) goes to the server log instead.
 */
function xErrorText(e) {
  const d = e?.response?.data;
  let raw =
    d?.errors?.[0]?.message ||
    d?.error?.message ||
    (typeof d?.error === 'string' ? d.error : '') ||
    d?.message ||
    d?.detail ||
    (typeof d === 'string' ? d : '') ||
    e?.message ||
    '';
  return String(raw);
}

function cleanXMessage(raw) {
  return String(raw)
    .replace(/<[^>]*>/g, ' ')            // stray HTML
    .replace(/\\n|\r?\n/g, ' ')          // escaped or real newlines
    .replace(/^[\s"']+|[\s"']+$/g, '')    // wrapping quotes/space
    .replace(/\s*\(\d{1,4}\)\s*$/, '')    // trailing X error code such as (226)
    .replace(/\s+/g, ' ')
    .trim();
}

class TwitterClient {
  constructor(authToken, ct0, adsAccountId) {
    this.authToken = (authToken || '').trim();
    this.ct0 = (ct0 || '').trim();
    this.adsAccountId = (adsAccountId || '').trim();
    this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0};`;

    // The Ads site uses its own public app bearer (the "authorization" header on ads-api.x.com requests).
    // Copy the value after "Bearer " from your DevTools capture into TWITTER_ADS_BEARER.
    this.adsBearer = (process.env.TWITTER_ADS_BEARER || '').trim().replace(/^Bearer\s+/i, '');
    // Optional: extra cookies (e.g. "twid=u%3D123") only if auth_token + ct0 alone are rejected.
    this.extraCookies = (process.env.TWITTER_COOKIE_EXTRA || '').trim();

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
    if (!this.adsBearer) {
      throw new Error(
        'TWITTER_ADS_BEARER is not set. Copy the value after "Bearer " from the authorization header of an ' +
        'ads-api.x.com request in DevTools (it is the Ads site\'s public app token, not one of your cookies).'
      );
    }
    if (!this.adsAccountId) throw new Error('TWITTER_ADS_ACCOUNT_ID is not set (e.g. 18ce55xmytz).');
    if (!this.authToken || !this.ct0) throw new Error('TWITTER_AUTH_TOKEN / TWITTER_CT0 are not set.');
  }

  _adsHeaders(hasBody) {
    return {
      'Authorization': `Bearer ${this.adsBearer}`,
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'User-Agent': this.defaultHeaders['User-Agent'],
      'Origin': 'https://ads.x.com',
      'Referer': 'https://ads.x.com/',
      'Accept': 'application/json',
      'Cookie': this.cookieHeader + (this.extraCookies ? ` ${this.extraCookies}` : ''),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {})
    };
  }

  /** One Ads-site call using the web session. JSON body for POST. */
  async _adsCall(method, url, body, label) {
    try {
      const res = await axios.request({
        method,
        url,
        data: body,
        headers: this._adsHeaders(body !== undefined),
        timeout: 30000
      });
      return res.data;
    } catch (err) {
      const e = this._wrapError(err, label);
      if (typeof err.response?.data === 'string' && /cloudflare|just a moment/i.test(err.response.data)) {
        e.message += ' [Cloudflare challenge: the Ads host rejected a server-side request; see notes]';
      }
      throw e;
    }
  }

  /** Version negotiation: tries 11 (what the Ads site uses) first; only "version not available" errors retry. */
  async _adsRequest(method, path, body, label) {
    const norm = (v) => String(v || '').trim().split('.')[0];
    const queue = [];
    const tried = new Set();
    const enqueue = (v, front = false) => {
      v = norm(v);
      if (!/^\d+$/.test(v) || tried.has(v)) return;
      const i = queue.indexOf(v);
      if (i !== -1) { if (!front) return; queue.splice(i, 1); }
      front ? queue.unshift(v) : queue.push(v);
    };
    [adsVersionCache, process.env.TWITTER_ADS_API_VERSION, 11, 12, 13, 10].forEach((v) => enqueue(v));

    let lastErr;
    while (queue.length) {
      const v = queue.shift();
      tried.add(v);
      try {
        const data = await this._adsCall(method, `${ADS_HOST}/${v}${path}`, body, label);
        adsVersionCache = v;
        return data;
      } catch (err) {
        lastErr = err;
        if (!/version.*(not available|no longer|unsupported)/i.test(err.message)) throw err;
        enqueue(err.response?.headers?.['x-current-api-version'], true);
      }
    }
    throw new Error(`${lastErr.message} (tried Ads versions: ${[...tried].join(', ')})`);
  }

  /**
   * Resolve the current CreateTweet queryId, in order of reliability:
   *   1. the installed agent-twitter-client package (offline, maintained)
   *   2. a live scrape of X's client bundles
   * Returns null on total failure and fills this._scrapeNote with why.
   */
  async resolveCreateTweetQueryId() {
    // 0. Explicit override: always works, even if the package is missing from the serverless bundle.
    const forced = (process.env.TWITTER_CREATETWEET_QUERY_ID || '').trim();
    if (/^[a-zA-Z0-9_-]{10,}$/.test(forced)) {
      this._queryIdSource = 'env TWITTER_CREATETWEET_QUERY_ID';
      return forced;
    }

    const pkg = getQueryIdFromAgentTwitterClient();
    this._pkgNote = pkg.note;
    if (pkg.id) {
      this._queryIdSource = `agent-twitter-client (${pkg.note})`;
      console.log(`[GraphQL] CreateTweet queryId from agent-twitter-client (${pkg.note}): ${pkg.id}`);
      return pkg.id;
    }
    console.warn(`[GraphQL] agent-twitter-client scan failed: ${pkg.note}`);

    const scraped = await this.getLiveCreateTweetQueryId();
    if (scraped) {
      this._queryIdSource = 'live x.com bundle scrape';
      return scraped;
    }

    this._queryIdSource = null;
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

  /**
   * Add the video to the Ads Media Library. Not yet verified against a capture (the card request was);
   * so a failure here is logged but does not block the upload. If the card step then fails because the
   * video is missing from the library, capture the library request from ads.x.com and send it over.
   */
  async addToAdsMediaLibrary(mediaId, title) {
    this._requireAds();
    try {
      return await this._adsRequest(
        'POST',
        `/accounts/${this.adsAccountId}/media_library?media_key=13_${mediaId}&media_category=AMPLIFY_VIDEO&name=${encodeURIComponent(String(title || `video-${mediaId}`).slice(0, 100))}`,
        undefined,
        'Adding video to the Ads Media Library'
      );
    } catch (err) {
      console.warn(`[MediaLibrary] ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** Create the Video Website Card exactly as the Ads site does (JSON components). Returns { card_uri }. */
  async createVideoWebsiteCard(mediaId, headline, websiteUrl) {
    this._requireAds();
    const body = {
      name: `Share2X ${Date.now()}`,
      components: [
        { type: 'MEDIA', media_key: `13_${mediaId}` },
        { type: 'DETAILS', title: headline.slice(0, 70), destination: { type: 'WEBSITE', url: websiteUrl } }
      ]
    };
    const res = await this._adsRequest('POST', `/accounts/${this.adsAccountId}/cards`, body, 'Creating the Website Card');
    if (!res?.data?.card_uri) throw new Error('Creating the Website Card returned no card_uri.');
    return res.data;
  }

  /** Credential check used by /api/diagnose: lists one card to prove the session + bearer are accepted. */
  async checkAdsAccess() {
    this._requireAds();
    const res = await this._adsRequest('GET', `/accounts/${this.adsAccountId}/cards?count=1`, undefined, 'Checking Ads access');
    return { ok: true, adsApiVersion: adsVersionCache, sampleCards: Array.isArray(res?.data) ? res.data.length : 0 };
  }

  /**
   * Publish an organic post with the Website Card attached, via the cookie session
   * (the path that already works for you). The card carries the video, headline and URL,
   * so the post sends card_uri and NO media entities and NO appended headline/link text.
   */
  async postTweet(statusText, mediaId, websiteUrl, headline) {
    if (!/^https?:\/\//i.test(websiteUrl)) {
      throw new Error('Your URL needs to start with https:// or http://. Check the address and try again');
    }

    // Step 1: create the card (nothing is posted yet, so a failure here is safe to retry)
    const card = await this.createVideoWebsiteCard(mediaId, headline, websiteUrl);

    // Step 2: post via the web session with card_uri
    const queryId = await this.resolveCreateTweetQueryId();
    if (!queryId) {
      throw new Error(
        'Could not resolve the CreateTweet queryId. ' +
        `Package scan: ${this._pkgNote}. Live scrape: ${this._scrapeNote}. ` +
        'Fix: set TWITTER_CREATETWEET_QUERY_ID (see .env.example), or make sure vercel.json includes node_modules/agent-twitter-client.'
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
    const rawMessage = xErrorText(lastError);
    console.error(
      `[Publish] CreateTweet failed after card ${card.card_uri} was created: HTTP ${status || 'n/a'}, queryId=${queryId}, message=${rawMessage}`
    );
    const err = new Error(cleanXMessage(rawMessage) || 'X rejected the post. Please try again.');
    err.response = lastError?.response;
    err.cardUri = card.card_uri;
    throw err;
  }
}

module.exports = TwitterClient;
