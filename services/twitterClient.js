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
      'Cookie': this.cookieHeader
    };
  }

  /**
   * Initializes agent-twitter-client with cookies
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
      console.warn('[agent-twitter-client init]', err.message);
      return null;
    }
  }

  /**
   * Upload video using tweet_video (Allowed for cards and timeline autoplay)
   */
  async uploadMediaChunked(filePath, onProgress) {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;

    // 1. INIT - tweet_video avoids the 131 Amplify restriction
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
    // Attempt via CAPS with tweet_video
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
      console.warn('[CAPS Notice]', e.response?.data || e.message);
    }

    return null; // Return null so publisher uses direct card-tweet engine
  }

  /**
   * Post organic tweet with Video Website Card
   * Uses card_uri if available; otherwise uses agent-twitter-client with native video attachment
   */
  async postTweetWithCard(statusText, cardUri, mediaId, websiteUrl, headline) {
    // 1. If cardUri was generated, post via Ads Organic Tweet or GraphQL
    if (cardUri) {
      try {
        const adsRes = await axios.post(
          `https://ads.twitter.com/api/1/accounts/${this.adsAccountId}/tweet`,
          querystring.stringify({
            as_user_id: null,
            text: statusText || '',
            card_uri: cardUri,
            nullcast: false
          }),
          {
            headers: {
              ...this.defaultHeaders,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        return adsRes.data;
      } catch (err) {
        console.warn('[Ads Tweet endpoint notice]', err.message);
      }
    }

    // 2. Direct GraphQL / agent-twitter-client posting
    // Injects the 800x800 square video with autoplay and attaches the destination card
    const queryId = 'SoVnRxHkVoiZ2-q371Bs4w';
    const graphqlUrl = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;

    const tweetText = statusText 
      ? `${statusText}\n\n${headline}\n${websiteUrl}` 
      : `${headline}\n${websiteUrl}`;

    const graphqlPayload = {
      variables: {
        tweet_text: tweetText,
        media: {
          media_entities: [{ media_id: mediaId }],
          possibly_sensitive: false
        },
        nullcast: false
      },
      features: {
        interactive_text: true,
        responsive_web_text_conversations_enabled: false,
        tweetypie_unmention_optimization_enabled: true,
        vibe_api_enabled: true
      }
    };

    if (cardUri) {
      graphqlPayload.variables.card_uri = cardUri;
    }

    try {
      const gqlRes = await axios.post(graphqlUrl, graphqlPayload, {
        headers: {
          ...this.defaultHeaders,
          'Content-Type': 'application/json'
        }
      });
      return gqlRes.data;
    } catch (gqlErr) {
      // 3. Fallback to agent-twitter-client
      const scraper = await this.getAgentScraper();
      if (scraper) {
        return await scraper.sendTweet(tweetText);
      }
      throw gqlErr;
    }
  }
}

module.exports = TwitterClient;