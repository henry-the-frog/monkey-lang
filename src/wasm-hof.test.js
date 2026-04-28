// wasm-hof.test.js — Tests for WASM compiler higher-order function builtins
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

describe('WASM map()', () => {
  it('doubles each element', async () => {
    assert.equal(await run(`
      let double = fn(x) { x * 2 };
      let a = [1, 2, 3];
      let b = map(a, double);
      b[0] + b[1] + b[2]
    `), 12);
  });

  it('preserves length', async () => {
    assert.equal(await run(`
      let inc = fn(x) { x + 1 };
      let a = [10, 20, 30, 40, 50];
      len(map(a, inc))
    `), 5);
  });

  it('does not mutate source', async () => {
    assert.equal(await run(`
      let double = fn(x) { x * 2 };
      let a = [1, 2, 3];
      map(a, double);
      a[0] + a[1] + a[2]
    `), 6);
  });

  it('works with inline fn', async () => {
    assert.equal(await run(`
      let a = [3, 6, 9];
      let b = map(a, fn(x) { x * x });
      b[0] + b[1] + b[2]
    `), 9 + 36 + 81);
  });

  it('empty array', async () => {
    assert.equal(await run(`
      let double = fn(x) { x * 2 };
      let a = [];
      len(map(a, double))
    `), 0);
  });

  it('chained map', async () => {
    assert.equal(await run(`
      let inc = fn(x) { x + 1 };
      let double = fn(x) { x * 2 };
      let a = [1, 2, 3];
      let b = map(map(a, inc), double);
      b[0] + b[1] + b[2]
    `), 4 + 6 + 8);
  });
});

describe('WASM filter()', () => {
  it('filters evens', async () => {
    assert.equal(await run(`
      let isEven = fn(x) { if (x % 2 == 0) { 1 } else { 0 } };
      let a = [1, 2, 3, 4, 5, 6];
      len(filter(a, isEven))
    `), 3);
  });

  it('keeps correct elements', async () => {
    assert.equal(await run(`
      let big = fn(x) { if (x > 3) { 1 } else { 0 } };
      let a = [1, 2, 3, 4, 5];
      let b = filter(a, big);
      b[0] + b[1]
    `), 9); // 4 + 5
  });

  it('all pass', async () => {
    assert.equal(await run(`
      let pos = fn(x) { if (x > 0) { 1 } else { 0 } };
      let a = [1, 2, 3];
      len(filter(a, pos))
    `), 3);
  });

  it('none pass', async () => {
    assert.equal(await run(`
      let neg = fn(x) { if (x < 0) { 1 } else { 0 } };
      let a = [1, 2, 3];
      len(filter(a, neg))
    `), 0);
  });

  it('preserves order', async () => {
    assert.equal(await run(`
      let isOdd = fn(x) { x % 2 };
      let a = [1, 2, 3, 4, 5, 6, 7];
      let b = filter(a, isOdd);
      b[0] * 1000 + b[1] * 100 + b[2] * 10 + b[3]
    `), 1357);
  });
});

describe('WASM reduce()', () => {
  it('sum', async () => {
    assert.equal(await run(`
      let add = fn(acc, x) { acc + x };
      let a = [1, 2, 3, 4, 5];
      reduce(a, add, 0)
    `), 15);
  });

  it('product', async () => {
    assert.equal(await run(`
      let mul = fn(acc, x) { acc * x };
      let a = [1, 2, 3, 4, 5];
      reduce(a, mul, 1)
    `), 120);
  });

  it('with initial value', async () => {
    assert.equal(await run(`
      let add = fn(acc, x) { acc + x };
      let a = [10, 20, 30];
      reduce(a, add, 100)
    `), 160);
  });

  it('empty array returns init', async () => {
    assert.equal(await run(`
      let add = fn(acc, x) { acc + x };
      let a = [];
      reduce(a, add, 42)
    `), 42);
  });

  it('max', async () => {
    assert.equal(await run(`
      let max = fn(acc, x) { if (x > acc) { x } else { acc } };
      let a = [3, 7, 1, 9, 4, 2];
      reduce(a, max, 0)
    `), 9);
  });
});

describe('WASM HOF pipeline', () => {
  it('filter → map → reduce', async () => {
    assert.equal(await run(`
      let isEven = fn(x) { if (x % 2 == 0) { 1 } else { 0 } };
      let double = fn(x) { x * 2 };
      let add = fn(acc, x) { acc + x };
      let data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      reduce(map(filter(data, isEven), double), add, 0)
    `), 60);
  });

  it('map → filter → reduce', async () => {
    assert.equal(await run(`
      let triple = fn(x) { x * 3 };
      let big = fn(x) { if (x > 10) { 1 } else { 0 } };
      let add = fn(acc, x) { acc + x };
      let data = [1, 2, 3, 4, 5];
      reduce(filter(map(data, triple), big), add, 0)
    `), 12 + 15); // 3,6,9,12,15 → >10: 12,15 → sum: 27
  });

  it('complex pipeline with closures', async () => {
    assert.equal(await run(`
      let threshold = 5;
      let aboveThreshold = fn(x) { if (x > threshold) { 1 } else { 0 } };
      let offset = 10;
      let addOffset = fn(x) { x + offset };
      let add = fn(acc, x) { acc + x };
      let data = [1, 3, 5, 7, 9];
      reduce(map(filter(data, aboveThreshold), addOffset), add, 0)
    `), (17 + 19)); // >5: 7,9 → +10: 17,19 → sum: 36
  });
});
