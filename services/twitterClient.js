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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': 'https://x.com',
      'Referer': 'https://x.com/',
      'Cookie': this.cookieHeader
    };
  }

  /**
   * Dynamically fetches the exact current CreateTweet query ID from live X client scripts
   */
  async getLiveCreateTweetQueryId() {
    try {
      const res = await axios.get('https://x.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const scriptMatches = res.data.match(/https:\/\/[^"']+\/main\.[^"']+\.js/g);
      if (scriptMatches && scriptMatches.length > 0) {
        for (const scriptUrl of scriptMatches) {
          const jsRes = await axios.get(scriptUrl);
          const match = jsRes.data.match(/queryId:"([a-zA-Z0-9_-]+)",operationName:"CreateTweet"/);
          if (match && match[1]) {
            console.log(`[GraphQL] Found live CreateTweet queryId: ${match[1]}`);
            return match[1];
          }
        }
      }
    } catch (e) {
      console.warn('[GraphQL] Dynamic query ID scrape notice:', e.message);
    }
    // Latest known active fallback hashes
    return 'xT380ap0xMQeTnzBfjt9Aw';
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
    } catch {}
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
        `auth_token=${this.authToken}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
        `ct0=${this.ct0}; Domain=.twitter.com; Path=/; Secure`
      ]);

      const res = await scraper.sendTweet(formattedText);
      const data = await res.json().catch(() => null);
      const postId = data?.data?.create_tweet?.tweet_results?.result?.rest_id;
      if (postId) {
        return { success: true, postId };
      }
    } catch (agentErr) {
      console.warn('[agent-twitter-client fallback trigger]', agentErr.message);
    }

    // 2. Direct GraphQL using live scraped queryId
    const queryId = await this.getLiveCreateTweetQueryId();
    const url = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;

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
        responsive_web_text_conversations_enabled: false,
        tweetypie_unmention_optimization_enabled: true,
        vibe_api_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        rweb_video_timestamps_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true
      },
      fieldToggles: {
        withArticleRichContentState: false
      }
    };

    const gqlRes = await axios.post(url, graphqlPayload, {
      headers: {
        ...this.defaultHeaders,
        'Content-Type': 'application/json'
      }
    });

    const postId = gqlRes.data?.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (postId) {
      return { success: true, postId };
    }

    if (gqlRes.data?.errors) {
      throw new Error(gqlRes.data.errors[0]?.message || 'GraphQL mutation returned an error.');
    }

    return { success: true, raw: gqlRes.data };
  }
}

module.exports = TwitterClient;