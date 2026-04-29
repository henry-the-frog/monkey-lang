// wasm-hash.test.js — Tests for WASM hash map support
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

describe('WASM hash maps — basics', () => {
  it('create and access', async () => {
    assert.equal(await run(`
      let m = {1: 10, 2: 20, 3: 30};
      m[1] + m[2] + m[3]
    `), 60);
  });

  it('single entry', async () => {
    assert.equal(await run(`
      let m = {42: 100};
      m[42]
    `), 100);
  });

  it('not found returns 0', async () => {
    assert.equal(await run(`
      let m = {1: 10};
      m[99]
    `), 0);
  });

  it('negative keys', async () => {
    assert.equal(await run(`
      let m = {};
      set m[0 - 1] = 42;
      m[0 - 1]
    `), 42);
  });
});

describe('WASM hash maps — set', () => {
  it('set new key', async () => {
    assert.equal(await run(`
      let m = {1: 10};
      set m[2] = 20;
      m[1] + m[2]
    `), 30);
  });

  it('update existing key', async () => {
    assert.equal(await run(`
      let m = {1: 10};
      set m[1] = 100;
      m[1]
    `), 100);
  });

  it('many entries', async () => {
    assert.equal(await run(`
      let m = {};
      set m[1] = 1;
      set m[2] = 2;
      set m[3] = 3;
      set m[4] = 4;
      set m[5] = 5;
      m[1] + m[2] + m[3] + m[4] + m[5]
    `), 15);
  });
});

describe('WASM hash maps — in expressions', () => {
  it('hash in function', async () => {
    assert.equal(await run(`
      let lookup = fn(m, key) { m[key] };
      let m = {10: 100, 20: 200};
      lookup(m, 10) + lookup(m, 20)
    `), 300);
  });

  it('hash literal in expression', async () => {
    assert.equal(await run(`
      let m = {1: 10, 2: 20, 3: 30};
      let sum = 0;
      set sum = m[1] + m[2] + m[3];
      sum
    `), 60);
  });

  it('hash with computation (10 entries)', async () => {
    assert.equal(await run(`
      let m = {};
      let i = 0;
      while (i < 10) {
        set m[i] = i * i;
        set i = i + 1
      };
      m[3] + m[7] + m[9]
    `), 9 + 49 + 81);
  });
});

describe('WASM hash maps — stress', () => {
  it('overwrite same key many times', async () => {
    assert.equal(await run(`
      let m = {};
      let i = 0;
      while (i < 5) {
        set m[1] = i;
        set i = i + 1
      };
      m[1]
    `), 4);
  });

  it('hash as function argument', async () => {
    assert.equal(await run(`
      let get = fn(h, k) { h[k] };
      let m = {10: 100, 20: 200};
      get(m, 10) + get(m, 20)
    `), 300);
  });

  it('hash returned from function', async () => {
    assert.equal(await run(`
      let make = fn() {
        let h = {1: 10, 2: 20};
        h
      };
      let m = make();
      m[1] + m[2]
    `), 30);
  });

  it('hash with computed keys', async () => {
    assert.equal(await run(`
      let m = {};
      let base = 100;
      set m[base + 1] = 1;
      set m[base + 2] = 2;
      m[101] + m[102]
    `), 3);
  });

  it('multiple hashes', async () => {
    assert.equal(await run(`
      let a = {1: 10};
      let b = {1: 20};
      a[1] + b[1]
    `), 30);
  });

  it('frequency counter pattern', async () => {
    assert.equal(await run(`
      let data = [1, 2, 1, 3, 2, 1];
      let freq = {};
      for (x in data) {
        set freq[x] = freq[x] + 1
      };
      freq[1]
    `), 3);
  });
});
