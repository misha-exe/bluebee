// services/db.js - Resilient database adapter for Upstash / Vercel KV
const crypto = require('crypto');

const POSTS_KEY = 'bluebee_post_history';
const MAX_POST_HISTORY = 1000;   // oldest entries drop off beyond this (keeps the single KV value small)
let localPostHistory = [];

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

  /* ---------- Post history (one entry per publish attempt) ---------- */

  // Unlike the media helpers, KV failures THROW here: a failed read must never be followed by a write
  // of an empty list, which would wipe the saved history.
  async _readPostHistory() {
    if (this.kvUrl && this.kvToken) {
      const res = await fetch(`${this.kvUrl}/get/${POSTS_KEY}`, {
        headers: { Authorization: `Bearer ${this.kvToken}` }
      });
      if (!res.ok) throw new Error(`KV read failed (${res.status})`);
      const data = await res.json();
      let parsed = data && data.result;
      if (parsed == null) return [];
      while (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { break; }
      }
      return Array.isArray(parsed) ? parsed : [];
    }
    return localPostHistory;
  }

  async _writePostHistory(list) {
    localPostHistory = list;
    if (this.kvUrl && this.kvToken) {
      const res = await fetch(`${this.kvUrl}/set/${POSTS_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.kvToken}` },
        body: JSON.stringify(list)
      });
      if (!res.ok) throw new Error(`KV write failed (${res.status})`);
    }
  }

  async addPost(entry) {
    const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
    const published = entry.status === 'published';
    const record = {
      id: crypto.randomUUID(),
      status: published ? 'published' : 'failed',
      headline: clip(entry.headline, 200),
      postText: clip(entry.postText, 500),
      websiteUrl: clip(entry.websiteUrl, 2000),
      mediaId: clip(entry.mediaId, 40),
      accountLabel: clip(entry.accountLabel, 60),
      postId: published && entry.postId ? clip(entry.postId, 40) : null,
      postUrl: published && entry.postUrl ? clip(entry.postUrl, 200) : null,
      error: published ? null : clip(entry.error, 500),
      createdAt: new Date().toISOString()
    };
    const list = await this._readPostHistory();
    await this._writePostHistory([record, ...list].slice(0, MAX_POST_HISTORY));
    return record;
  }

  /** All entries, newest first. */
  async getPostHistory() {
    return this._readPostHistory();
  }

  /** Stats over ALL history + the most recent entries for the dashboard. tzOffsetMinutes = JS getTimezoneOffset(). */
  async getPostSummary(tzOffsetMinutes = 0, recentLimit = 30) {
    const all = await this._readPostHistory();
    const dayKey = (ms) => new Date(ms - tzOffsetMinutes * 60000).toISOString().slice(0, 10);
    const today = dayKey(Date.now());

    let todayPublished = 0, totalPublished = 0, failed = 0;
    for (const p of all) {
      if (p.status === 'published') {
        totalPublished++;
        if (dayKey(new Date(p.createdAt).getTime()) === today) todayPublished++;
      } else {
        failed++;
      }
    }
    return { stats: { todayPublished, totalPublished, failed, total: all.length }, recent: all.slice(0, recentLimit) };
  }

  async deletePost(id) {
    const list = await this._readPostHistory();
    const next = list.filter((p) => p.id !== id);
    if (next.length === list.length) return false;
    await this._writePostHistory(next);
    return true;
  }

  async clearPostHistory() {
    const list = await this._readPostHistory();
    await this._writePostHistory([]);
    return list.length;
  }
}

module.exports = new Database();
