const axios = require('axios');
const fs = require('fs');
const querystring = require('querystring');

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
   * Save video to Ads Media Library (Required before card creation)
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;

    const adsHeaders = {
      ...this.defaultHeaders,
      'Origin': 'https://ads.twitter.com',
      'Referer': 'https://ads.twitter.com/'
    };

    // Try JSON
    try {
      await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/media_library`,
        {
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        },
        { headers: { ...adsHeaders, 'Content-Type': 'application/json' } }
      );
      console.log(`[Media Library] Successfully registered media ${mediaId} via JSON.`);
      return;
    } catch (errJson) {
      console.warn('[Media Library JSON Notice]', errJson.response?.data || errJson.message);
    }

    // Try form-encoded
    try {
      await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/media_library`,
        querystring.stringify({
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        }),
        { headers: { ...adsHeaders, 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      console.log(`[Media Library] Successfully registered media ${mediaId} via Form.`);
    } catch (errForm) {
      console.warn('[Media Library Form Notice]', errForm.response?.data || errForm.message);
    }
  }

  /**
   * Step 1: Create Video Website Card URI
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    const errorLogs = [];

    // Attempt 1: Twitter Card Platform (CAPS) with full card payload
    const capsEndpoints = [
      'https://caps.twitter.com/v2/cards/create.json',
      'https://caps.x.com/v2/cards/create.json'
    ];

    const cardPayloads = [
      {
        "twitter:card": "video_website",
        "twitter:api:api:endpoint": "1",
        "twitter:title": headline,
        "twitter:website_url": websiteUrl,
        "twitter:player": mediaId,
        "twitter:player:width": 800,
        "twitter:player:height": 800,
        "twitter:player:stream_content_type": "video/mp4"
      },
      {
        "twitter:card": "promo_video_website",
        "twitter:api:api:endpoint": "1",
        "twitter:title": headline,
        "twitter:website_url": websiteUrl,
        "twitter:player": mediaId,
        "twitter:player:width": 800,
        "twitter:player:height": 800,
        "twitter:player:stream_content_type": "video/mp4"
      }
    ];

    for (const endpoint of capsEndpoints) {
      for (const cardData of cardPayloads) {
        try {
          const res = await axios.post(
            endpoint,
            querystring.stringify({ card_data: JSON.stringify(cardData) }),
            {
              headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );

          if (res.data?.card_uri) {
            return res.data.card_uri;
          }
        } catch (err) {
          const msg = err.response?.data?.errors?.[0]?.message || err.message;
          errorLogs.push(`${endpoint} (${cardData["twitter:card"]}): ${msg}`);
        }
      }
    }

    // Attempt 2: Ads Manager Card API
    if (this.adsAccountId) {
      const adsUrls = [
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
        `https://ads.x.com/api/1/accounts/${this.adsAccountId}/cards/video_website`
      ];

      const adsHeaders = {
        ...this.defaultHeaders,
        'Origin': 'https://ads.twitter.com',
        'Referer': 'https://ads.twitter.com/'
      };

      for (const url of adsUrls) {
        // Form encoded
        try {
          const adsRes = await axios.post(
            url,
            querystring.stringify({
              name: headline,
              video_id: mediaId,
              website_url: websiteUrl,
              website_title: headline
            }),
            {
              headers: {
                ...adsHeaders,
                'Content-Type': 'application/x-www-form-urlencoded'
              }
            }
          );

          const cardUri = adsRes.data?.data?.card_uri || adsRes.data?.card_uri;
          if (cardUri) return cardUri;
        } catch (err) {
          const msg = err.response?.data?.errors?.[0]?.message || err.response?.data?.error || err.message;
          errorLogs.push(`Ads API (${url}): ${msg}`);
        }

        // JSON
        try {
          const adsJsonRes = await axios.post(
            url,
            {
              name: headline,
              video_id: mediaId,
              website_url: websiteUrl,
              website_title: headline
            },
            {
              headers: {
                ...adsHeaders,
                'Content-Type': 'application/json'
              }
            }
          );

          const cardUri = adsJsonRes.data?.data?.card_uri || adsJsonRes.data?.card_uri;
          if (cardUri) return cardUri;
        } catch (err) {
          const msg = err.response?.data?.errors?.[0]?.message || err.response?.data?.error || err.message;
          errorLogs.push(`Ads API JSON (${url}): ${msg}`);
        }
      }
    }

    throw new Error(errorLogs.join(' | '));
  }

  /**
   * Step 2: Post organic tweet with card_uri using X Web session
   */
  async postTweetWithCard(statusText, cardUri) {
    const postBody = querystring.stringify({
      status: statusText || '',
      card_uri: cardUri
    });

    const endpoints = [
      'https://twitter.com/i/api/1.1/statuses/update.json',
      'https://x.com/i/api/1.1/statuses/update.json'
    ];

    let lastErr = null;

    for (const url of endpoints) {
      try {
        const res = await axios.post(url, postBody, {
          headers: {
            ...this.defaultHeaders,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        if (res.data?.id_str || res.data?.id) {
          return {
            success: true,
            postId: res.data.id_str || res.data.id
          };
        }
      } catch (err) {
        lastErr = err;
        if (err.response?.data?.errors) {
          break;
        }
      }
    }

    throw lastErr;
  }
}

module.exports = TwitterClient;