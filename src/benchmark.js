// benchmark.js — Compare evaluator vs VM performance
// Usage: node src/benchmark.js

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

function runEval(code) {
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  const env = new Environment();
  return monkeyEval(program, env);
}

function runVM(code) {
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  const c = new Compiler();
  c.compile(program);
  const vm = new VM(c.bytecode());
  vm.run();
  return vm.lastPoppedStackElem();
}

function bench(name, code, iterations = 100) {
  // Pre-parse and pre-compile
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  const c = new Compiler();
  c.compile(program);
  const bc = c.bytecode();
  
  // Warmup
  for (let i = 0; i < 3; i++) {
    monkeyEval(program, new Environment());
    const vm = new VM(bc); vm.run();
  }
  
  // Evaluator (parse + eval)
  const evalStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    monkeyEval(program, new Environment());
  }
  const evalTime = performance.now() - evalStart;
  
  // VM (compile + execute)
  const vmStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const vm = new VM(bc);
    vm.run();
  }
  const vmTime = performance.now() - vmStart;
  
  const speedup = (evalTime / vmTime).toFixed(2);
  console.log(`${name.padEnd(30)} | Eval: ${evalTime.toFixed(1).padStart(8)}ms | VM: ${vmTime.toFixed(1).padStart(8)}ms | Speedup: ${speedup}x`);
}

console.log('Monkey Language: Evaluator vs VM Benchmark');
console.log('='.repeat(80));
console.log(`${'Benchmark'.padEnd(30)} | ${'Evaluator'.padStart(14)} | ${'VM'.padStart(12)} | ${'Speedup'.padStart(10)}`);
console.log('-'.repeat(80));

// Fibonacci (recursive)
bench('Fibonacci(15)', `
let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } };
fib(15)
`, 50);

// Array operations
bench('Array map/filter', `
let map = fn(arr, f) {
  let iter = fn(arr, acc) {
    if (len(arr) == 0) { acc }
    else { iter(rest(arr), push(acc, f(first(arr)))) }
  };
  iter(arr, [])
};
let arr = [1,2,3,4,5,6,7,8,9,10];
map(arr, fn(x) { x * 2 })
`, 100);

// String operations
bench('String concatenation', `
let build = fn(n) {
  if (n == 0) { "" }
  else { "hello" + build(n - 1) }
};
build(20)
`, 100);

// Closure creation
bench('Closure creation', `
let make = fn(x) { fn(y) { x + y } };
let f1 = make(1);
let f2 = make(2);
let f3 = make(3);
f1(10) + f2(20) + f3(30)
`, 200);

// Hash operations
bench('Hash literal', `
let h = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5};
h["a"] + h["b"] + h["c"] + h["d"] + h["e"]
`, 200);

// Arithmetic
bench('Arithmetic (100 ops)', `
let x = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10;
let y = x * 2 + x * 3 + x * 4;
let z = y - x + y - x;
z
`, 500);

// Recursive sum
bench('Recursive sum(100)', `
let sum = fn(n) { if (n == 0) { 0 } else { n + sum(n-1) } };
sum(100)
`, 100);

// Nested function calls
bench('Nested calls', `
let a = fn(x) { x + 1 };
let b = fn(x) { a(x) + 1 };
let c = fn(x) { b(x) + 1 };
let d = fn(x) { c(x) + 1 };
d(10)
`, 500);

console.log('='.repeat(80));
console.log('Speedup > 1.0 means VM is faster than Evaluator');
