// wasm-integration.test.js — Integration stress tests combining multiple features
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

describe('WASM integration — arrays + HOFs + closures', () => {
  it('filter-map-reduce pipeline with closures', async () => {
    assert.equal(await run(`
      let threshold = 5;
      let multiplier = 3;
      let above = fn(x) { if (x > threshold) { 1 } else { 0 } };
      let scale = fn(x) { x * multiplier };
      let add = fn(acc, x) { acc + x };
      let data = [1, 3, 5, 7, 9, 11];
      reduce(map(filter(data, above), scale), add, 0)
    `), (7 + 9 + 11) * 3);
  });

  it('build array with push + filter + sum', async () => {
    assert.equal(await run(`
      let a = [];
      let i = 1;
      while (i <= 20) { push(a, i); set i = i + 1 };
      let isEven = fn(x) { if (x % 2 == 0) { 1 } else { 0 } };
      let add = fn(acc, x) { acc + x };
      reduce(filter(a, isEven), add, 0)
    `), 2 + 4 + 6 + 8 + 10 + 12 + 14 + 16 + 18 + 20);
  });

  it('recursive function with array output', async () => {
    assert.equal(await run(`
      let fib_arr = [];
      let fib = fn(n) {
        if (n < 2) { n }
        else { fib(n - 1) + fib(n - 2) }
      };
      let i = 0;
      while (i < 10) {
        push(fib_arr, fib(i));
        set i = i + 1;
      };
      // fib_arr = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
      let add = fn(acc, x) { acc + x };
      reduce(fib_arr, add, 0)
    `), 0 + 1 + 1 + 2 + 3 + 5 + 8 + 13 + 21 + 34);
  });

  it('sieve + map + reduce (count twin primes)', async () => {
    // Count twin primes up to 100 (pairs where both p and p+2 are prime)
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
        is_prime
      };
      let primes = sieve(102);
      let count = 0;
      let i = 2;
      while (i <= 100) {
        if (primes[i] == 1) {
          if (primes[i + 2] == 1) {
            set count = count + 1;
          };
        };
        set i = i + 1;
      };
      count
    `), 8); // twin prime pairs up to 100: (3,5),(5,7),(11,13),(17,19),(29,31),(41,43),(59,61),(71,73)
  });

  it('mutual recursion + arrays', async () => {
    assert.equal(await run(`
      let isEven = fn(n) {
        if (n == 0) { 1 }
        else { isOdd(n - 1) }
      };
      let isOdd = fn(n) {
        if (n == 0) { 0 }
        else { isEven(n - 1) }
      };
      let results = [];
      let i = 0;
      while (i < 10) { push(results, isEven(i)); set i = i + 1 };
      let add = fn(acc, x) { acc + x };
      reduce(results, add, 0)
    `), 5); // 0,2,4,6,8 are even → 5 ones
  });

  it('HOFs with inline functions + array building', async () => {
    assert.equal(await run(`
      let data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let squared = map(data, fn(x) { x * x });
      let big = filter(squared, fn(x) { if (x > 25) { 1 } else { 0 } });
      len(big)
    `), 5); // 36, 49, 64, 81, 100 → 5 elements
  });

  it('do-while with array accumulation', async () => {
    assert.equal(await run(`
      let collatz_seq = fn(n) {
        let steps = [];
        push(steps, n);
        do {
          if (n % 2 == 0) {
            set n = n / 2;
          } else {
            set n = n * 3 + 1;
          };
          push(steps, n);
        } while (n != 1);
        len(steps)
      };
      collatz_seq(27)
    `), 112); // 27 takes 111 steps + initial value = 112 elements
  });

  it('nested function calls with array results', async () => {
    assert.equal(await run(`
      let makeRange = fn(start, end_val) {
        let result = [];
        let i = start;
        while (i < end_val) { push(result, i); set i = i + 1 };
        result
      };
      let sumArray = fn(arr) {
        let add = fn(acc, x) { acc + x };
        reduce(arr, add, 0)
      };
      let r = makeRange(1, 101);
      sumArray(r)
    `), 5050);
  });

  it('for loop + array + map', async () => {
    assert.equal(await run(`
      let squares = [];
      for (let i = 1; i <= 5; set i = i + 1) {
        push(squares, i * i);
      };
      let double = fn(x) { x * 2 };
      let add = fn(acc, x) { acc + x };
      reduce(map(squares, double), add, 0)
    `), (1 + 4 + 9 + 16 + 25) * 2);
  });
});
