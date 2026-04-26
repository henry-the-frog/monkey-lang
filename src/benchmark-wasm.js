// benchmark-wasm.js — Compare VM vs WASM (i32/i64/f64) across multiple algorithms
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { compileWithPrelude } from './prelude.js';
import { compileToWasm } from './wasm-compiler.js';

const benchmarks = [
  {
    name: "fibonacci(30)",
    code: `
      let fib = fn(n) { if (n < 2) { n; } else { fib(n-1) + fib(n-2); }; };
      fib(30);
    `,
    expected: 832040
  },
  {
    name: "factorial(20)",
    code: `
      let fact = fn(n) { if (n < 2) { 1; } else { n * fact(n - 1); }; };
      fact(20);
    `,
  },
  {
    name: "iterative sum 100K",
    code: `
      let sum = fn(n) {
        let i = 0;
        let total = 0;
        while (i < n) { set total = total + i; set i = i + 1; };
        total;
      };
      sum(100000);
    `,
  },
  {
    name: "nested loops 1000x1000",
    code: `
      let nested = fn(n) {
        let total = 0;
        let i = 0;
        while (i < n) {
          let j = 0;
          while (j < n) {
            set total = total + 1;
            set j = j + 1;
          };
          set i = i + 1;
        };
        total;
      };
      nested(1000);
    `,
    expected: 1000000
  },
  {
    name: "Mandelbrot (single point)",
    code: `
      let mandelbrot = fn(cx, cy, maxIter) {
        let x = 0;
        let y = 0;
        let i = 0;
        let escaped = 0;
        while (i < maxIter) {
          let x2 = x * x;
          let y2 = y * y;
          if (x2 + y2 > 4) {
            if (escaped == 0) { set escaped = i; };
          };
          let xNew = x2 - y2 + cx;
          set y = 2 * x * y + cy;
          set x = xNew;
          set i = i + 1;
        };
        if (escaped > 0) { escaped; } else { maxIter; };
      };
      mandelbrot(0, 0, 1000);
    `,
    expected: 1000
  },
  {
    name: "ackermann(3,7)",
    code: `
      let ack = fn(m, n) {
        if (m == 0) { n + 1; }
        else {
          if (n == 0) { ack(m - 1, 1); }
          else { ack(m - 1, ack(m, n - 1)); };
        };
      };
      ack(3, 7);
    `,
    expected: 1021
  },
];

function runVM(source) {
  const bc = compileWithPrelude(source);
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem()?.value;
}

async function runWasm(source, type) {
  const options = {
    useI64: type === 'i64',
    useF64: type === 'f64',
  };
  const binary = compileToWasm(source, options);
  const module = await WebAssembly.compile(binary);
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports.main();
}

async function benchmark(name, fn, warmup = 2, runs = 5) {
  // Warmup
  for (let i = 0; i < warmup; i++) await fn();
  
  // Timed runs
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = await fn();
    times.push({ elapsed: performance.now() - start, result });
  }
  
  const median = times.map(t => t.elapsed).sort((a, b) => a - b)[Math.floor(runs / 2)];
  return { median, result: times[0].result };
}

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║          Monkey-Lang Benchmark: VM vs WASM (i32/i64/f64)               ║');
console.log('╠══════════════════════════════════════════════════════════════════════════╣');
console.log('║ Benchmark               │   VM (ms)  │ WASM-i32   │ WASM-i64   │ WASM-f64  ║');
console.log('╠══════════════════════════╪════════════╪════════════╪════════════╪═══════════╣');

for (const bench of benchmarks) {
  const engines = {};
  
  // VM
  try {
    engines.vm = await benchmark(bench.name, () => runVM(bench.code));
  } catch (e) {
    engines.vm = { median: NaN, result: 'ERR' };
  }
  
  // WASM i32
  try {
    engines.i32 = await benchmark(bench.name, () => runWasm(bench.code, 'i32'));
  } catch (e) {
    engines.i32 = { median: NaN, result: 'ERR' };
  }
  
  // WASM i64
  try {
    engines.i64 = await benchmark(bench.name, () => runWasm(bench.code, 'i64'));
  } catch (e) {
    engines.i64 = { median: NaN, result: 'ERR' };
  }
  
  // WASM f64
  try {
    engines.f64 = await benchmark(bench.name, () => runWasm(bench.code, 'f64'));
  } catch (e) {
    engines.f64 = { median: NaN, result: 'ERR' };
  }
  
  const pad = (s, n) => String(s).padStart(n);
  const fmt = (v) => isNaN(v) ? pad('ERR', 10) : pad(v.toFixed(2), 10);
  const speedup = (base, other) => {
    if (isNaN(base) || isNaN(other) || other === 0) return '';
    const ratio = base / other;
    return ratio >= 1 ? `(${ratio.toFixed(0)}x)` : `(${(1/ratio).toFixed(1)}x slower)`;
  };
  
  const name = bench.name.padEnd(24);
  const vmMs = fmt(engines.vm.median);
  const i32Ms = `${fmt(engines.i32.median)} ${speedup(engines.vm.median, engines.i32.median)}`;
  const i64Ms = `${fmt(engines.i64.median)} ${speedup(engines.vm.median, engines.i64.median)}`;
  const f64Ms = `${fmt(engines.f64.median)} ${speedup(engines.vm.median, engines.f64.median)}`;
  
  console.log(`║ ${name}│ ${vmMs} │ ${i32Ms.padEnd(10)} │ ${i64Ms.padEnd(10)} │ ${f64Ms.padEnd(9)} ║`);
  
  // Verify results match expected
  if (bench.expected !== undefined) {
    const results = { vm: engines.vm.result, i32: engines.i32.result, i64: engines.i64.result, f64: engines.f64.result };
    for (const [eng, val] of Object.entries(results)) {
      if (val !== 'ERR' && Number(val) !== bench.expected) {
        console.log(`║   ⚠ ${eng} got ${val}, expected ${bench.expected}`);
      }
    }
  }
}

console.log('╚══════════════════════════════════════════════════════════════════════════╝');
