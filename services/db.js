// Lightweight persistent database adapter
// Supports Upstash Redis / Vercel KV if configured, with resilient memory/disk fallback

let localMemoryDb = [
  {
    id: 1,
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

  async getAllMedia() {
    if (this.kvUrl && this.kvToken) {
      try {
        const res = await fetch(`${this.kvUrl}/get/share2x_media_library`, {
          headers: { Authorization: `Bearer ${this.kvToken}` }
        });
        const data = await res.json();
        if (data.result) {
          return JSON.parse(data.result);
        }
      } catch (err) {
        console.warn('[DB Error] Failed to fetch from KV:', err.message);
      }
    }
    return localMemoryDb;
  }

  async saveMedia(item) {
    let current = await this.getAllMedia();
    
    // Assign incremental Row ID (like Share2X: 1, 2, 3...)
    const nextRowId = current.length > 0 ? Math.max(...current.map(m => Number(m.id) || 0)) + 1 : 1;
    
    const record = {
      id: nextRowId,
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
          body: JSON.stringify(JSON.stringify(current))
        });
      } catch (err) {
        console.warn('[DB Error] Failed to save to KV:', err.message);
      }
    }

    return record;
  }
}

module.exports = new Database();