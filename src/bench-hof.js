// bench-hof.js — Benchmark native vs prelude HOF performance
import { VM } from './vm.js';
import { compileWithPrelude } from './prelude.js';

function bench(name, code, runs = 20) {
  const bc = compileWithPrelude(code);
  // Warm up
  for (let i = 0; i < 3; i++) {
    const vm = new VM(bc);
    vm.run();
  }
  const times = [];
  for (let i = 0; i < runs; i++) {
    const vm = new VM(bc);
    const start = performance.now();
    vm.run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(runs / 2)];
  const avg = times.reduce((a, b) => a + b) / runs;
  console.log(`  ${name}: median=${median.toFixed(2)}ms avg=${avg.toFixed(2)}ms`);
  return median;
}

console.log('=== HOF Benchmark (1000 elements) ===\n');

// Map
console.log('MAP:');
const nativeMap = bench('Native (callClosureSync)', `
  let arr = range(1, 1000);
  map(arr, fn(x) { x * 2; });
`);
const preludeMap = bench('Old recursive prelude', `
  let arr = range(1, 1000);
  let old_map = fn(arr, f) {
    let iter = fn(arr, acc) {
      if (len(arr) == 0) { acc; }
      else { iter(rest(arr), push(acc, f(first(arr)))); };
    };
    iter(arr, []);
  };
  old_map(arr, fn(x) { x * 2; });
`);
console.log(`  Speedup: ${(preludeMap / nativeMap).toFixed(1)}x\n`);

// Filter
console.log('FILTER:');
const nativeFilter = bench('Native (callClosureSync)', `
  let arr = range(1, 1000);
  filter(arr, fn(x) { x > 500; });
`);
const preludeFilter = bench('Old recursive prelude', `
  let arr = range(1, 1000);
  let old_filter = fn(arr, f) {
    let iter = fn(arr, acc) {
      if (len(arr) == 0) { acc; }
      else {
        let item = first(arr);
        if (f(item)) { iter(rest(arr), push(acc, item)); }
        else { iter(rest(arr), acc); };
      };
    };
    iter(arr, []);
  };
  old_filter(arr, fn(x) { x > 500; });
`);
console.log(`  Speedup: ${(preludeFilter / nativeFilter).toFixed(1)}x\n`);

// Reduce
console.log('REDUCE:');
const nativeReduce = bench('Native (callClosureSync)', `
  let arr = range(1, 1000);
  reduce(arr, 0, fn(acc, x) { acc + x; });
`);
const preludeReduce = bench('Old recursive prelude', `
  let arr = range(1, 1000);
  let old_reduce = fn(arr, init, f) {
    let iter = fn(arr, acc) {
      if (len(arr) == 0) { acc; }
      else { iter(rest(arr), f(acc, first(arr))); };
    };
    iter(arr, init);
  };
  old_reduce(arr, 0, fn(acc, x) { acc + x; });
`);
console.log(`  Speedup: ${(preludeReduce / nativeReduce).toFixed(1)}x\n`);
