// opt-fuzz-advanced.test.js — Advanced optimizer fuzzer with closures, conditionals, loops
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

function runOpt(input, optimize) {
  const p = new Parser(new Lexer(input)).parseProgram();
  if (p.errors?.length > 0) return { error: true };
  try {
    const c = new Compiler({ optimize });
    c.compile(p);
    const bc = c.bytecode();
    const vm = new VM(bc);
    vm.run();
    return { value: vm.lastPoppedStackElem()?.inspect?.() ?? 'null' };
  } catch { return { error: true }; }
}

function assertSameResult(input) {
  const r1 = runOpt(input, false);
  const r2 = runOpt(input, true);
  if (r1.error && r2.error) return;
  if (r1.error || r2.error) {
    assert.fail(`One errored: unopt=${r1.error}, opt=${r2.error} for: ${input}`);
  }
  assert.strictEqual(r2.value, r1.value, `Divergence on: ${input}`);
}

describe('Advanced Optimizer Fuzzer', () => {
  describe('Closures', () => {
    it('simple closure', () => assertSameResult('let adder = fn(x) { fn(y) { x + y } }; let a = adder(5); a(3)'));
    it('closure over mutable', () => assertSameResult('let x = 10; let f = fn() { x }; set x = 20; f()'));
    it('multiple closures', () => assertSameResult('let make = fn(n) { fn() { n * 2 } }; let f = make(5); let g = make(10); f() + g()'));
    it('nested closures', () => assertSameResult('let a = fn(x) { fn(y) { fn(z) { x + y + z } } }; a(1)(2)(3)'));
    it('closure in loop', () => assertSameResult('let sum = 0; let i = 0; while (i < 5) { let x = i; let f = fn() { x }; set sum = sum + f(); set i = i + 1; } sum'));
  });

  describe('Conditionals', () => {
    it('nested if/else', () => assertSameResult('if (true) { if (false) { 1 } else { 2 } } else { 3 }'));
    it('conditional with variable', () => assertSameResult('let x = 10; if (x > 5) { x * 2 } else { x + 1 }'));
    it('chained conditions', () => assertSameResult('let x = 3; if (x > 5) { "big" } else { if (x > 2) { "med" } else { "small" } }'));
    it('conditional assignment', () => assertSameResult('let x = if (true) { 42 } else { 0 }; x'));
    it('conditional with comparison', () => assertSameResult('let a = 5; let b = 10; if (a < b) { a + b } else { a - b }'));
  });

  describe('Functions', () => {
    it('fibonacci', () => assertSameResult('let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(10)'));
    it('factorial', () => assertSameResult('let f = fn(n) { if (n == 0) { 1 } else { n * f(n-1) } }; f(7)'));
    it('higher order', () => assertSameResult('let apply = fn(f, x) { f(x) }; let double = fn(x) { x * 2 }; apply(double, 21)'));
    it('compose', () => assertSameResult('let compose = fn(f, g) { fn(x) { f(g(x)) } }; let add1 = fn(x) { x + 1 }; let mul2 = fn(x) { x * 2 }; compose(add1, mul2)(5)'));
    it('recursive sum', () => assertSameResult('let sum = fn(n) { if (n == 0) { 0 } else { n + sum(n-1) } }; sum(100)'));
  });

  describe('Loops', () => {
    it('while sum', () => assertSameResult('let s = 0; let i = 0; while (i < 10) { set s = s + i; set i = i + 1; } s'));
    it('for loop', () => assertSameResult('let s = 0; for (let i = 0; i < 10; set i = i + 1) { set s = s + i; } s'));
    it('nested loops', () => assertSameResult('let s = 0; let i = 0; while (i < 5) { let j = 0; while (j < 3) { set s = s + 1; set j = j + 1; } set i = i + 1; } s'));
    it('loop with break', () => assertSameResult('let s = 0; for (let i = 0; i < 100; set i = i + 1) { if (i == 5) { break; } set s = s + i; } s'));
    it('loop with continue', () => assertSameResult('let s = 0; for (let i = 0; i < 10; set i = i + 1) { if (i % 2 == 0) { continue; } set s = s + i; } s'));
  });

  describe('Arrays and Hashes', () => {
    it('array access', () => assertSameResult('[10, 20, 30][1]'));
    it('array length', () => assertSameResult('len([1, 2, 3, 4, 5])'));
    it('array push', () => assertSameResult('let a = push([1, 2], 3); len(a)'));
    it('hash access', () => assertSameResult('{"a": 1, "b": 2}["a"]'));
    it('nested array', () => assertSameResult('[[1, 2], [3, 4]][1][0]'));
  });

  describe('Strings', () => {
    it('concatenation', () => assertSameResult('"hello" + " " + "world"'));
    it('length', () => assertSameResult('len("hello world")'));
    it('in expression', () => assertSameResult('let g = fn(n) { "hi" + "!" }; g(1)'));
  });

  describe('Edge cases', () => {
    it('empty program', () => assertSameResult('1'));
    it('multiple statements', () => assertSameResult('1; 2; 3'));
    it('negative numbers', () => assertSameResult('-5 + 3'));
    it('boolean arithmetic', () => assertSameResult('if (!false) { 1 } else { 0 }'));
    it('null comparison', () => assertSameResult('if (null) { 1 } else { 0 }'));
  });
});
