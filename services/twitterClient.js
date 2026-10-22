const axios = require('axios');
const fs = require('fs');
const querystring = require('querystring');

class TwitterClient {
  constructor(authToken, ct0, adsAccountId = null) {
    this.authToken = authToken;
    this.ct0 = ct0;
    this.adsAccountId = adsAccountId;
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
        params: {
          command: 'FINALIZE',
          media_id: mediaId
        },
        headers: this.defaultHeaders
      }
    );

    // 4. STATUS check (Wait until transcode finishes)
    let processingInfo = finalizeRes.data.processing_info;
    while (processingInfo && (processingInfo.state === 'pending' || processingInfo.state === 'in_progress')) {
      const waitTime = (processingInfo.check_after_secs || 2) * 1000;
      await new Promise(r => setTimeout(r, waitTime));

      const statusRes = await axios.get('https://upload.twitter.com/1.1/media/upload.json', {
        params: {
          command: 'STATUS',
          media_id: mediaId
        },
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
   * Add to Ads Media Library
   */
  async addToAdsMediaLibrary(mediaId, title) {
    if (!this.adsAccountId) return;
    try {
      await axios.post(
        `https://ads-api.twitter.com/12/accounts/${this.adsAccountId}/media_library`,
        {
          media_id: mediaId,
          name: title,
          media_type: 'VIDEO'
        },
        { headers: this.defaultHeaders }
      );
    } catch {
      // Non-fatal if account permissions already manage Amplify
    }
  }

  /**
   * Create the Video Website Card
   * Uses URL-encoded form data required by CAPS
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    const cardData = {
      "twitter:card": "video_website",
      "twitter:api:api:endpoint": "1",
      "twitter:title": headline,
      "twitter:website_url": websiteUrl,
      "twitter:player:stream_content_type": "video/mp4",
      "twitter:player": mediaId
    };

    const postBody = querystring.stringify({
      card_data: JSON.stringify(cardData)
    });

    try {
      // Primary: Twitter CAPS endpoint
      const res = await axios.post('https://caps.twitter.com/v2/cards/create.json', postBody, {
        headers: {
          ...this.defaultHeaders,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (res.data && res.data.card_uri) {
        return res.data.card_uri;
      }
    } catch (err) {
      // Fallback: Ads Manager Cards endpoint
      if (this.adsAccountId) {
        const adsRes = await axios.post(
          `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
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
        if (adsRes.data?.data?.card_uri) {
          return adsRes.data.data.card_uri;
        }
      }
      throw err;
    }
  }

  /**
   * Posts Tweet with attached card_uri
   */
  async postTweetWithCard(statusText, cardUri) {
    // Method 1: Standard REST update endpoint (Supports card_uri with session auth)
    try {
      const restBody = querystring.stringify({
        status: statusText,
        card_uri: cardUri
      });

      const res = await axios.post('https://twitter.com/i/api/1.1/statuses/update.json', restBody, {
        headers: {
          ...this.defaultHeaders,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      return res.data;
    } catch (restErr) {
      // Method 2: Ads account organic tweet endpoint fallback
      if (this.adsAccountId) {
        const adsTweetRes = await axios.post(
          `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/tweet`,
          {
            as_user_id: null,
            text: statusText,
            card_uri: cardUri,
            nullcast: false
          },
          { headers: this.defaultHeaders }
        );
        return adsTweetRes.data;
      }
      throw restErr;
    }
  }
}

module.exports = TwitterClient;