// closure-mutation.test.js — Regression tests for VM closure mutation
// Bug: VM returned 0 for counter pattern, evaluator returned 3
// Fixed by: const-subst removeMutated() (Apr 25, 2026)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VM } from './vm.js';
import { Compiler } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';

function runVM(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  const c = new Compiler();
  c.compile(prog);
  const vm = new VM(c.bytecode());
  vm.run();
  return vm.lastPoppedStackElem();
}

function runEval(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  return monkeyEval(prog, new Environment());
}

function assertBothEqual(input, expected, msg) {
  const evalRes = runEval(input);
  const vmRes = runVM(input);
  const ev = evalRes?.value ?? evalRes;
  const vv = vmRes?.value ?? vmRes;
  assert.strictEqual(ev, expected, `${msg} (evaluator)`);
  assert.strictEqual(vv, expected, `${msg} (VM)`);
}

describe('closure mutation regression', () => {
  it('counter pattern — increment 3 times', () => {
    assertBothEqual(`
      let makeCounter = fn() {
        let count = 0;
        let inc = fn() { set count = count + 1; count; };
        inc;
      };
      let counter = makeCounter();
      counter(); counter(); counter();
    `, 3, 'counter should be 3 after 3 increments');
  });

  it('shared state between closures', () => {
    assertBothEqual(`
      let make = fn() {
        let x = 10;
        let inc = fn() { set x = x + 5; x; };
        let get = fn() { x; };
        [inc, get];
      };
      let pair = make();
      let inc = pair[0];
      let get = pair[1];
      inc(); inc(); get();
    `, 20, 'shared state after 2 increments');
  });

  it('nested closure mutation', () => {
    assertBothEqual(`
      let outer = fn() {
        let x = 0;
        let middle = fn() {
          let inner = fn() { set x = x + 1; x; };
          inner;
        };
        middle;
      };
      let m = outer();
      let i = m();
      i(); i(); i();
    `, 3, 'nested closure mutation');
  });

  it('accumulator pattern', () => {
    assertBothEqual(`
      let acc = fn(init) {
        let sum = init;
        fn(n) { set sum = sum + n; sum; };
      };
      let a = acc(0);
      a(10); a(20); a(30);
    `, 60, 'accumulator should be 60');
  });

  it('decrement counter', () => {
    assertBothEqual(`
      let counter = fn() {
        let n = 10;
        fn() { set n = n - 1; n; };
      };
      let dec = counter();
      dec(); dec(); dec();
    `, 7, 'decrement from 10, 3 times');
  });

  it('toggle boolean state', () => {
    assertBothEqual(`
      let toggle = fn() {
        let state = true;
        fn() {
          if (state) { set state = false; } else { set state = true; };
          state;
        };
      };
      let t = toggle();
      t(); t(); t();
    `, false, 'toggle 3 times from true');
  });

  it('multiple independent counters', () => {
    assertBothEqual(`
      let makeCounter = fn() {
        let c = 0;
        fn() { set c = c + 1; c; };
      };
      let a = makeCounter();
      let b = makeCounter();
      a(); a(); a();
      b(); b();
      a();
    `, 4, 'counter a should be 4 (independent from b)');
  });

  it('closure mutation in loop', () => {
    assertBothEqual(`
      let sum = fn() {
        let total = 0;
        let add = fn(n) { set total = total + n; total; };
        add;
      };
      let adder = sum();
      let i = 1;
      while (i <= 5) {
        adder(i);
        set i = i + 1;
      };
      adder(0);
    `, 15, 'sum 1..5 via closure');
  });

  it('string accumulation', () => {
    assertBothEqual(`
      let builder = fn() {
        let s = "";
        fn(part) { set s = s + part; s; };
      };
      let b = builder();
      b("hello"); b(" "); b("world");
    `, "hello world", 'string accumulation');
  });
});
