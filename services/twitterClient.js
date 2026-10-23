const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Module = require('module');

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

class TwitterClient {
  constructor(authToken, ct0, adsAccountId) {
    this.authToken = (authToken || '').trim();
    this.ct0 = (ct0 || '').trim();
    this.adsAccountId = (adsAccountId || '').trim();
    this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0};`;

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

  async resolveCreateTweetQueryId() {
    const pkg = getQueryIdFromAgentTwitterClient();
    if (pkg.id) {
      console.log(`[GraphQL] CreateTweet queryId from agent-twitter-client: ${pkg.id}`);
      return pkg.id;
    }
    return await this.getLiveCreateTweetQueryId();
  }

  async getLiveCreateTweetQueryId() {
    const patterns = [
      /queryId\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*operationName\s*:\s*"CreateTweet"/,
      /"queryId"\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*"operationName"\s*:\s*"CreateTweet"/
    ];

    try {
      const homeRes = await axios.get('https://x.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 20000,
        validateStatus: () => true
      });

      const html = homeRes.data;
      const bundleUrls = (html.match(/https:\/\/[^"'<>\s]+?\.js/g) || []).filter(u => u.includes('client-web'));

      for (const url of bundleUrls.slice(0, 30)) {
        try {
          const jsRes = await axios.get(url, { responseType: 'text', timeout: 20000 });
          for (const re of patterns) {
            const m = jsRes.data.match(re);
            if (m && m[1]) return m[1];
          }
        } catch {}
      }
    } catch (e) {
      this._scrapeNote = e.message;
    }
    return 'xT380ap0xMQeTnzBfjt9Aw'; // Fallback active hash
  }

  /**
   * Upload video via chunked upload (tweet_video)
   */
  async uploadMediaChunked(filePath, onProgress) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    const initRes = await axios.post(
      'https://upload.twitter.com/1.1/media/upload.json',
      null,
      {
        params: {
          command: 'INIT',
          media_type: 'video/mp4',
          total_bytes: totalBytes,
          media_category: 'tweet_video'
        },
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
      const chunk = buffer.slice(0, bytesRead);

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
      {
        params: { command: 'FINALIZE', media_id: mediaId },
        headers: this.defaultHeaders
      }
    );

    let processingInfo = finalizeRes.data.processing_info;
    while (processingInfo && (processingInfo.state === 'pending' || processingInfo.state === 'in_progress')) {
      const waitTime = (processingInfo.check_after_secs || 2) * 1000;
      await new Promise(r => setTimeout(r, waitTime));

      const statusRes = await axios.get('https://upload.twitter.com/1.1/media/upload.json', {
        params: { command: 'STATUS', media_id: mediaId },
        headers: this.defaultHeaders
      });

      processingInfo = statusRes.data.processing_info;
      if (processingInfo && processingInfo.state === 'failed') {
        throw new Error(processingInfo.error?.message || 'X failed to transcode video.');
      }
    }

    return mediaId;
  }

  /**
   * Generates the Video Website Card URI (card://...)
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    const cardPayload = {
      name: headline,
      video_id: mediaId,
      website_url: websiteUrl,
      website_title: headline
    };

    // Primary: Modern Ads API gateway (ads-api.x.com)
    const endpoints = [
      `https://ads-api.x.com/12/accounts/${this.adsAccountId}/cards/video_website`,
      `https://ads.x.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
      `https://ads-api.twitter.com/12/accounts/${this.adsAccountId}/cards/video_website`
    ];

    for (const url of endpoints) {
      try {
        const res = await axios.post(url, cardPayload, {
          headers: {
            ...this.defaultHeaders,
            'Origin': 'https://ads.x.com',
            'Referer': 'https://ads.x.com/',
            'Content-Type': 'application/json'
          }
        });

        const cardUri = res.data?.data?.card_uri || res.data?.card_uri;
        if (cardUri) {
          console.log(`[Card Creation] Successfully created card URI: ${cardUri}`);
          return cardUri;
        }
      } catch (err) {
        console.warn(`[Card Creation] ${url} notice:`, err.response?.data?.errors?.[0]?.message || err.message);
      }
    }

    return null;
  }

  /**
   * Publish Website Card Tweet
   */
  async postTweet(statusText, mediaId, websiteUrl, headline) {
    const queryId = await this.resolveCreateTweetQueryId();
    if (!queryId) {
      throw new Error('Could not resolve a live CreateTweet queryId.');
    }

    // 1. Attempt to create the Website Card URI
    console.log(`[Publish] Attempting to create card:// URI for media ${mediaId}...`);
    const cardUri = await this.createVideoWebsiteCard(mediaId, websiteUrl, headline);

    // 2. Build GraphQL Payload
    let graphqlPayload;

    if (cardUri) {
      // WEBSITE CARD LAYOUT (Picture 2)
      // card_uri carries the video, headline, and outbound destination link
      console.log(`[Publish] Using Video Website Card URI: ${cardUri}`);
      graphqlPayload = {
        variables: {
          tweet_text: statusText || '',
          card_uri: cardUri,
          nullcast: false
        },
        features: {
          interactive_text: true,
          longform_notetweets_consumption_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          responsive_web_edit_tweet_api_enabled: true,
          responsive_web_enhance_cards_enabled: true, // Required for Card layout
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
    } else {
      // Fallback: Autoplay square video with headline & link
      console.warn(`[Publish] Card URI not available; attaching square video entity directly.`);
      const formattedText = statusText
        ? `${statusText}\n\n${headline}\n${websiteUrl}`
        : `${headline}\n${websiteUrl}`;

      graphqlPayload = {
        variables: {
          tweet_text: formattedText,
          media: {
            media_entities: [{ media_id: mediaId, tagged_users: [] }],
            possibly_sensitive: false
          },
          nullcast: false
        },
        features: {
          interactive_text: true,
          responsive_web_enhance_cards_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true
        },
        fieldToggles: {
          withArticleRichContentState: true
        }
      };
    }

    const gqlHeaders = {
      ...this.defaultHeaders,
      'Content-Type': 'application/json'
    };

    for (const host of ['https://x.com', 'https://api.x.com']) {
      try {
        const url = `${host}/i/api/graphql/${queryId}/CreateTweet`;
        const res = await axios.post(url, graphqlPayload, {
          headers: gqlHeaders,
          timeout: 30000
        });

        const result = res.data?.data?.create_tweet?.tweet_results?.result;
        const postId = result?.rest_id || result?.tweet?.rest_id;
        if (postId) {
          return { success: true, postId, cardUri };
        }
      } catch (e) {
        console.warn(`[GraphQL] Post via ${host} failed:`, e.response?.data || e.message);
      }
    }

    throw new Error('Could not publish tweet to X timeline.');
  }
}

module.exports = TwitterClient;
