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
      'Cookie': this.cookieHeader,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Safely loads agent-twitter-client via dynamic import to prevent ERR_REQUIRE_ESM crash
   */
  async getAgentScraper() {
    try {
      const { Scraper } = await import('agent-twitter-client');
      const scraper = new Scraper();
      await scraper.setCookies([
        `auth_token=${this.authToken}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
        `ct0=${this.ct0}; Domain=.twitter.com; Path=/; Secure`
      ]);
      return scraper;
    } catch (err) {
      console.warn('[agent-twitter-client load notice]', err.message);
      return null;
    }
  }

  /**
   * Upload video via Twitter Chunked Media Upload
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
    // 1. Primary: Ads Manager Web API
    try {
      const adsRes = await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/cards/video_website`,
        {
          name: headline,
          video_id: mediaId,
          website_url: websiteUrl,
          website_title: headline
        },
        { headers: this.defaultHeaders }
      );

      const cardUri = adsRes.data?.data?.card_uri || adsRes.data?.card_uri;
      if (cardUri) return cardUri;
    } catch (adsErr) {
      console.warn('[Ads Card endpoint notice]', adsErr.response?.data || adsErr.message);
    }

    // 2. Secondary: CAPS platform with complete 800x800 dimensions
    try {
      const cardData = {
        "twitter:card": "video_website",
        "twitter:api:api:endpoint": "1",
        "twitter:title": headline,
        "twitter:website_url": websiteUrl,
        "twitter:player": mediaId,
        "twitter:player:width": 800,
        "twitter:player:height": 800,
        "twitter:player:stream_content_type": "video/mp4"
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
    } catch (capsErr) {
      console.warn('[CAPS endpoint notice]', capsErr.response?.data || capsErr.message);
    }

    throw new Error('Unable to generate Video Website Card URI from X.');
  }

  /**
   * Posts Tweet with attached card_uri
   */
  async postTweetWithCard(statusText, cardUri) {
    // 1. Primary: Ads Account Organic Tweet endpoint
    try {
      const res = await axios.post(
        `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/tweet`,
        {
          as_user_id: null,
          text: statusText,
          card_uri: cardUri,
          nullcast: false
        },
        { headers: this.defaultHeaders }
      );
      return res.data;
    } catch (adsErr) {
      console.warn('[Ads Tweet endpoint notice, attempting GraphQL mutation]', adsErr.response?.data || adsErr.message);
    }

    // 2. Fallback: agent-twitter-client or GraphQL CreateTweet
    const scraper = await this.getAgentScraper();
    if (scraper) {
      try {
        const result = await scraper.sendTweet(statusText ? `${statusText} ${cardUri}` : cardUri);
        return result;
      } catch (agentErr) {
        console.warn('[agent-twitter-client sendTweet notice]', agentErr.message);
      }
    }

    // 3. Fallback: Direct GraphQL CreateTweet mutation
    const queryId = 'SoVnRxHkVoiZ2-q371Bs4w';
    const graphqlUrl = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;

    const graphqlPayload = {
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

    const gqlRes = await axios.post(graphqlUrl, graphqlPayload, { headers: this.defaultHeaders });
    return gqlRes.data;
  }
}

module.exports = TwitterClient;