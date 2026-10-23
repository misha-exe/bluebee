const axios = require('axios');
const fs = require('fs');

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
  }

  /**
   * Dynamically fetches the exact current CreateTweet query ID from live X client bundles.
   * Returns null (instead of a stale hardcoded ID) when scraping fails, so the caller
   * can raise a clear error instead of hitting a guaranteed 404.
   */
  async getLiveCreateTweetQueryId() {
    const patterns = [
      // modern minified: {queryId:"...",operationName:"CreateTweet",...}
      /queryId\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*operationName\s*:\s*"CreateTweet"/,
      // reversed field order
      /operationName\s*:\s*"CreateTweet"[\s\S]{0,200}?queryId\s*:\s*"([a-zA-Z0-9_-]{10,})"/,
      // JSON-ish (unminified / source maps)
      /"queryId"\s*:\s*"([a-zA-Z0-9_-]{10,})"\s*,\s*"operationName"\s*:\s*"CreateTweet"/,
      /"operationName"\s*:\s*"CreateTweet"[\s\S]{0,200}?"queryId"\s*:\s*"([a-zA-Z0-9_-]{10,})"/
    ];

    try {
      const homeRes = await axios.get('https://x.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        },
        timeout: 20000
      });

      const html = homeRes.data;
      const bundleUrls = new Set();

      // Absolute bundle URLs (https://abs.twimg.com/responsive-web/client-web/...)
      (html.match(/https:\/\/[^"'<>\s]+?\.js/g) || []).forEach(u => {
        if (u.includes('client-web')) bundleUrls.add(u);
      });

      // Relative bundle URLs -> resolve against the CDN host
      (html.match(/\/[^"'<>\s]+?client-web[^"'<>\s]+?\.js/g) || []).forEach(rel => {
        bundleUrls.add('https://abs.twimg.com' + rel);
      });

      // Search the main bundle first (it almost always holds the tweet mutations)
      const ordered = [...bundleUrls].sort(
        (a, b) => Number(/main\./.test(b)) - Number(/main\./.test(a))
      );

      for (const url of ordered.slice(0, 40)) {
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
          // bundle unreachable or timed out -> try the next one
        }
      }
      console.warn('[GraphQL] CreateTweet queryId not found in any client bundle.');
    } catch (e) {
      console.warn('[GraphQL] Bundle scrape failed:', e.message);
    }
    return null;
  }

  /**
   * Upload video using tweet_video
   */
  async uploadMediaChunked(filePath, onProgress) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    // 1. INIT
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

    // 2. APPEND
    while (bytesUploaded < totalBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
      const chunk = buffer.slice(0, bytesRead);

      const form = new (require('form-data'))();
      form.append('command', 'APPEND');
      form.append('media_id', mediaId);
      form.append('segment_index', segmentIndex.toString());
      form.append('media', chunk, { filename: 'video.mp4', contentType: 'application/octet-stream' });

      await axios.post('https://upload.twitter.com/1.1/media/upload.json', form, {
        headers: {
          ...this.defaultHeaders,
          ...form.getHeaders()
        }
      });

      segmentIndex++;
      bytesUploaded += bytesRead;
      if (onProgress) {
        onProgress(Math.min(99, Math.round((bytesUploaded / totalBytes) * 100)));
      }
    }
    fs.closeSync(fd);

    // 3. FINALIZE
    const finalizeRes = await axios.post(
      'https://upload.twitter.com/1.1/media/upload.json',
      null,
      {
        params: { command: 'FINALIZE', media_id: mediaId },
        headers: this.defaultHeaders
      }
    );

    // 4. STATUS check
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
        throw new Error(processingInfo.error?.message || 'X failed to process video.');
      }
    }

    return mediaId;
  }

  /**
   * Save video to Ads Media Library
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;
    try {
      await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/media_library`,
        new URLSearchParams({
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        }).toString(),
        {
          headers: {
            ...this.defaultHeaders,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
    } catch (err) {
      console.warn('[Ads Library] Non-fatal: could not add to Ads Media Library:', err.message);
    }
  }

  /**
   * Publish Tweet with 800x800 square autoplay video via modern GraphQL
   */
  async postTweet(statusText, mediaId, websiteUrl, headline) {
    const formattedText = statusText
      ? `${statusText}\n\n${headline}\n${websiteUrl}`
      : `${headline}\n${websiteUrl}`;

    // 1. Try via agent-twitter-client first
    try {
      const { Scraper } = await import('agent-twitter-client');
      const scraper = new Scraper();
      await scraper.setCookies([
        `auth_token=${this.authToken}; Domain=.x.com; Path=/; Secure; HttpOnly`,
        `ct0=${this.ct0}; Domain=.x.com; Path=/; Secure`
      ]);

      const res = await scraper.sendTweet(formattedText);
      // Newer versions resolve with the parsed payload; older ones with a fetch Response
      const data = (res && typeof res.json === 'function')
        ? await res.json().catch(() => null)
        : res;
      const result = data?.data?.create_tweet?.tweet_results?.result;
      const postId = result?.rest_id || result?.tweet?.rest_id;
      if (postId) {
        return { success: true, postId };
      }
      console.warn('[agent-twitter-client] responded without a postId — falling back to direct GraphQL.');
    } catch (agentErr) {
      console.warn('[agent-twitter-client] attempt failed — falling back to direct GraphQL:', agentErr.message);
    }

    // 2. Direct GraphQL using a live-scraped queryId
    const queryId = await this.getLiveCreateTweetQueryId();
    if (!queryId) {
      throw new Error(
        'Could not resolve a live CreateTweet queryId from X client bundles. ' +
        'X has likely changed its frontend layout — re-scrape or update the client.'
      );
    }

    const graphqlPayload = {
      variables: {
        tweet_text: formattedText,
        media: {
          media_entities: [{ media_id: mediaId, tagged_users: [] }],
          possibly_sensitive: false
        },
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

    const gqlHeaders = {
      ...this.defaultHeaders,
      'Content-Type': 'application/json'
    };

    // X has been migrating GraphQL to api.x.com — try both hosts.
    let lastError = null;
    for (const host of ['https://api.x.com', 'https://x.com']) {
      const url = `${host}/i/api/graphql/${queryId}/CreateTweet`;
      try {
        const gqlRes = await axios.post(url, graphqlPayload, {
          headers: gqlHeaders,
          timeout: 30000
        });

        const result = gqlRes.data?.data?.create_tweet?.tweet_results?.result;
        const postId = result?.rest_id || result?.tweet?.rest_id;
        if (postId) {
          return { success: true, postId };
        }
        if (gqlRes.data?.errors?.length) {
          throw new Error(gqlRes.data.errors[0]?.message || 'GraphQL mutation returned errors.');
        }
        return { success: true, raw: gqlRes.data };
      } catch (e) {
        lastError = e;
        const status = e.response?.status;
        const body = JSON.stringify(e.response?.data || e.message).slice(0, 300);
        console.warn(`[GraphQL] CreateTweet via ${host} failed: HTTP ${status || 'n/a'} — ${body}`);
        // A real auth/validation failure won't be fixed by switching hosts; stop early.
        if (status && status !== 404) break;
      }
    }

    const status = lastError?.response?.status;
    const body = JSON.stringify(lastError?.response?.data ?? lastError?.message ?? '').slice(0, 300);
    const err = new Error(`CreateTweet failed (HTTP ${status || 'network'}): ${body} [queryId=${queryId}]`);
    err.response = lastError?.response; // preserve shape expected by the route handler
    throw err;
  }
}

module.exports = TwitterClient;
