// bench.js — Benchmark evaluator vs VM performance
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';
import { compileWithPrelude } from './prelude.js';

const benchmarks = [
  {
    name: "fibonacci(25)",
    code: `
      let fib = fn(n) { if (n < 2) { n; } else { fib(n-1) + fib(n-2); }; };
      fib(25);
    `,
    expected: 75025
  },
  {
    name: "counter 10000",
    code: `
      let c = fn() { let n = 0; fn() { set n = n + 1; n; }; };
      let counter = c();
      let i = 0;
      while (i < 10000) { counter(); set i = i + 1; };
      counter();
    `,
    expected: 10001
  },
  {
    name: "local tight loop 100K",
    code: `
      let test = fn() {
        let sum = 0;
        for (let i = 0; i < 100000; set i = i + 1) {
          set sum = sum + i;
        };
        sum;
      };
      test();
    `,
    expected: 4999950000
  },
  {
    name: "hash set/get 1000",
    code: `
      let h = {};
      for (let i = 0; i < 1000; set i = i + 1) {
        set h[i] = i * 2;
      };
      h[500];
    `,
    expected: 1000
  },
  {
    name: "array map (prelude)*",
    code: `
      let arr = range(1, 101);
      map(arr, fn(x) { x * 2; });
    `,
    prelude: true
    // * Note: includes 6ms prelude compilation overhead. Eval has native map builtin.
  },
  {
    name: "string concat 1000",
    code: `
      let s = "";
      let i = 0;
      while (i < 1000) { set s = s + "a"; set i = i + 1; };
      len(s);
    `,
    expected: 1000
  },
  {
    name: "recursive sum 1..500",
    code: `
      let sum = fn(n) { if (n == 0) { 0; } else { n + sum(n - 1); }; };
      sum(500);
    `,
    expected: 125250
  },
  {
    name: "nested closures 5K",
    code: `
      let make = fn(x) {
        fn(y) {
          fn(z) { x + y + z; };
        };
      };
      let sum = 0;
      for (let i = 0; i < 5000; set i = i + 1) {
        set sum = sum + make(i)(i+1)(i+2);
      };
      sum;
    `,
  }
];

function runEval(code) {
  const l = new Lexer(code), p = new Parser(l), prog = p.parseProgram();
  return monkeyEval(prog, new Environment());
}

function runVM(code, usePrelude = false) {
  if (usePrelude) {
    const bc = compileWithPrelude(code);
    const vm = new VM(bc); vm.run();
    return vm.lastPoppedStackElem();
  }
  const l = new Lexer(code), p = new Parser(l), prog = p.parseProgram();
  const c = new Compiler(); c.compile(prog);
  const vm = new VM(c.bytecode()); vm.run();
  return vm.lastPoppedStackElem();
}

function bench(fn, iterations = 5) {
  // Warmup
  fn();
  
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]; // median
}

console.log("Monkey-Lang Performance Benchmark");
console.log("=".repeat(68));
console.log(`${"Benchmark".padEnd(25)} ${"Eval".padStart(10)} ${"VM".padStart(10)} ${"Speedup".padStart(10)} ${"Winner".padStart(8)}`);
console.log("-".repeat(68));

for (const bm of benchmarks) {
  try {
    const evalTime = bench(() => runEval(bm.code));
    const vmTime = bench(() => runVM(bm.code, bm.prelude));
    const ratio = (evalTime / vmTime).toFixed(1);
    const winner = vmTime < evalTime ? "VM" : "Eval";
    
    console.log(`${bm.name.padEnd(25)} ${(evalTime.toFixed(1) + "ms").padStart(10)} ${(vmTime.toFixed(1) + "ms").padStart(10)} ${(ratio + "x").padStart(10)} ${winner.padStart(8)}`);
  } catch (e) {
    console.log(`${bm.name.padEnd(25)} ERROR: ${e.message}`);
  }
}

console.log("-".repeat(68));
console.log("Done!");
