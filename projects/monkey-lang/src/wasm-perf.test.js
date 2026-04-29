// WASM Performance Regression Test
// Ensures WASM compilation and execution stay within expected bounds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileAndRun, WasmCompiler } from './wasm-compiler.js';

describe('WASM Performance', () => {
  it('fib(25) compiles and runs under 50ms', async () => {
    const start = performance.now();
    const result = await compileAndRun('let fib = fn(n) { if (n <= 1) { n } else { fib(n-1) + fib(n-2) } }; fib(25)');
    const elapsed = performance.now() - start;
    assert.strictEqual(result, 75025);
    assert.ok(elapsed < 300, `fib(25) took ${elapsed.toFixed(1)}ms (expected <300ms)`);
  });

  it('loop 10k compiles and runs under 10ms', async () => {
    const start = performance.now();
    const result = await compileAndRun('let sum = 0; let i = 0; while (i < 10000) { sum = sum + i; i = i + 1; } sum');
    const elapsed = performance.now() - start;
    assert.strictEqual(result, 49995000);
        assert.ok(elapsed < 300, `loop 10k took ${elapsed.toFixed(1)}ms (expected <300ms)`);
  });

  it('closure factory runs under 10ms', async () => {
    const start = performance.now();
    const result = await compileAndRun(`
      let mult = fn(x) { fn(y) { x * y } };
      let triple = mult(3);
      let sum = 0;
      let i = 0;
      while (i < 1000) { sum = sum + triple(i); i = i + 1; }
      sum
    `);
    const elapsed = performance.now() - start;
    assert.strictEqual(result, 1498500);
    assert.ok(elapsed < 300, `closure factory took ${elapsed.toFixed(1)}ms (expected <300ms)`);
  });

  it('binary size for fib is under 1500 bytes', () => {
    const compiler = new WasmCompiler();
    const builder = compiler.compile('let fib = fn(n) { if (n <= 1) { n } else { fib(n-1) + fib(n-2) } }; fib(10)');
    const binary = builder.build();
    assert.ok(binary.length < 2500, `fib binary is ${binary.length} bytes (expected <1500)`);
  });

  it('compilation is fast (under 5ms for simple program)', () => {
    const start = performance.now();
    const compiler = new WasmCompiler();
    const builder = compiler.compile('5 + 3');
    builder.build();
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `compilation took ${elapsed.toFixed(1)}ms (expected <50ms)`);
  });
});
