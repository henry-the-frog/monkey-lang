// ===== Rate Limiter =====

// ===== Token Bucket =====
// Allows bursts up to capacity, refills at steady rate

export class TokenBucket {
  constructor(capacity, refillRate, refillIntervalMs = 1000) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate; // tokens per interval
    this.refillIntervalMs = refillIntervalMs;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / this.refillIntervalMs) * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  tryConsume(tokens = 1) {
    this._refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { allowed: true, remaining: Math.floor(this.tokens) };
    }
    const waitMs = ((tokens - this.tokens) / this.refillRate) * this.refillIntervalMs;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(waitMs) };
  }

  get available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ===== Fixed Window =====
// Count requests in fixed time windows

export class FixedWindow {
  constructor(maxRequests, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.windows = new Map(); // key → { count, start }
  }

  tryConsume(key = 'default') {
    const now = Date.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    
    let window = this.windows.get(key);
    if (!window || window.start !== windowStart) {
      window = { count: 0, start: windowStart };
      this.windows.set(key, window);
    }
    
    if (window.count < this.maxRequests) {
      window.count++;
      return { allowed: true, remaining: this.maxRequests - window.count };
    }
    
    const resetMs = windowStart + this.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: resetMs };
  }

  getCount(key = 'default') {
    const now = Date.now();
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const window = this.windows.get(key);
    if (!window || window.start !== windowStart) return 0;
    return window.count;
  }
}

// ===== Sliding Window Log =====
// Tracks individual timestamps, most accurate

export class SlidingWindowLog {
  constructor(maxRequests, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.logs = new Map(); // key → [timestamps]
  }

  tryConsume(key = 'default') {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    if (!this.logs.has(key)) this.logs.set(key, []);
    const log = this.logs.get(key);
    
    // Remove expired entries
    while (log.length > 0 && log[0] <= windowStart) log.shift();
    
    if (log.length < this.maxRequests) {
      log.push(now);
      return { allowed: true, remaining: this.maxRequests - log.length };
    }
    
    const oldestInWindow = log[0];
    const retryAfterMs = oldestInWindow + this.windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(retryAfterMs) };
  }

  getCount(key = 'default') {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const log = this.logs.get(key) || [];
    return log.filter(t => t > windowStart).length;
  }
}

// ===== Sliding Window Counter =====
// Weighted average of current and previous window (approximate but efficient)

export class SlidingWindowCounter {
  constructor(maxRequests, windowMs = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.windows = new Map(); // key → { prev, curr, prevStart, currStart }
  }

  _getWindow(key) {
    const now = Date.now();
    const currStart = Math.floor(now / this.windowMs) * this.windowMs;
    const prevStart = currStart - this.windowMs;
    
    let win = this.windows.get(key);
    if (!win) {
      win = { prev: 0, curr: 0, prevStart, currStart };
      this.windows.set(key, win);
    }
    
    // Advance windows
    if (win.currStart !== currStart) {
      if (win.currStart === prevStart) {
        win.prev = win.curr;
      } else {
        win.prev = 0;
      }
      win.curr = 0;
      win.prevStart = prevStart;
      win.currStart = currStart;
    }
    
    return win;
  }

  _estimate(key) {
    const now = Date.now();
    const win = this._getWindow(key);
    const elapsed = now - win.currStart;
    const weight = elapsed / this.windowMs;
    return win.prev * (1 - weight) + win.curr;
  }

  tryConsume(key = 'default') {
    const estimate = this._estimate(key);
    if (estimate < this.maxRequests) {
      this._getWindow(key).curr++;
      return { allowed: true, remaining: Math.floor(this.maxRequests - estimate - 1) };
    }
    return { allowed: false, remaining: 0 };
  }
}

export const SlidingWindow = SlidingWindowLog;

export class KeyedRateLimiter {
  constructor(factory) {
    this._factory = factory;
    this._limiters = new Map();
  }
  _get(key) {
    if (!this._limiters.has(key)) this._limiters.set(key, this._factory());
    return this._limiters.get(key);
  }
  tryConsume(key) { return this._get(key).tryConsume(); }
  reset(key) { this._limiters.delete(key); }
}
