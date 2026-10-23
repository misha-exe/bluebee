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
      'Cookie': this.cookieHeader,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Upload video via Twitter Chunked Upload
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

    // 4. STATUS check (Ensure video transcode is complete before card creation)
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
   * Save video into Ads Media Library
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;
    try {
      await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/media_library`,
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
   * Create the Video Website Card using pure JSON
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    const payload = {
      name: headline,
      video_id: mediaId,
      website_url: websiteUrl,
      website_title: headline
    };

    // Primary: Ads Manager Web API (api/1)
    try {
      const res = await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
        payload,
        { headers: this.defaultHeaders }
      );

      const cardUri = res.data?.data?.card_uri || res.data?.card_uri;
      if (cardUri) return cardUri;
    } catch (api1Err) {
      console.warn('[Ads API 1 Failed, trying API 12]', api1Err.response?.data || api1Err.message);
    }

    // Secondary: Ads API v12
    try {
      const res12 = await axios.post(
        `https://ads-api.twitter.com/12/accounts/${this.adsAccountId}/cards/video_website`,
        payload,
        { headers: this.defaultHeaders }
      );

      const cardUri12 = res12.data?.data?.card_uri || res12.data?.card_uri;
      if (cardUri12) return cardUri12;
    } catch (api12Err) {
      console.error('[Ads API 12 Error]', api12Err.response?.data || api12Err.message);
      throw api12Err;
    }

    throw new Error('Could not create Video Website Card on X Ads Account.');
  }

  /**
   * Post organic tweet with card_uri (nullcast: false makes it public on timeline)
   */
  async postTweetWithCard(statusText, cardUri) {
    const payload = {
      as_user_id: null,
      text: statusText,
      card_uri: cardUri,
      nullcast: false
    };

    const res = await axios.post(
      `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/tweet`,
      payload,
      { headers: this.defaultHeaders }
    );

    return res.data;
  }
}

module.exports = TwitterClient;