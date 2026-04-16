// vm-stress.test.js — Edge case stress tests for the Monkey VM
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';

function run(input) {
  const p = new Parser(new Lexer(input)).parseProgram();
  const c = new Compiler();
  const err = c.compile(p);
  if (err) throw new Error('Compile error: ' + err);
  const vm = new VM(c.bytecode());
  vm.run();
  return vm.lastPoppedStackElem();
}

function val(r) { return r?.value; }

describe('VM Stress — Edge Cases', () => {
  it('deep recursion: fib(20)', () => {
    assert.equal(val(run('let fib = fn(n) { if (n <= 1) { n } else { fib(n-1) + fib(n-2) } }; fib(20)')), 6765);
  });

  it('deep recursion: ackermann(3, 4)', () => {
    assert.equal(val(run(`
      let ack = fn(m, n) {
        if (m == 0) { n + 1 }
        else { if (n == 0) { ack(m - 1, 1) } else { ack(m - 1, ack(m, n - 1)) } }
      };
      ack(3, 4)
    `)), 125);
  });

  it('closure captures value', () => {
    assert.equal(val(run('let f = fn(x) { fn(y) { x + y } }; let a = f(5); a(10)')), 15);
  });

  it('multiple closures share nothing', () => {
    assert.equal(val(run('let f = fn(x) { fn(y) { x + y } }; let a = f(10); let b = f(20); a(1) + b(1)')), 32);
  });

  it('deep nested closures', () => {
    assert.equal(val(run('let f = fn(a) { fn(b) { fn(c) { a + b + c } } }; f(1)(2)(3)')), 6);
  });

  it('nested arrays', () => {
    assert.equal(val(run('let m = [[1,2,3],[4,5,6],[7,8,9]]; m[1][2]')), 6);
  });

  it('recursive array sum', () => {
    assert.equal(val(run(`
      let sumArr = fn(arr, i) {
        if (i >= len(arr)) { 0 } else { arr[i] + sumArr(arr, i + 1) }
      };
      sumArr([1,2,3,4,5], 0)
    `)), 15);
  });

  it('string concatenation', () => {
    assert.equal(val(run('"hello" + " " + "world"')), 'hello world');
  });

  it('hash literal', () => {
    assert.equal(val(run('let h = {"a": 1, "b": 2}; h["b"]')), 2);
  });

  it('compose pattern', () => {
    assert.equal(val(run(`
      let compose = fn(f, g) { fn(x) { f(g(x)) } };
      let dbl = fn(x) { x * 2 };
      let inc = fn(x) { x + 1 };
      compose(dbl, inc)(5)
    `)), 12);
  });

  it('apply pattern', () => {
    assert.equal(val(run('let apply = fn(f, x) { f(x) }; apply(fn(x) { x * x }, 7)')), 49);
  });

  it('recursive sum to 100', () => {
    assert.equal(val(run('let sum = fn(n) { if (n <= 0) { 0 } else { n + sum(n - 1) } }; sum(100)')), 5050);
  });

  it('empty array len', () => {
    assert.equal(val(run('len([])')), 0);
  });

  it('triple nested functions', () => {
    assert.equal(val(run(`
      let outer = fn() { let mid = fn() { let inner = fn() { 42 }; inner() }; mid() };
      outer()
    `)), 42);
  });

  it('shadowing in nested scopes', () => {
    assert.equal(val(run(`
      let x = 1;
      let f = fn() { let x = 2; let g = fn() { let x = 3; x }; g() };
      f()
    `)), 3);
  });

  it('first class functions', () => {
    assert.equal(val(run(`
      let twice = fn(f, x) { f(f(x)) };
      twice(fn(x) { x + 3 }, 10)
    `)), 16);
  });

  it('array push', () => {
    assert.equal(val(run('len(push(push(push([], 1), 2), 3))')), 3);
  });

  it('boolean expressions', () => {
    assert.equal(val(run('(5 > 3) == true')), true);
    assert.equal(val(run('(5 < 3) == false')), true);
  });

  it('complex arithmetic', () => {
    assert.equal(val(run('(2 + 3) * (7 - 4) / 3')), 5);
  });
});
