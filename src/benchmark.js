// benchmark.js — Mandelbrot set computation benchmark
// Compares: WASM compilation vs bytecode VM for the same monkey-lang code
import { compileToWasm } from './wasm-compiler.js';
import { compileWithPrelude } from './prelude.js';
import { VM } from './vm.js';

// Mandelbrot iteration count at a point (WASM-compatible subset)
// Using x100 fixed-point to avoid i32 overflow
const mandelbrotSrc = `
let mandelbrot_iter = fn(cx, cy, max_iter) {
  let zx = 0;
  let zy = 0;
  let i = 0;
  while (i < max_iter) {
    let zx2 = (zx * zx) / 100;
    let zy2 = (zy * zy) / 100;
    if (zx2 + zy2 > 400) { return i; };
    let new_zx = zx2 - zy2 + cx;
    set zy = 2 * (zx * zy) / 100 + cy;
    set zx = new_zx;
    set i = i + 1;
  };
  max_iter;
};

let mandelbrot_grid = fn(width, height, max_iter) {
  let total = 0;
  for (let y = 0; y < height; set y = y + 1) {
    for (let x = 0; x < width; set x = x + 1) {
      let cx = (x * 300 / width) - 200;
      let cy = (y * 200 / height) - 100;
      let iter = mandelbrot_iter(cx, cy, max_iter);
      set total = total + iter;
    };
  };
  total;
};
`;

console.log('=== Mandelbrot Benchmark ===\n');
console.log('Computing Mandelbrot set iterations over a grid.');
console.log('Using fixed-point arithmetic (x1000 scale).\n');

// WASM compilation
console.log('Compiling to WASM...');
const wasmBinary = compileToWasm(mandelbrotSrc);
console.log(`WASM binary: ${wasmBinary.length} bytes`);
const wasmMod = new WebAssembly.Module(wasmBinary);
const wasmInstance = new WebAssembly.Instance(wasmMod);

// Bytecode compilation
console.log('Compiling to bytecode...\n');
const vmBytecode = compileWithPrelude(mandelbrotSrc + 'mandelbrot_grid(80, 60, 100);');

// Verify correctness
const wasmResult = wasmInstance.exports.mandelbrot_grid(80, 60, 100);
const vmObj = new VM(vmBytecode);
vmObj.run();
const vmResult = vmObj.lastPoppedStackElem()?.value;
console.log(`WASM result: ${wasmResult}`);
console.log(`VM result:   ${vmResult}`);
console.log(`Match: ${wasmResult === vmResult ? '✅' : '❌'}\n`);

// Benchmark configurations
const configs = [
  { name: '20x15 grid, 50 iter', w: 20, h: 15, maxIter: 50 },
  { name: '40x30 grid, 100 iter', w: 40, h: 30, maxIter: 100 },
  { name: '80x60 grid, 100 iter', w: 80, h: 60, maxIter: 100 },
];

for (const cfg of configs) {
  console.log(`--- ${cfg.name} ---`);
  
  // WASM benchmark
  const wasmTimes = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    wasmInstance.exports.mandelbrot_grid(cfg.w, cfg.h, cfg.maxIter);
    wasmTimes.push(performance.now() - start);
  }
  const wasmAvg = wasmTimes.reduce((a, b) => a + b) / 5;
  
  // VM benchmark
  const vmTimes = [];
  const vmBc = compileWithPrelude(mandelbrotSrc + `mandelbrot_grid(${cfg.w}, ${cfg.h}, ${cfg.maxIter});`);
  for (let i = 0; i < 3; i++) {
    const vm = new VM(vmBc);
    const start = performance.now();
    vm.run();
    vmTimes.push(performance.now() - start);
  }
  const vmAvg = vmTimes.reduce((a, b) => a + b) / 3;
  
  console.log(`  WASM: ${wasmAvg.toFixed(2)}ms`);
  console.log(`  VM:   ${vmAvg.toFixed(2)}ms`);
  console.log(`  Speedup: ${(vmAvg / wasmAvg).toFixed(1)}x\n`);
}
