// jit-stress.test.js — Verify JIT produces same results as interpreter
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { MonkeyInteger, MonkeyString, MonkeyBoolean, MonkeyArray } from './object.js';

function parse(input) {
  return new Parser(new Lexer(input)).parseProgram();
}

function runVM(input) {
  const compiler = new Compiler();
  compiler.compile(parse(input));
  const vm = new VM(compiler.bytecode());
  vm.run();
  return vm.lastPoppedStackElem();
}

function runJIT(input) {
  const compiler = new Compiler();
  compiler.compile(parse(input));
  const vm = new VM(compiler.bytecode());
  vm.enableJIT();
  vm.run();
  return vm.lastPoppedStackElem();
}

function resultToString(r) {
  if (!r) return 'null';
  if (r.value !== undefined) return String(r.value);
  if (r.elements) return '[' + r.elements.map(resultToString).join(',') + ']';
  return String(r);
}

function assertSame(input) {
  const vmResult = resultToString(runVM(input));
  const jitResult = resultToString(runJIT(input));
  assert.equal(jitResult, vmResult, `JIT≠VM for: ${input.slice(0, 60)}...`);
}

describe('JIT vs VM Equivalence — Stress', () => {
  // Simple arithmetic
  it('integer arithmetic', () => assertSame('1 + 2 * 3'));
  it('division', () => assertSame('10 / 3'));
  it('modulo', () => assertSame('17 % 5'));
  it('negation', () => assertSame('-42'));
  it('complex expression', () => assertSame('(2 + 3) * (7 - 4) / 2'));

  // Booleans
  it('true', () => assertSame('true'));
  it('false', () => assertSame('false'));
  it('comparison', () => assertSame('5 > 3'));
  it('equality', () => assertSame('1 == 1'));
  it('inequality', () => assertSame('1 != 2'));
  it('not', () => assertSame('!false'));

  // Conditionals
  it('if true', () => assertSame('if (true) { 42 } else { 0 }'));
  it('if false', () => assertSame('if (false) { 42 } else { 0 }'));
  it('nested if', () => assertSame('if (1 > 0) { if (2 > 1) { 99 } else { 0 } } else { -1 }'));

  // Variables
  it('let binding', () => assertSame('let x = 42; x'));
  it('multiple lets', () => assertSame('let x = 10; let y = 20; x + y'));
  it('variable in expression', () => assertSame('let a = 5; let b = 3; a * b + 2'));

  // Functions
  it('simple function', () => assertSame('let f = fn(x) { x * 2 }; f(21)'));
  it('closure', () => assertSame('let adder = fn(x) { fn(y) { x + y } }; adder(5)(3)'));
  it('recursive factorial', () => assertSame('let fact = fn(n) { if (n <= 1) { 1 } else { n * fact(n - 1) } }; fact(10)'));

  // Loops (exercise JIT hot path detection)
  it('while loop sum', () => assertSame(`
    let sum = 0;
    let i = 0;
    while (i < 100) {
      set sum = sum + i;
      set i = i + 1;
    }
    sum
  `));

  it('while loop product', () => assertSame(`
    let prod = 1;
    let i = 1;
    while (i <= 10) {
      set prod = prod * i;
      set i = i + 1;
    }
    prod
  `));

  it('nested while loops', () => assertSame(`
    let total = 0;
    let i = 0;
    while (i < 5) {
      let j = 0;
      while (j < 5) {
        set total = total + 1;
        set j = j + 1;
      }
      set i = i + 1;
    }
    total
  `));

  // Arrays
  it('array literal', () => assertSame('[1, 2, 3][1]'));
  it('array length', () => assertSame('len([1, 2, 3, 4])'));

  // Strings
  it('string concat', () => assertSame('"hello" + " " + "world"'));
  it('string comparison', () => assertSame('"abc" == "abc"'));

  // Edge cases
  it('zero division', () => assertSame('10 / 0'));
  it('large fibonacci', () => assertSame(`
    let fib = fn(n) {
      if (n <= 1) { n }
      else { fib(n - 1) + fib(n - 2) }
    };
    fib(15)
  `));

  it('many iterations trigger JIT', () => assertSame(`
    let sum = 0;
    let i = 0;
    while (i < 1000) {
      set sum = sum + i;
      set i = i + 1;
    }
    sum
  `));

  it('function call in loop', () => assertSame(`
    let double = fn(x) { x * 2 };
    let sum = 0;
    let i = 0;
    while (i < 50) {
      set sum = sum + double(i);
      set i = i + 1;
    }
    sum
  `));
});
