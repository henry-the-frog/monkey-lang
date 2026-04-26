// benchmark-full.js — Comprehensive WASM vs VM benchmark
import { compileToWasm } from './wasm-compiler.js';
import { compileWithPrelude } from './prelude.js';
import { VM } from './vm.js';

function benchWasm(source, funcName, args, opts = {}, runs = 10) {
  const binary = compileToWasm(source, opts);
  const mod = new WebAssembly.Module(binary);
  const inst = new WebAssembly.Instance(mod);
  const fn = inst.exports[funcName];
  
  // Warm up
  for (let i = 0; i < 3; i++) fn(...args);
  
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn(...args);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(runs / 2)], size: binary.length };
}

function benchVM(source, runs = 5) {
  const bc = compileWithPrelude(source);
  // Warm up
  new VM(bc).run();
  
  const times = [];
  for (let i = 0; i < runs; i++) {
    const vm = new VM(bc);
    const start = performance.now();
    vm.run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(runs / 2)] };
}

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║     Monkey-Lang Performance Benchmark: WASM vs Bytecode     ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// --- Fibonacci ---
const fibSrc = `let fib = fn(n) { if (n < 2) { n; } else { fib(n - 1) + fib(n - 2); }; };`;

console.log('═══ Recursive Fibonacci (fib(30)) ═══');
const fibI32 = benchWasm(fibSrc, 'fib', [30]);
const fibI64 = benchWasm(fibSrc, 'fib', [30n], { useI64: true });
const fibVM = benchVM(fibSrc + 'fib(30);');
console.log(`  WASM i32: ${fibI32.median.toFixed(2)}ms (${fibI32.size} bytes)`);
console.log(`  WASM i64: ${fibI64.median.toFixed(2)}ms (${fibI64.size} bytes)`);
console.log(`  Bytecode: ${fibVM.median.toFixed(2)}ms`);
console.log(`  Speedup:  ${(fibVM.median / fibI32.median).toFixed(0)}x (i32), ${(fibVM.median / fibI64.median).toFixed(0)}x (i64)\n`);

// --- Iterative Sum ---
const sumSrc = `let sum = fn(n) {
  let total = 0;
  let i = 1;
  while (i <= n) { set total = total + i; set i = i + 1; };
  total;
};`;

console.log('═══ Iterative Sum (sum(1000000)) ═══');
const sumI32 = benchWasm(sumSrc, 'sum', [1000000]);
const sumI64 = benchWasm(sumSrc, 'sum', [1000000n], { useI64: true });
const sumVM = benchVM(sumSrc + 'sum(1000000);', 3);
console.log(`  WASM i32: ${sumI32.median.toFixed(2)}ms (${sumI32.size} bytes)`);
console.log(`  WASM i64: ${sumI64.median.toFixed(2)}ms (${sumI64.size} bytes)`);
console.log(`  Bytecode: ${sumVM.median.toFixed(2)}ms`);
console.log(`  Speedup:  ${(sumVM.median / sumI32.median).toFixed(0)}x (i32), ${(sumVM.median / sumI64.median).toFixed(0)}x (i64)\n`);

// --- Mandelbrot (i32 fixed-point x100) ---
const mandelbrotSrc = `
let mandelbrot_grid = fn(width, height, max_iter) {
  let total = 0;
  for (let y = 0; y < height; set y = y + 1) {
    for (let x = 0; x < width; set x = x + 1) {
      let cx = (x * 300 / width) - 200;
      let cy = (y * 200 / height) - 100;
      let zx = 0; let zy = 0; let i = 0;
      while (i < max_iter) {
        let zx2 = (zx * zx) / 100;
        let zy2 = (zy * zy) / 100;
        if (zx2 + zy2 > 400) { set i = max_iter + i; };
        if (i < max_iter) {
          let nzx = zx2 - zy2 + cx;
          set zy = 2 * (zx * zy) / 100 + cy;
          set zx = nzx;
        };
        set i = i + 1;
      };
      set total = total + (i - max_iter);
    };
  };
  total;
};`;

console.log('═══ Mandelbrot (80x60, 100 iter, fixed-point x100) ═══');
const mbI32 = benchWasm(mandelbrotSrc, 'mandelbrot_grid', [80, 60, 100]);
const mbVM = benchVM(mandelbrotSrc + 'mandelbrot_grid(80, 60, 100);', 3);
console.log(`  WASM i32: ${mbI32.median.toFixed(2)}ms (${mbI32.size} bytes)`);
console.log(`  Bytecode: ${mbVM.median.toFixed(2)}ms`);
console.log(`  Speedup:  ${(mbVM.median / mbI32.median).toFixed(0)}x\n`);

// --- Float64 Mandelbrot ---
const mandelbrotF64 = `
let mandelbrot_f64 = fn(width, height, max_iter) {
  let total = 0.0;
  let fy = 0.0;
  while (fy < height) {
    let fx = 0.0;
    while (fx < width) {
      let cx = (fx * 3.0 / width) - 2.0;
      let cy = (fy * 2.0 / height) - 1.0;
      let zx = 0.0; let zy = 0.0; let i = 0.0;
      let escaped = 0.0;
      while (i < max_iter) {
        if (escaped < 1.0) {
          let zx2 = zx * zx;
          let zy2 = zy * zy;
          if (zx2 + zy2 > 4.0) {
            set escaped = 1.0;
          };
          if (escaped < 1.0) {
            let nzx = zx2 - zy2 + cx;
            set zy = 2.0 * zx * zy + cy;
            set zx = nzx;
          };
        };
        set i = i + 1.0;
      };
      if (escaped > 0.0) {
        set total = total + i;
      } else {
        set total = total + max_iter;
      };
      set fx = fx + 1.0;
    };
    set fy = fy + 1.0;
  };
  total;
};`;

console.log('═══ Mandelbrot f64 (80x60, 100 iter, real floats) ═══');
const mbF64 = benchWasm(mandelbrotF64, 'mandelbrot_f64', [80.0, 60.0, 100.0], { useF64: true });
console.log(`  WASM f64: ${mbF64.median.toFixed(2)}ms (${mbF64.size} bytes)\n`);

console.log('═══ Summary ═══');
console.log(`  Total WASM binary sizes: fib=${fibI32.size}B, sum=${sumI32.size}B, mandelbrot=${mbI32.size}B`);
console.log(`  Best speedup: ${Math.max(
  fibVM.median / fibI32.median,
  sumVM.median / sumI32.median,
  mbVM.median / mbI32.median
).toFixed(0)}x`);
