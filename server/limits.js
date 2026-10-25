/**
 * In-memory abuse limits: per-visitor rate limit, a concurrency gate and a short
 * result cache. Nothing is written to disk; restarting the service clears it all.
 */

export class RateLimiter {
  constructor({ perHour = 10, perDay = 30, now = () => Date.now() } = {}) {
    this.perHour = perHour;
    this.perDay = perDay;
    this.now = now;
    this.hits = new Map();
  }

  /** Returns { ok: true } and records the hit, or { ok: false, retryAfter } (seconds). */
  take(key) {
    const t = this.now();
    const day = 24 * 3600e3;
    const hour = 3600e3;
    const list = (this.hits.get(key) || []).filter((x) => t - x < day);
    const lastHour = list.filter((x) => t - x < hour);
    if (lastHour.length >= this.perHour) {
      this.hits.set(key, list);
      return { ok: false, scope: 'hour', retryAfter: Math.ceil((lastHour[0] + hour - t) / 1000) };
    }
    if (list.length >= this.perDay) {
      this.hits.set(key, list);
      return { ok: false, scope: 'day', retryAfter: Math.ceil((list[0] + day - t) / 1000) };
    }
    list.push(t);
    this.hits.set(key, list);
    return { ok: true, remainingHour: this.perHour - lastHour.length - 1 };
  }

  prune() {
    const t = this.now();
    for (const [k, v] of this.hits) {
      const keep = v.filter((x) => t - x < 24 * 3600e3);
      if (keep.length) this.hits.set(k, keep);
      else this.hits.delete(k);
    }
  }
}

/** Lets `max` jobs run at once; others wait up to `waitMs`, then get rejected. */
export class Gate {
  constructor(max = 3, waitMs = 20000) {
    this.max = max;
    this.waitMs = waitMs;
    this.active = 0;
    this.queue = [];
  }

  async run(job) {
    if (this.active >= this.max) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: setTimeout(() => {
          this.queue.splice(this.queue.indexOf(entry), 1);
          reject(Object.assign(new Error('busy'), { code: 'busy' }));
        }, this.waitMs) };
        this.queue.push(entry);
      });
    }
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); }
    }
  }
}

export class TtlCache {
  constructor(ttlMs = 10 * 60e3, maxEntries = 500, now = () => Date.now()) {
    this.ttl = ttlMs;
    this.max = maxEntries;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.t > this.ttl) { this.map.delete(key); return undefined; }
    return e.v;
  }

  set(key, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { t: this.now(), v });
  }
}
