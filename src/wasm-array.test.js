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

describe('WASM arrays — reallocation edge cases', () => {
  it('grow from truly empty (0 elements, 256 cap)', async () => {
    assert.equal(await run(`
      let a = [];
      push(a, 42);
      a[0]
    `), 42);
  });

  it('grow from cap=1 (single element literal)', async () => {
    // [1] has len=1, cap=2 → after 2 pushes, needs realloc
    assert.equal(await run(`
      let a = [1];
      push(a, 2);
      push(a, 3);
      push(a, 4);
      len(a)
    `), 4);
  });

  it('push in map callback (HOF with growing array)', async () => {
    // map creates new array, should work with reallocation
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 300) { push(a, i); set i = i + 1 };
      let b = map(a, fn(x) { x * 2 });
      b[299]
    `), 598);
  });

  it('filter on large grown array', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 500) { push(a, i); set i = i + 1 };
      let evens = filter(a, fn(x) { x % 2 == 0 });
      len(evens)
    `), 250);
  });

  it('reduce on large grown array', async () => {
    // Sum of 0..99 = 4950
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 100) { push(a, i); set i = i + 1 };
      reduce(a, fn(acc, x) { acc + x }, 0)
    `), 4950);
  });

  it('push after set (realloc does not lose set values)', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 256) { push(a, 0); set i = i + 1 };
      set a[0] = 999;
      set a[255] = 888;
      push(a, 777);
      a[0] + a[255] + a[256]
    `), 999 + 888 + 777);
  });

  it('interleaved push on two arrays near capacity', async () => {
    assert.equal(await run(`
      let a = [];
      let b = [];
      let i = 0;
      while (i < 300) {
        push(a, i);
        push(b, 1000 - i);
        set i = i + 1
      };
      a[0] + a[299] + b[0] + b[299]
    `), 0 + 299 + 1000 + 701);
  });

  it('nested function creating large arrays', async () => {
    assert.equal(await run(`
      let range = fn(n) {
        let a = [];
        let i = 0;
        while (i < n) { push(a, i); set i = i + 1 };
        a
      };
      let a = range(300);
      let b = range(400);
      a[299] + b[399]
    `), 299 + 399);
  });
});

describe('WASM arrays — for-in loops', () => {
  it('basic for-in sum', async () => {
    assert.equal(await run(`
      let a = [10, 20, 30, 40, 50];
      let sum = 0;
      for (x in a) { set sum = sum + x };
      sum
    `), 150);
  });

  it('for-in over empty array', async () => {
    assert.equal(await run(`
      let a = [];
      let sum = 0;
      for (x in a) { set sum = sum + x };
      sum
    `), 0);
  });

  it('for-in with push (build new array)', async () => {
    assert.equal(await run(`
      let a = [1, 2, 3, 4, 5];
      let b = [];
      for (x in a) { push(b, x * 10) };
      b[0] + b[2] + b[4]
    `), 10 + 30 + 50);
  });

  it('for-in over pushed array', async () => {
    assert.equal(await run(`
      let a = [];
      push(a, 100);
      push(a, 200);
      push(a, 300);
      let sum = 0;
      for (x in a) { set sum = sum + x };
      sum
    `), 600);
  });

  it('nested for-in (matrix sum)', async () => {
    // Simulate 2D: [[1,2],[3,4],[5,6]] stored as flat arrays
    assert.equal(await run(`
      let a = [1, 2, 3];
      let b = [10, 20, 30];
      let sum = 0;
      for (x in a) {
        for (y in b) {
          set sum = sum + x * y
        }
      };
      sum
    `), (1+2+3) * (10+20+30));
  });

  it('for-in in function', async () => {
    assert.equal(await run(`
      let sum = fn(arr) {
        let total = 0;
        for (x in arr) { set total = total + x };
        total
      };
      sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    `), 55);
  });

  it('for-in with conditional accumulation', async () => {
    assert.equal(await run(`
      let a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let evenSum = 0;
      for (x in a) {
        if (x % 2 == 0) {
          set evenSum = evenSum + x
        }
      };
      evenSum
    `), 2 + 4 + 6 + 8 + 10);
  });

  it('for-in over large grown array', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 0;
      while (i < 500) { push(a, i); set i = i + 1 };
      let sum = 0;
      for (x in a) { set sum = sum + x };
      sum
    `), 500 * 499 / 2);
  });

  it('for-in with map-like transformation', async () => {
    assert.equal(await run(`
      let src = [1, 2, 3, 4, 5];
      let dst = [];
      for (x in src) { push(dst, x * x) };
      dst[0] + dst[1] + dst[2] + dst[3] + dst[4]
    `), 1 + 4 + 9 + 16 + 25);
  });

  it('for-in counting', async () => {
    assert.equal(await run(`
      let a = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      let count = 0;
      for (x in a) {
        if (x > 50) { set count = count + 1 }
      };
      count
    `), 5);
  });
});

describe('WASM arrays — comprehensions', () => {
  it('basic map comprehension', async () => {
    assert.equal(await run(`
      let a = [x * 2 for x in [1, 2, 3, 4, 5]];
      a[0] + a[1] + a[2] + a[3] + a[4]
    `), 30);
  });

  it('identity comprehension', async () => {
    assert.equal(await run(`
      let src = [10, 20, 30];
      let dst = [x for x in src];
      dst[0] + dst[1] + dst[2]
    `), 60);
  });

  it('comprehension with filter', async () => {
    assert.equal(await run(`
      let a = [x for x in [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] if x % 2 == 0];
      len(a)
    `), 5);
  });

  it('comprehension with filter - values', async () => {
    assert.equal(await run(`
      let a = [x * x for x in [1, 2, 3, 4, 5] if x > 2];
      a[0] + a[1] + a[2]
    `), 9 + 16 + 25);
  });

  it('comprehension over empty array', async () => {
    assert.equal(await run(`
      let a = [x for x in []];
      len(a)
    `), 0);
  });

  it('comprehension over pushed array', async () => {
    assert.equal(await run(`
      let src = [];
      push(src, 1); push(src, 2); push(src, 3);
      let doubled = [x * 2 for x in src];
      doubled[0] + doubled[1] + doubled[2]
    `), 12);
  });

  it('comprehension in function', async () => {
    assert.equal(await run(`
      let doubleAll = fn(arr) {
        [x * 2 for x in arr]
      };
      let result = doubleAll([5, 10, 15]);
      result[0] + result[1] + result[2]
    `), 60);
  });

  it('comprehension with complex body', async () => {
    assert.equal(await run(`
      let a = [1, 2, 3, 4, 5];
      let b = [if (x > 3) { x * 10 } else { x } for x in a];
      b[0] + b[1] + b[2] + b[3] + b[4]
    `), 1 + 2 + 3 + 40 + 50);
  });

  it('chained comprehensions', async () => {
    assert.equal(await run(`
      let a = [x * 2 for x in [1, 2, 3, 4, 5]];
      let b = [x + 1 for x in a];
      b[0] + b[4]
    `), 3 + 11);
  });

  it('large comprehension (500 elements)', async () => {
    assert.equal(await run(`
      let src = [];
      let i = 0;
      while (i < 500) { push(src, i); set i = i + 1 };
      let doubled = [x * 2 for x in src];
      doubled[499]
    `), 998);
  });

  it('filter comprehension all pass', async () => {
    assert.equal(await run(`
      let a = [x for x in [1, 2, 3] if x > 0];
      len(a)
    `), 3);
  });

  it('filter comprehension none pass', async () => {
    assert.equal(await run(`
      let a = [x for x in [1, 2, 3] if x > 100];
      len(a)
    `), 0);
  });

  it('comprehension with for-in consumer', async () => {
    assert.equal(await run(`
      let squares = [x * x for x in [1, 2, 3, 4, 5]];
      let sum = 0;
      for (s in squares) { set sum = sum + s };
      sum
    `), 55);
  });
});
