import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileAndRun } from './wasm-compiler.js';

describe('WASM Native Hash Map', () => {
  it('creates hash with integer keys', async () => {
    const result = await compileAndRun('let h = {1: 10, 2: 20, 3: 30}; h[2]');
    assert.equal(result, 20);
  });

  it('hash mutation with integer keys', async () => {
    const result = await compileAndRun(`
      let h = {1: 100, 2: 200};
      h[3] = 300;
      h[3]
    `);
    assert.equal(result, 300);
  });

  it('hash overwrite with integer keys', async () => {
    const result = await compileAndRun(`
      let h = {1: 10};
      h[1] = 99;
      h[1]
    `);
    assert.equal(result, 99);
  });

  it('hash missing key returns 0', async () => {
    const result = await compileAndRun(`
      let h = {1: 10, 2: 20};
      h[5]
    `);
    assert.equal(result, 0);
  });

  it('hash with computed integer keys', async () => {
    const result = await compileAndRun(`
      let h = {};
      for (let i = 0; i < 5; i = i + 1) {
        h[i] = i * i;
      }
      h[3]
    `);
    assert.equal(result, 9);
  });

  it('hash survives multiple insertions', async () => {
    const result = await compileAndRun(`
      let h = {};
      h[10] = 1;
      h[20] = 2;
      h[30] = 3;
      h[40] = 4;
      h[50] = 5;
      h[10] + h[20] + h[30] + h[40] + h[50]
    `);
    assert.equal(result, 15);
  });

  it('hash with negative keys', async () => {
    const result = await compileAndRun(`
      let h = {};
      h[0 - 1] = 42;
      h[0 - 1]
    `);
    assert.equal(result, 42);
  });

  it('hash in function', async () => {
    const result = await compileAndRun(`
      let make = fn() {
        let h = {1: 100, 2: 200};
        h
      };
      let m = make();
      m[1] + m[2]
    `);
    assert.equal(result, 300);
  });

  it('hash with string keys falls back to JS', async () => {
    const result = await compileAndRun(`
      let h = {"name": 42};
      h["name"]
    `);
    assert.equal(result, 42);
  });

  it('hash iteration pattern', async () => {
    const result = await compileAndRun(`
      let counts = {};
      let data = [1, 2, 1, 3, 2, 1];
      for (let i = 0; i < len(data); i = i + 1) {
        let key = data[i];
        counts[key] = counts[key] + 1;
      }
      counts[1]
    `);
    assert.equal(result, 3);
  });

  it('match with hash', async () => {
    const result = await compileAndRun(`
      let h = {1: 10, 2: 20};
      let v = h[1];
      match (v) {
        10 => 1
        20 => 2
        _ => 0
      }
    `);
    assert.equal(result, 1);
  });

  it('auto-resize handles more than initial capacity', async () => {
    // Initial capacity is 8, load factor 0.75 = threshold at 6 entries
    // Insert 20 entries to trigger multiple resizes
    const result = await compileAndRun(`
      let h = {};
      for (let i = 1; i <= 20; i = i + 1) {
        h[i] = i * 10;
      }
      h[1] + h[10] + h[20]
    `);
    assert.equal(result, 10 + 100 + 200);
  });

  it('auto-resize preserves all entries', async () => {
    // Insert 50 entries and verify they're all still accessible
    const result = await compileAndRun(`
      let h = {};
      let sum = 0;
      for (let i = 0; i < 50; i = i + 1) {
        h[i] = i;
      }
      for (let i = 0; i < 50; i = i + 1) {
        sum = sum + h[i];
      }
      sum
    `);
    // sum of 0..49 = 49*50/2 = 1225
    assert.equal(result, 1225);
  });

  it('auto-resize with frequency counting pattern', async () => {
    // Realistic pattern: count frequencies of many values
    const result = await compileAndRun(`
      let counts = {};
      let data = [1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3];
      for (let i = 0; i < len(data); i = i + 1) {
        let key = data[i];
        counts[key] = counts[key] + 1;
      }
      counts[1] + counts[2] + counts[3]
    `);
    // 1 appears 4 times, 2 appears 4 times, 3 appears 4 times
    assert.equal(result, 12);
  });
});
