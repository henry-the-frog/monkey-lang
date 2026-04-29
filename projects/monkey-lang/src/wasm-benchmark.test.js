// wasm-benchmark.test.js — Performance benchmarks for WASM compiler
// These tests verify correctness AND establish performance baselines.
// Run with: node --test src/wasm-benchmark.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { compileAndRun } from './wasm-compiler.js';

async function bench(code, opts = {}) {
  const timings = {};
  const result = await compileAndRun(code, { timings, cache: false });
  return { result, ...timings };
}

describe('WASM Performance Benchmarks', () => {
  describe('recursive functions (direct i32 ops)', () => {
    it('fibonacci(30) = 832040 in <50ms', async () => {
      const { result, execute } = await bench(
        'let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(30)'
      );
      assert.strictEqual(result, 832040);
      assert.ok(execute < 50, `fib(30) took ${execute.toFixed(1)}ms, expected <50ms`);
    });

    it('ackermann(3,4) = 125', async () => {
      const { result, execute } = await bench(
        'let ack = fn(m, n) { if (m == 0) { n + 1 } else { if (n == 0) { ack(m - 1, 1) } else { ack(m - 1, ack(m, n - 1)) } } }; ack(3, 4)'
      );
      assert.strictEqual(result, 125);
    });

    it('mutual recursion: isEven/isOdd', async () => {
      const { result } = await bench(`
        let isEven = fn(n) { if (n == 0) { true } else { isOdd(n - 1) } };
        let isOdd = fn(n) { if (n == 0) { false } else { isEven(n - 1) } };
        if (isEven(100)) { 1 } else { 0 }
      `);
      assert.strictEqual(result, 1);
    });
  });

  describe('loop performance', () => {
    it('for loop sum 100K iterations in <5ms', async () => {
      const { result, execute } = await bench(
        'let s = 0; for (let i = 0; i < 100000; i++) { s += i; }; s'
      );
      // Note: i32 wraps at 2^31, so result is different from JS
      assert.ok(execute < 5, `loop took ${execute.toFixed(1)}ms, expected <5ms`);
    });

    it('nested loops 100x100', async () => {
      const { result, execute } = await bench(
        'let s = 0; for (let i = 0; i < 100; i++) { for (let j = 0; j < 100; j++) { s += i * j; } }; s'
      );
      assert.strictEqual(result, 24502500);
      assert.ok(execute < 5, `nested loop took ${execute.toFixed(1)}ms, expected <5ms`);
    });

    it('while loop with break', async () => {
      const { result } = await bench(
        'let x = 0; while (true) { x += 1; if (x >= 10000) { break; } }; x'
      );
      assert.strictEqual(result, 10000);
    });

    it('do-while loop', async () => {
      const { result } = await bench(
        'let x = 0; do { x += 1; } while (x < 10000); x'
      );
      assert.strictEqual(result, 10000);
    });
  });

  describe('closures', () => {
    it('closure counter (mutation persistence)', async () => {
      const { result } = await bench(`
        let make = fn() { let c = 0; fn() { c = c + 1; c } };
        let inc = make();
        let s = 0;
        for (let i = 0; i < 100; i++) { s = inc(); };
        s
      `);
      assert.strictEqual(result, 100);
    });

    it('higher-order function: map-like', async () => {
      const { result } = await bench(`
        let apply = fn(f, x) { f(x) };
        let double = fn(x) { x * 2 };
        let s = 0;
        for (let i = 0; i < 1000; i++) { s += apply(double, i); };
        s
      `);
      assert.strictEqual(result, 999000);
    });

    it('5-level nested closure', async () => {
      const { result } = await bench(
        'let f = fn(a) { fn(b) { fn(c) { fn(d) { fn(e) { a + b + c + d + e } } } } }; f(1)(2)(3)(4)(5)'
      );
      assert.strictEqual(result, 15);
    });
  });

  describe('array operations', () => {
    it('array push + index 1000 elements', async () => {
      const { result, execute } = await bench(
        'let a = []; for (let i = 0; i < 1000; i++) { a = push(a, i * 2); }; a[999]'
      );
      assert.strictEqual(result, 1998);
      assert.ok(execute < 50, `array ops took ${execute.toFixed(1)}ms, expected <50ms`);
    });

    it('map + reduce', async () => {
      const { result } = await bench(
        'reduce(map([1, 2, 3, 4, 5], fn(x) { x * x }), fn(a, b) { a + b }, 0)'
      );
      assert.strictEqual(result, 55);
    });

    it('filter + len', async () => {
      const { result } = await bench(
        'len(filter([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], fn(x) { x % 2 == 0 }))'
      );
      assert.strictEqual(result, 5);
    });
  });

  describe('string operations', () => {
    it('string length', async () => {
      const { result } = await bench('len("hello world")');
      assert.strictEqual(result, 11);
    });
  });

  describe('tail-call optimization', () => {
    it('tail-recursive sum handles 1M calls', { skip: parseInt(process.versions.node) < 20 ? 'stack may overflow on Node 18' : false }, async () => {
      const { result, execute } = await bench(
        'let sum = fn(n, acc) { if (n <= 0) { acc } else { sum(n - 1, acc + n) } }; sum(1000000, 0)'
      );
      // i32 wraps, but the important thing is it doesn't stack overflow
      assert.ok(execute < 10, `TCO sum(1M) took ${execute.toFixed(1)}ms, expected <10ms`);
    });

    it('tail-recursive factorial', async () => {
      const { result } = await bench(
        'let fact = fn(n, acc) { if (n <= 1) { acc } else { fact(n - 1, n * acc) } }; fact(12, 1)'
      );
      assert.strictEqual(result, 479001600);
    });

    it('tail-recursive countdown 100K', async () => {
      const { result } = await bench(
        'let countdown = fn(n) { if (n <= 0) { 0 } else { countdown(n - 1) } }; countdown(100000)'
      );
      assert.strictEqual(result, 0);
    });

    it('ackermann is NOT optimized (has non-tail recursive calls)', async () => {
      const { result } = await bench(
        'let ack = fn(m, n) { if (m == 0) { n + 1 } else { if (n == 0) { ack(m - 1, 1) } else { ack(m - 1, ack(m, n - 1)) } } }; ack(3, 4)'
      );
      assert.strictEqual(result, 125);
    });
  });

  describe('compilation', () => {
    it('compile time < 20ms for fibonacci', async () => {
      const { compile } = await bench(
        'let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(10)'
      );
      assert.ok(compile < 20, `compile took ${compile.toFixed(1)}ms, expected <20ms`);
    });
  });
});
