#!/usr/bin/env node

// Five-Backend Benchmark Suite for Monkey Language
// Compares: Eval, VM, JIT, Transpiler, WASM

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { Environment } from './object.js';
import { Transpiler } from './transpiler.js';
import { compileAndRun as wasmCompileAndRun, WasmCompiler, precompile as wasmPrecompile } from './wasm-compiler.js';

// Benchmarks that work across all 5 backends (no stdlib, no hash maps, no strings)
const BENCHMARKS = [
  {
    name: 'fib(25)',
    category: 'recursive',
    input: 'let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(25)',
    expected: 75025,
  },
  {
    name: 'fib(30)',
    category: 'recursive',
    input: 'let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(30)',
    expected: 832040,
  },
  {
    name: 'factorial(20)',
    category: 'recursive',
    input: 'let fact = fn(n) { if (n < 2) { 1 } else { n * fact(n-1) } }; fact(20)',
    expected: 2432902008176640000,
    wasmExpected: null, // WASM uses i32, will overflow
  },
  {
    name: 'sum 10k',
    category: 'loops',
    input: 'let sum = 0; let i = 0; while (i < 10000) { sum = sum + i; i = i + 1; } sum',
    expected: 49995000,
  },
  {
    name: 'sum 100k',
    category: 'loops',
    input: 'let sum = 0; let i = 0; while (i < 100000) { sum = sum + i; i = i + 1; } sum',
    expected: 4999950000,
    wasmExpected: null, // i32 overflow
  },
  {
    name: 'nested 100x100',
    category: 'loops',
    input: 'let sum = 0; let i = 0; while (i < 100) { let j = 0; while (j < 100) { sum = sum + 1; j = j + 1; } i = i + 1; } sum',
    expected: 10000,
  },
  {
    name: 'GCD(48,18) x1000',
    category: 'recursive',
    input: 'let gcd = fn(a, b) { if (b == 0) { a } else { gcd(b, a % b) } }; let sum = 0; let i = 0; while (i < 1000) { sum = sum + gcd(48, 18); i = i + 1; } sum',
    expected: 6000,
  },
  {
    name: 'power(2,20) x100',
    category: 'recursive',
    input: 'let pow = fn(b, e) { if (e == 0) { 1 } else { b * pow(b, e - 1) } }; let sum = 0; let i = 0; while (i < 100) { sum = sum + pow(2, 20); i = i + 1; } sum',
    expected: 104857600,
  },
  {
    name: 'fn call 10k',
    category: 'inlining',
    input: 'let double = fn(x) { x * 2 }; let sum = 0; let i = 0; while (i < 10000) { sum = sum + double(i); i = i + 1; } sum',
    expected: 99990000,
  },
  {
    name: 'closure factory 5k',
    category: 'closures',
    input: 'let mult = fn(x) { fn(y) { x * y } }; let triple = mult(3); let sum = 0; let i = 0; while (i < 5000) { sum = sum + triple(i); i = i + 1; } sum',
    expected: 37492500,
  },
  {
    name: 'higher-order 5k',
    category: 'closures',
    input: 'let apply = fn(f, x) { f(x) }; let double = fn(x) { x * 2 }; let sum = 0; let i = 0; while (i < 5000) { sum = sum + apply(double, i); i = i + 1; } sum',
    expected: 24995000,
  },
  {
    name: 'if/else 10k',
    category: 'branching',
    input: 'let a = 0; let b = 0; let i = 0; while (i < 10000) { if (i > 4999) { b = b + 1; } else { a = a + 1; } i = i + 1; } a + b',
    expected: 10000,
  },
];

function parse(input) {
  const lexer = new Lexer(input);
  const parser = new Parser(lexer);
  return parser.parseProgram();
}

function timeN(fn, n) {
  const times = [];
  let result;
  // Warmup
  fn();
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], result };
}

async function timeNAsync(fn, n) {
  const times = [];
  let result;
  await fn();
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    result = await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], result };
}

const ITERS = 5;

console.log('Monkey Language — Five-Backend Benchmark');
console.log('=========================================\n');
console.log(`${'Benchmark'.padEnd(24)} ${'Eval'.padStart(10)} ${'VM'.padStart(10)} ${'JIT'.padStart(10)} ${'Transpiler'.padStart(12)} ${'WASM'.padStart(10)} ${'Fastest'.padStart(10)}`);
console.log('-'.repeat(90));

const results = [];

for (const bench of BENCHMARKS) {
  const program = parse(bench.input);
  const row = { name: bench.name, category: bench.category };

  try {
    // Eval
    const evalR = timeN(() => {
      const env = new Environment();
      return monkeyEval(program, env);
    }, ITERS);
    row.eval = evalR.median;

    // VM
    const vmR = timeN(() => {
      const c = new Compiler();
      c.compile(program);
      const vm = new VM(c.bytecode());
      vm.run();
      return vm.lastPoppedStackElem();
    }, ITERS);
    row.vm = vmR.median;

    // JIT
    const jitR = timeN(() => {
      const c = new Compiler();
      c.compile(program);
      const vm = new VM(c.bytecode());
      vm.enableJIT();
      vm.run();
      return vm.lastPoppedStackElem();
    }, ITERS);
    row.jit = jitR.median;

    // Transpiler
    try {
      const transpiler = new Transpiler();
      const jsCode = transpiler.transpile(program);
      // Wrap in a function that returns the last expression
      const lines = jsCode.trim().split('\n');
      const lastLine = lines[lines.length - 1].replace(/;$/, '');
      lines[lines.length - 1] = 'return ' + lastLine + ';';
      const wrappedCode = lines.join('\n');
      const transpilerFn = new Function(wrappedCode);
      const transR = timeN(() => transpilerFn(), ITERS);
      row.transpiler = transR.median;
    } catch (e) {
      row.transpiler = null;
    }

    // WASM
    const wasmExp = bench.wasmExpected !== undefined ? bench.wasmExpected : bench.expected;
    if (wasmExp !== null) {
      try {
        // Pre-compile once, then just instantiate+run per iteration
        const run = await wasmPrecompile(bench.input);
        
        const wasmR = await timeNAsync(async () => {
          return await run();
        }, ITERS);
        row.wasm = wasmR.median;
      } catch (e) {
        row.wasm = null;
      }
    } else {
      row.wasm = null;
    }

    // Find fastest
    const backends = [
      { name: 'Eval', time: row.eval },
      { name: 'VM', time: row.vm },
      { name: 'JIT', time: row.jit },
      { name: 'Trans', time: row.transpiler },
      { name: 'WASM', time: row.wasm },
    ].filter(b => b.time != null);
    const fastest = backends.reduce((a, b) => a.time < b.time ? a : b);
    row.fastest = fastest.name;

    const fmt = (v) => v != null ? (v.toFixed(2) + 'ms').padStart(10) : 'N/A'.padStart(10);
    console.log(
      `${bench.name.padEnd(24)} ${fmt(row.eval)} ${fmt(row.vm)} ${fmt(row.jit)} ${fmt(row.transpiler).padStart(12)} ${fmt(row.wasm)} ${row.fastest.padStart(10)}`
    );

    results.push(row);
  } catch (err) {
    console.log(`${bench.name.padEnd(24)} ERROR: ${err.message.slice(0, 50)}`);
  }
}

console.log('\n(Median of 5 runs)\n');

// Summary
console.log('Summary');
console.log('=======');
const wasmResults = results.filter(r => r.wasm != null);
const jitResults = results.filter(r => r.jit != null);

if (wasmResults.length > 0) {
  const wasmVsVM = wasmResults.reduce((acc, r) => acc + r.vm / r.wasm, 0) / wasmResults.length;
  const wasmVsJIT = wasmResults.reduce((acc, r) => acc + r.jit / r.wasm, 0) / wasmResults.length;
  console.log(`WASM vs VM:  ${wasmVsVM.toFixed(1)}x avg speedup (${wasmResults.length} benchmarks)`);
  console.log(`WASM vs JIT: ${wasmVsJIT.toFixed(1)}x avg speedup (${wasmResults.length} benchmarks)`);
}

if (jitResults.length > 0) {
  const jitVsVM = jitResults.reduce((acc, r) => acc + r.vm / r.jit, 0) / jitResults.length;
  console.log(`JIT vs VM:   ${jitVsVM.toFixed(1)}x avg speedup (${jitResults.length} benchmarks)`);
}

const totalFastest = {};
for (const r of results) {
  totalFastest[r.fastest] = (totalFastest[r.fastest] || 0) + 1;
}
console.log('\nWins by backend:', Object.entries(totalFastest).map(([k,v]) => `${k}: ${v}`).join(', '));
console.log();
