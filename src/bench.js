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
    name: "array map (prelude)",
    code: `
      let arr = range(1, 101);
      map(arr, fn(x) { x * 2; });
    `,
    prelude: true
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
    name: "recursive sum 1..1000",
    code: `
      let sum = fn(n) { if (n == 0) { 0; } else { n + sum(n - 1); }; };
      sum(1000);
    `,
    expected: 500500
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
console.log("=".repeat(60));
console.log("");

for (const bm of benchmarks) {
  const evalTime = bench(() => runEval(bm.code));
  const vmTime = bench(() => runVM(bm.code, bm.prelude));
  const ratio = (evalTime / vmTime).toFixed(1);
  const winner = vmTime < evalTime ? "VM" : "Eval";
  
  console.log(`${bm.name}`);
  console.log(`  Evaluator: ${evalTime.toFixed(1)}ms`);
  console.log(`  VM:        ${vmTime.toFixed(1)}ms`);
  console.log(`  Winner:    ${winner} (${ratio}x)`);
  console.log("");
}

console.log("Done!");
