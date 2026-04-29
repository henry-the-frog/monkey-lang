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

describe('WASM String Key Hash Maps', () => {
  it('string literal keys in hash literal', async () => {
    const result = await compileAndRun('let h = {"a": 1, "b": 2, "c": 3}; h["b"]');
    assert.equal(result, 2);
  });

  it('string key set and get', async () => {
    const result = await compileAndRun(`
      let h = {"hello": 10};
      h["world"] = 20;
      h["hello"] + h["world"]
    `);
    assert.equal(result, 30);
  });

  it('string key overwrite', async () => {
    const result = await compileAndRun(`
      let h = {"x": 1};
      h["x"] = 42;
      h["x"]
    `);
    assert.equal(result, 42);
  });

  it('multiple string keys', async () => {
    const result = await compileAndRun(`
      let h = {"name": 1, "age": 2, "city": 3, "country": 4};
      h["name"] + h["age"] + h["city"] + h["country"]
    `);
    assert.equal(result, 10);
  });

  it('string key not found returns 0', async () => {
    const result = await compileAndRun(`
      let h = {"a": 99};
      h["b"]
    `);
    assert.equal(result, 0);
  });

  it('many string keys (triggers resize)', async () => {
    const result = await compileAndRun(`
      let h = {};
      h["a"] = 1;
      h["b"] = 2;
      h["c"] = 3;
      h["d"] = 4;
      h["e"] = 5;
      h["f"] = 6;
      h["g"] = 7;
      h["h"] = 8;
      h["i"] = 9;
      h["j"] = 10;
      h["a"] + h["e"] + h["j"]
    `);
    assert.equal(result, 16);
  });

  it('hash as function argument', async () => {
    const result = await compileAndRun(`
      let getVal = fn(h) { h["key"] };
      let m = {"key": 42};
      getVal(m)
    `);
    assert.equal(result, 42);
  });

  it('hash returned from function', async () => {
    const result = await compileAndRun(`
      let makeMap = fn() { {"result": 99} };
      let m = makeMap();
      m["result"]
    `);
    assert.equal(result, 99);
  });
});

describe('WASM Hash Map Iteration', () => {
  it('for-in over keys(h) with integer keys', async () => {
    const result = await compileAndRun(`
      let h = {1: 10, 2: 20, 3: 30};
      let sum = 0;
      for (k in keys(h)) {
        sum = sum + h[k];
      }
      sum
    `);
    assert.equal(result, 60);
  });

  it('for-in over keys(h) with string keys', async () => {
    const result = await compileAndRun(`
      let h = {"a": 1, "b": 2, "c": 3};
      let sum = 0;
      for (k in keys(h)) {
        sum = sum + h[k];
      }
      sum
    `);
    assert.equal(result, 6);
  });

  it('for-in over values(h)', async () => {
    const result = await compileAndRun(`
      let h = {"x": 10, "y": 20, "z": 30};
      let sum = 0;
      for (v in values(h)) {
        sum = sum + v;
      }
      sum
    `);
    assert.equal(result, 60);
  });

  it('keys() count matches size', async () => {
    const result = await compileAndRun(`
      let h = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5};
      len(keys(h))
    `);
    assert.equal(result, 5);
  });

  it('keys() on empty hash', async () => {
    const result = await compileAndRun(`
      let h = {};
      len(keys(h))
    `);
    assert.equal(result, 0);
  });

  it('for-in with hash modification in loop body', async () => {
    // Build a new hash from an existing one
    const result = await compileAndRun(`
      let src = {1: 10, 2: 20, 3: 30};
      let sum = 0;
      for (k in keys(src)) {
        sum = sum + k;
      }
      sum
    `);
    // keys are 1, 2, 3 — sum of keys = 6
    assert.equal(result, 6);
  });

  it('for-in with many entries (post-resize)', async () => {
    const result = await compileAndRun(`
      let h = {};
      h["a"] = 1; h["b"] = 2; h["c"] = 3; h["d"] = 4;
      h["e"] = 5; h["f"] = 6; h["g"] = 7; h["h"] = 8;
      h["i"] = 9; h["j"] = 10;
      let sum = 0;
      for (v in values(h)) {
        sum = sum + v;
      }
      sum
    `);
    assert.equal(result, 55);
  });
});
