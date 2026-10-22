const axios = require('axios');
const fs = require('fs');

class TwitterClient {
  constructor(authToken, ct0, adsAccountId = null) {
    this.authToken = authToken;
    this.ct0 = ct0;
    this.adsAccountId = adsAccountId;
    this.cookieHeader = `auth_token=${this.authToken}; ct0=${this.ct0};`;

    this.defaultHeaders = {
      'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA', // Standard Twitter Web Client Bearer
      'x-csrf-token': this.ct0,
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cookie': this.cookieHeader
    };
  }

  /**
   * Uploads MP4 video using Twitter Chunked Media Upload (INIT -> APPEND -> FINALIZE -> STATUS)
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
          media_category: 'amplify_video' // Required for Amplify/Ads Media Library
        },
        headers: this.defaultHeaders
      }
    );

    const mediaId = initRes.data.media_id_string;
    const chunkSize = 4 * 1024 * 1024; // 4MB chunks
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
      form.append('media', chunk, { filename: 'blob', contentType: 'application/octet-stream' });

      await axios.post('https://upload.twitter.com/1.1/media/upload.json', form, {
        headers: {
          ...this.defaultHeaders,
          ...form.getHeaders()
        }
      });

      segmentIndex++;
      bytesUploaded += bytesRead;
      if (onProgress) {
        const percent = Math.min(99, Math.round((bytesUploaded / totalBytes) * 100));
        onProgress(percent);
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

    // 4. CHECK STATUS (Transcoding)
    let processingInfo = finalizeRes.data.processing_info;
    while (processingInfo && (processingInfo.state === 'pending' || processingInfo.state === 'in_progress')) {
      const checkAfterSecs = (processingInfo.check_after_secs || 1) * 1000;
      await new Promise(r => setTimeout(r, checkAfterSecs));

      const statusRes = await axios.get('https://upload.twitter.com/1.1/media/upload.json', {
        params: {
          command: 'STATUS',
          media_id: mediaId
        },
        headers: this.defaultHeaders
      });

      processingInfo = statusRes.data.processing_info;
      if (processingInfo && processingInfo.state === 'failed') {
        throw new Error(processingInfo.error ? processingInfo.error.message : 'X video transcoding failed');
      }
    }

    return mediaId;
  }

  /**
   * Adds the video to the account's X Ads Media Library
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
    } catch (e) {
      // If direct Ads endpoint fails, fallback to internal metadata tagging
      try {
        await axios.post(
          'https://upload.twitter.com/1.1/media/metadata/create.json',
          {
            media_id: mediaId,
            alt_text: { text: title }
          },
          { headers: this.defaultHeaders }
        );
      } catch (err) {
        console.warn('Metadata assignment notice:', err.message);
      }
    }
  }

  /**
   * Creates the Video Website Card returning card_uri (e.g., "card://1892837492837492834")
   */
  async createVideoWebsiteCard(mediaId, websiteUrl, headline) {
    // Twitter Card Platform Endpoint (CAPS v2)
    const payload = {
      card_data: JSON.stringify({
        "twitter:card": "video_website",
        "twitter:api:api:endpoint": "1",
        "twitter:title": headline,
        "twitter:website_url": websiteUrl,
        "twitter:player:stream_content_type": "video/mp4",
        "twitter:player": mediaId
      })
    };

    const res = await axios.post('https://caps.twitter.com/v2/cards/create.json', null, {
      params: payload,
      headers: this.defaultHeaders
    });

    if (res.data && res.data.card_uri) {
      return res.data.card_uri;
    }

    throw new Error('Could not generate card URI from Twitter');
  }

  /**
   * Posts the tweet with the attached card_uri (causing autoplay and the website card view)
   */
  async postTweetWithCard(statusText, cardUri) {
    // Internal GraphQL Tweet creation endpoint
    const queryId = 'SoVnRxHkVoiZ2-q371Bs4w'; // CreateTweet mutation query ID
    const url = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;

    const body = {
      variables: {
        tweet_text: statusText,
        card_uri: cardUri,
        nullcast: false
      },
      features: {
        interactive_text: true,
        responsive_web_text_conversations_enabled: false,
        tweetypie_unmention_optimization_enabled: true,
        vibe_api_enabled: true
      }
    };

    const res = await axios.post(url, body, { headers: this.defaultHeaders });
    return res.data;
  }
}

module.exports = TwitterClient;