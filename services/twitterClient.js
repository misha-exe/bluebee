const axios = require('axios');
const fs = require('fs');
const querystring = require('querystring');

class TwitterClient {
  constructor(authToken, ct0, adsAccountId) {
    this.authToken = authToken;
    this.ct0 = ct0;
    // Clean account ID: strips anything non-alphanumeric (e.g. "18ce55xmjw6")
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
   * Fetch Media Library directly from X Ads
   */
  async fetchMediaLibrary() {
    if (!this.adsAccountId) return [];

    try {
      const res = await axios.get(
        `https://ads.x.com/api/1/accounts/${this.adsAccountId}/media_library`,
        {
          params: { media_category: 'AMPLIFY_VIDEO', count: 30 },
          headers: this.defaultHeaders
        }
      );

      const items = res.data?.data || [];
      return items.map(item => ({
        id: item.media_id,
        mediaId: item.media_id,
        name: item.name || `${item.media_id}.mp4`,
        thumbnail: item.media_url || item.thumbnail_url || 'https://abs.twimg.com/sticky/default_profile_images/default_profile.png',
        meta: item.aspect_ratio ? `${item.aspect_ratio} · Ads Video` : 'Square · Amplify Video'
      }));
    } catch (err) {
      console.warn('[Media Library] Could not fetch remote library from X:', err.response?.data || err.message);
      return [];
    }
  }

  /**
   * Upload video via chunked upload
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
          media_category: 'amplify_video'
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
      form.append('media', chunk, { filename: 'blob.mp4', contentType: 'application/octet-stream' });

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
        throw new Error(processingInfo.error?.message || 'X transcoding failed');
      }
    }

    return mediaId;
  }

  /**
   * Permanently save video in Ads Media Library
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;
    try {
      await axios.post(
        `https://ads.x.com/api/1/accounts/${this.adsAccountId}/media_library`,
        {
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        },
        { headers: this.defaultHeaders }
      );
    } catch (err) {
      console.warn('[Ads Library Notice]', err.response?.data || err.message);
    }
  }

  /**
   * Create the Video Website Card
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    // Try via Ads Account Card endpoint
    try {
      const res = await axios.post(
        `https://ads.x.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
        querystring.stringify({
          name: headline,
          video_id: mediaId,
          website_url: websiteUrl,
          website_title: headline
        }),
        {
          headers: {
            ...this.defaultHeaders,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const cardUri = res.data?.data?.card_uri || res.data?.card_uri;
      if (cardUri) return cardUri;
    } catch (err) {
      console.warn('[Ads Card failed, attempting CAPS platform fallback]', err.response?.data || err.message);
    }

    // Fallback: Twitter CAPS endpoint
    const cardData = {
      "twitter:card": "video_website",
      "twitter:api:api:endpoint": "1",
      "twitter:title": headline,
      "twitter:website_url": websiteUrl,
      "twitter:player:stream_content_type": "video/mp4",
      "twitter:player": mediaId
    };

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

    throw new Error('Could not generate Video Website Card URI');
  }

  /**
   * Publish Organic Tweet with Card
   */
  async postTweetWithCard(statusText, cardUri) {
    // Direct Ads Organic Tweet Endpoint (nullcast: false creates public tweet)
    const payload = {
      text: statusText,
      card_uri: cardUri,
      nullcast: false
    };

    const res = await axios.post(
      `https://ads.x.com/api/1/accounts/${this.adsAccountId}/tweet`,
      payload,
      { headers: this.defaultHeaders }
    );

    return res.data;
  }
}

module.exports = TwitterClient;