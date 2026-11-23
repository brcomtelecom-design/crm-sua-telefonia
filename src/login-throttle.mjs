import { createHash } from 'node:crypto';
import { HttpError } from './http.mjs';

export class LoginThrottle {
  constructor({
    maxFailures = 5,
    windowMs = 15 * 60 * 1000,
    blockMs = 15 * 60 * 1000,
    maxEntries = 10000,
  } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  keyFor(remoteAddress, email) {
    const normalized = String(email || '').trim().toLowerCase();
    return createHash('sha256')
      .update(`${String(remoteAddress || 'unknown')}\0${normalized}`)
      .digest('hex');
  }

  assertAllowed(key) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.blockedUntil && entry.blockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
      throw new HttpError(429, 'LOGIN_RATE_LIMITED', 'Muitas tentativas de login; aguarde antes de tentar novamente', { retryAfterSeconds });
    }
    if (entry.firstFailureAt && now - entry.firstFailureAt > this.windowMs) this.entries.delete(key);
  }

  recordFailure(key) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || now - entry.firstFailureAt > this.windowMs) {
      entry = { failures: 0, firstFailureAt: now, blockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
    this.cleanup();
  }

  recordSuccess(key) {
    this.entries.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      const expired = now - entry.firstFailureAt > this.windowMs && (!entry.blockedUntil || entry.blockedUntil <= now);
      if (expired) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }
}
