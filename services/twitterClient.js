const axios = require('axios');
const fs = require('fs');
const querystring = require('querystring');

// Active Twitter Web GraphQL Query IDs for CreateTweet
const CREATE_TWEET_QUERY_IDS = [
  'a1p9RWpkYKBjWv_I3WzS-A',
  '5V_dkq1kcR8zyTUhRB4RhA',
  'xT380ap0xMQeTnzBfjt9Aw',
  'tQ4GnhUfqd1F8k0u1k7e7Q',
  'SoVnRxHkVoiZ2-q371Bs4w'
];

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
      'Cookie': this.cookieHeader
    };
  }

  /**
   * Upload video via Twitter Chunked Media Upload
   */
  async uploadMediaChunked(filePath, onProgress) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    // 1. INIT with tweet_video
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

    // 4. STATUS check (Wait for transcode completion)
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
   * Save video to Ads Media Library
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;
    try {
      await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/media_library`,
        querystring.stringify({
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        }),
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
   * Create the Video Website Card URI
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    const cardData = {
      "twitter:card": "video_website",
      "twitter:api:api:endpoint": "1",
      "twitter:title": headline,
      "twitter:website_url": websiteUrl,
      "twitter:video:id": mediaId
    };

    try {
      const capsRes = await axios.post(
        'https://caps.twitter.com/v2/cards/create.json',
        querystring.stringify({ card_data: JSON.stringify(cardData) }),
        {
          headers: {
            ...this.defaultHeaders,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      if (capsRes.data?.card_uri) {
        return capsRes.data.card_uri;
      }
    } catch (e) {
      console.warn('[CAPS Notice]', e.message);
    }

    return null;
  }

  /**
   * Post organic tweet with Video Website Card
   * Iterates through active query IDs to prevent 404 Not Found
   */
  async postTweetWithCard(statusText, cardUri, mediaId, websiteUrl, headline) {
    const tweetText = statusText
      ? `${statusText}\n\n${headline}\n${websiteUrl}`
      : `${headline}\n${websiteUrl}`;

    const graphqlPayload = {
      variables: {
        tweet_text: tweetText,
        media: {
          media_entities: [{ media_id: mediaId, tagged_users: [] }],
          possibly_sensitive: false
        },
        nullcast: false
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
        rweb_video_timestamps_enabled: true
      }
    };

    if (cardUri) {
      graphqlPayload.variables.card_uri = cardUri;
    }

    let lastError = null;

    // Try each active queryId until one succeeds
    for (const qId of CREATE_TWEET_QUERY_IDS) {
      try {
        const url = `https://x.com/i/api/graphql/${qId}/CreateTweet`;
        const res = await axios.post(url, graphqlPayload, {
          headers: {
            ...this.defaultHeaders,
            'Content-Type': 'application/json'
          }
        });

        if (res.data?.data?.create_tweet || res.data?.data?.create_tweet_v2) {
          return res.data;
        }
      } catch (err) {
        lastError = err;
        // If 404, continue to next queryId in the pool
        if (err.response?.status === 404) {
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('Could not publish tweet to X timeline.');
  }
}

module.exports = TwitterClient;