// services/db.js - Resilient database adapter for Upstash / Vercel KV

let localMemoryDb = [
  {
    id: 1,
    accountId: "37",
    mediaId: "2104707817047224320",
    name: "59X2ZM5n0k8CFp5f.mp4",
    thumbnail: "https://pbs.twimg.com/amplify_video_thumb/2104707817047224320/img/Sk3kHH4uHdI8y-EU.jpg",
    meta: "Square · 800x800",
    createdAt: new Date().toISOString()
  }
];

class Database {
  constructor() {
    this.kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    this.kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  }

  async getAllMedia(accountId = null) {
    let allMedia = localMemoryDb;

    if (this.kvUrl && this.kvToken) {
      try {
        const res = await fetch(`${this.kvUrl}/get/share2x_media_library`, {
          headers: { Authorization: `Bearer ${this.kvToken}` }
        });
        const data = await res.json();
        if (data && data.result) {
          let parsed = data.result;
          // Safeguard against stringified or double-stringified JSON from Redis
          while (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch { break; }
          }
          if (Array.isArray(parsed)) {
            allMedia = parsed;
          }
        }
      } catch (err) {
        console.warn('[DB Error] Failed to read from KV:', err.message);
      }
    }

    if (!Array.isArray(allMedia)) allMedia = [];

    if (accountId) {
      return allMedia.filter(item => String(item.accountId) === String(accountId));
    }
    return allMedia;
  }

  async saveMedia(item) {
    let current = await this.getAllMedia();
    if (!Array.isArray(current)) current = [];

    const ids = current.map(m => Number(m.id)).filter(n => !isNaN(n));
    const nextRowId = ids.length > 0 ? Math.max(...ids) + 1 : 1;

    const record = {
      id: nextRowId,
      accountId: item.accountId || "37",
      mediaId: item.mediaId,
      name: item.name,
      thumbnail: item.thumbnail,
      meta: item.meta || "Square · 800x800",
      createdAt: new Date().toISOString()
    };

    current.unshift(record);
    localMemoryDb = current;

    if (this.kvUrl && this.kvToken) {
      try {
        await fetch(`${this.kvUrl}/set/share2x_media_library`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.kvToken}` },
          body: JSON.stringify(current) // Single serialization
        });
      } catch (err) {
        console.warn('[DB Error] Failed to save to KV:', err.message);
      }
    }

    return record;
  }
}

module.exports = new Database();