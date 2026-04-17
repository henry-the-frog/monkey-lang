import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, SlidingWindow, FixedWindow, KeyedRateLimiter } from '../src/index.js';

describe('TokenBucket', () => {
  it('allows requests within capacity', () => {
    const tb = new TokenBucket(5, 1, 1000);
    for (let i = 0; i < 5; i++) assert.equal(tb.tryConsume().allowed, true);
    assert.equal(tb.tryConsume().allowed, false);
  });
  it('reports available tokens', () => {
    const tb = new TokenBucket(3, 1, 1000);
    assert.equal(tb.available, 3);
    tb.tryConsume();
    assert.equal(tb.available, 2);
  });
  it('consumes multiple at once', () => {
    const tb = new TokenBucket(10, 1, 1000);
    assert.equal(tb.tryConsume(5).allowed, true);
    assert.equal(tb.tryConsume(6).allowed, false);
    assert.equal(tb.tryConsume(5).allowed, true);
  });
});

describe('SlidingWindow', () => {
  it('allows requests within window', () => {
    const sw = new SlidingWindow(3, 1000);
    assert.equal(sw.tryConsume().allowed, true);
    assert.equal(sw.tryConsume().allowed, true);
    assert.equal(sw.tryConsume().allowed, true);
    assert.equal(sw.tryConsume().allowed, false);
  });
  it('reports remaining', () => {
    const sw = new SlidingWindow(5, 1000);
    const r1 = sw.tryConsume();
    assert.equal(r1.remaining, 4);
  });
});

describe('FixedWindow', () => {
  it('allows requests within window', () => {
    const fw = new FixedWindow(2, 1000);
    assert.equal(fw.tryConsume().allowed, true);
    assert.equal(fw.tryConsume().allowed, true);
    assert.equal(fw.tryConsume().allowed, false);
  });
  it('reports remaining', () => {
    const fw = new FixedWindow(3, 1000);
    assert.equal(fw.tryConsume().remaining, 2);
  });
});

describe('KeyedRateLimiter', () => {
  it('per-key limiting', () => {
    const krl = new KeyedRateLimiter(() => new FixedWindow(2, 1000));
    assert.equal(krl.tryConsume('user1').allowed, true);
    assert.equal(krl.tryConsume('user1').allowed, true);
    assert.equal(krl.tryConsume('user1').allowed, false);
    assert.equal(krl.tryConsume('user2').allowed, true);
  });
  it('reset', () => {
    const krl = new KeyedRateLimiter(() => new FixedWindow(1, 1000));
    krl.tryConsume('x');
    assert.equal(krl.tryConsume('x').allowed, false);
    krl.reset('x');
    assert.equal(krl.tryConsume('x').allowed, true);
  });
});
