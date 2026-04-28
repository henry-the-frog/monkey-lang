// wasm-array.test.js — Tests for WASM compiler array support
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

describe('WASM arrays — basics', () => {
  it('array literal and index', async () => {
    assert.equal(await run('let a = [10, 20, 30]; a[1]'), 20);
  });

  it('array[0]', async () => {
    assert.equal(await run('let a = [42]; a[0]'), 42);
  });

  it('empty array', async () => {
    assert.equal(await run('let a = []; len(a)'), 0);
  });

  it('len()', async () => {
    assert.equal(await run('let a = [1, 2, 3, 4, 5]; len(a)'), 5);
  });

  it('computed index', async () => {
    assert.equal(await run('let a = [10, 20, 30]; let i = 2; a[i]'), 30);
  });

  it('expression index', async () => {
    assert.equal(await run('let a = [10, 20, 30]; a[1 + 1]'), 30);
  });

  it('negative values in array', async () => {
    assert.equal(await run('let a = [-1, -2, -3]; a[0] + a[2]'), -4);
  });

  it('large array literal', async () => {
    const elems = Array.from({length: 20}, (_, i) => i).join(', ');
    assert.equal(await run(`let a = [${elems}]; a[19]`), 19);
  });
});

describe('WASM arrays — push', () => {
  it('push returns new length', async () => {
    assert.equal(await run('let a = [1, 2]; push(a, 3)'), 3);
  });

  it('push to empty', async () => {
    assert.equal(await run('let a = []; push(a, 42); a[0]'), 42);
  });

  it('multiple pushes', async () => {
    assert.equal(await run(`
      let a = [];
      push(a, 10);
      push(a, 20);
      push(a, 30);
      a[0] + a[1] + a[2]
    `), 60);
  });

  it('push in loop', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 100) { push(a, i); set i = i + 1 };
      len(a) + a[99]
    `), 199); // 100 + 99
  });
});

describe('WASM arrays — set a[i]', () => {
  it('basic set', async () => {
    assert.equal(await run('let a = [1, 2, 3]; set a[0] = 99; a[0]'), 99);
  });

  it('set with computed index', async () => {
    assert.equal(await run('let a = [0, 0, 0]; let i = 1; set a[i] = 42; a[1]'), 42);
  });

  it('set in loop', async () => {
    assert.equal(await run(`
      let a = [0, 0, 0, 0, 0];
      let i = 0;
      while (i < 5) { set a[i] = i * i; set i = i + 1 };
      a[0] + a[1] + a[2] + a[3] + a[4]
    `), 0 + 1 + 4 + 9 + 16);
  });
});

describe('WASM arrays — in functions', () => {
  it('array in function', async () => {
    assert.equal(await run(`
      let sum = fn(a, n) {
        let total = 0;
        let i = 0;
        while (i < n) { set total = total + a[i]; set i = i + 1; };
        total
      };
      let arr = [1, 2, 3, 4, 5];
      sum(arr, 5)
    `), 15);
  });

  it('array created in function', async () => {
    assert.equal(await run(`
      let makeArray = fn() {
        let a = [10, 20, 30];
        a[1]
      };
      makeArray()
    `), 20);
  });

  it('push in function', async () => {
    assert.equal(await run(`
      let fill = fn(n) {
        let a = [];
        let i = 0;
        while (i < n) { push(a, i * 2); set i = i + 1 };
        a[n - 1]
      };
      fill(10)
    `), 18);
  });

  it('sieve of eratosthenes', async () => {
    assert.equal(await run(`
      let sieve = fn(n) {
        let is_prime = [];
        let i = 0;
        while (i <= n) { push(is_prime, 1); set i = i + 1 };
        set is_prime[0] = 0;
        set is_prime[1] = 0;
        let p = 2;
        while (p * p <= n) {
          if (is_prime[p] == 1) {
            let j = p * p;
            while (j <= n) { set is_prime[j] = 0; set j = j + p; };
          };
          set p = p + 1;
        };
        let count = 0;
        set i = 2;
        while (i <= n) { set count = count + is_prime[i]; set i = i + 1; };
        count
      };
      sieve(100)
    `), 25);
  });

  it('multiple functions with arrays', async () => {
    assert.equal(await run(`
      let make = fn(n) {
        let a = [];
        let i = 0;
        while (i < n) { push(a, i + 1); set i = i + 1 };
        a
      };
      let sum = fn(a, n) {
        let total = 0;
        let i = 0;
        while (i < n) { set total = total + a[i]; set i = i + 1; };
        total
      };
      let arr = make(10);
      sum(arr, 10)
    `), 55);
  });
});

describe('WASM arrays — mixed with other features', () => {
  it('arrays + closures', async () => {
    assert.equal(await run(`
      let x = 5;
      let addX = fn(arr, n) {
        let total = 0;
        let i = 0;
        while (i < n) { set total = total + arr[i] + x; set i = i + 1 };
        total
      };
      let a = [1, 2, 3];
      addX(a, 3)
    `), 21); // (1+5) + (2+5) + (3+5) = 21
  });

  it('arrays + for loop', async () => {
    assert.equal(await run(`
      let a = [1, 2, 3, 4, 5];
      let total = 0;
      for (let i = 0; i < len(a); set i = i + 1) {
        set total = total + a[i];
      };
      total
    `), 15);
  });

  it('arrays + recursion', async () => {
    assert.equal(await run(`
      let sumRec = fn(a, i, n) {
        if (i >= n) { 0 }
        else { a[i] + sumRec(a, i + 1, n) }
      };
      let a = [10, 20, 30, 40, 50];
      sumRec(a, 0, 5)
    `), 150);
  });
});

describe('WASM arrays — reallocation (growth beyond capacity)', () => {
  it('grow empty array past initial capacity (256→512)', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 300) { push(a, i); set i = i + 1 };
      len(a)
    `), 300);
  });

  it('grow to 1000 elements', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 1000) { push(a, i); set i = i + 1 };
      a[999]
    `), 999);
  });

  it('grow to 5000 elements (multiple reallocations)', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 5000) { push(a, i * 2); set i = i + 1 };
      a[4999]
    `), 9998);
  });

  it('data integrity after reallocation', async () => {
    // Push 500 elements, verify first, middle, and last
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 500) { push(a, i * 3); set i = i + 1 };
      a[0] + a[250] + a[499]
    `), 0 + 750 + 1497);
  });

  it('multiple arrays growing independently', async () => {
    assert.equal(await run(`
      let a = [];
      let b = [];
      let i = 0;
      while (i < 300) {
        push(a, i);
        push(b, i * 10);
        set i = i + 1
      };
      a[299] + b[299]
    `), 299 + 2990);
  });

  it('grow array in function', async () => {
    assert.equal(await run(`
      let buildArr = fn(n) {
        let a = [];
        let i = 0;
        while (i < n) { push(a, i); set i = i + 1 };
        a
      };
      let arr = buildArr(400);
      arr[399]
    `), 399);
  });

  it('memory.grow triggers (>64KB allocation)', async () => {
    // 16384 elements * 4 bytes = 64KB of data, plus headers
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 20000) { push(a, i); set i = i + 1 };
      a[19999]
    `), 19999);
  });

  it('grow from pre-sized array', async () => {
    // Array starts with cap=10 (5 elements * 2), grows past it
    assert.equal(await run(`
      let a = [1, 2, 3, 4, 5];
      let i = 0;
      while (i < 20) { push(a, i + 6); set i = i + 1 };
      len(a)
    `), 25);
  });

  it('sum large grown array', async () => {
    // Sum of 0..999 = 499500
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 1000) { push(a, i); set i = i + 1 };
      let sum = 0;
      set i = 0;
      while (i < 1000) { set sum = sum + a[i]; set i = i + 1 };
      sum
    `), 499500);
  });
});
