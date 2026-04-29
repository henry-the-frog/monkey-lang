// wasm-integration-advanced.test.js — Complex integration tests for WASM compiler
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

describe('WASM advanced integration', () => {
  it('quicksort + binary search', async () => {
    assert.equal(await run(`
      let qsort = fn(arr) {
        if (len(arr) <= 1) { arr }
        else {
          let p = arr[0];
          let result = [];
          for (x in qsort([y for y in arr if y < p])) { push(result, x) };
          for (x in [y for y in arr if y == p]) { push(result, x) };
          for (x in qsort([y for y in arr if y > p])) { push(result, x) };
          result
        }
      };
      let sorted = qsort([5, 3, 8, 1, 9, 2]);
      sorted[0] + sorted[5]
    `), 1 + 9);
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
            while (j <= n) { set is_prime[j] = 0; set j = j + p }
          };
          set p = p + 1
        };
        let count = 0;
        set i = 0;
        while (i <= n) {
          set count = count + is_prime[i];
          set i = i + 1
        };
        count
      };
      sieve(100)
    `), 25);
  });

  it('frequency counter with hash map', async () => {
    assert.equal(await run(`
      let data = [1, 3, 2, 1, 3, 1, 2, 4, 3, 1];
      let freq = {};
      for (x in data) { set freq[x] = freq[x] + 1 };
      freq[1]
    `), 4);
  });

  it('memoized fibonacci', async () => {
    assert.equal(await run(`
      let memo = [];
      let i = 0;
      while (i < 40) { push(memo, 0); set i = i + 1 };
      let fib = fn(n) {
        if (n <= 1) { n }
        else {
          if (memo[n] != 0) { memo[n] }
          else {
            let result = fib(n - 1) + fib(n - 2);
            set memo[n] = result;
            result
          }
        }
      };
      fib(30)
    `), 832040);
  });

  it('string processing pipeline', async () => {
    assert.equal(await run(`
      let s = "  Hello, World!  ";
      let trimmed = trim(s);
      let upper = toUpperCase(trimmed);
      let pos = indexOf(upper, "WORLD");
      pos
    `), 7);
  });

  it('comprehension chain', async () => {
    assert.equal(await run(`
      let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let squared = [x * x for x in nums];
      let big = [x for x in squared if x > 25];
      let sum = 0;
      for (x in big) { set sum = sum + x };
      sum
    `), 36 + 49 + 64 + 81 + 100);
  });

  it('break in search', async () => {
    assert.equal(await run(`
      let arr = [10, 20, 30, 40, 50];
      let found = 0 - 1;
      let i = 0;
      for (x in arr) {
        if (x == 30) {
          set found = i;
          break
        };
        set i = i + 1
      };
      found
    `), 2);
  });

  it('string building with intToString', async () => {
    assert.equal(await run(`
      let result = "";
      let i = 1;
      while (i <= 5) {
        set result = result + intToString(i);
        if (i < 5) { set result = result + "," };
        set i = i + 1
      };
      result == "1,2,3,4,5"
    `), 1);
  });
});
