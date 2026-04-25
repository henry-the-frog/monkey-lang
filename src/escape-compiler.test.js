// escape-compiler.test.js — Tests for escape analysis integration with compiler+VM
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Compiler, CompiledFunction, Closure } from './compiler.js';
import { VM } from './vm.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { EscapeAnalyzer, STACK, HEAP } from './escape.js';

function compile(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  const c = new Compiler();
  c.compile(prog);
  return c.bytecode();
}

function getCompiledFunctions(bc) {
  return bc.constants.filter(c => c instanceof CompiledFunction);
}

function runVM(input) {
  const bc = compile(input);
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem();
}

function analyzeEscape(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  const a = new EscapeAnalyzer();
  return a.analyze(prog);
}

describe('escape analysis - compiler integration', () => {
  describe('escape detection', () => {
    it('marks returned closure as escaping', () => {
      const info = analyzeEscape('let maker = fn() { let x = 0; fn() { x; }; };');
      assert.strictEqual(info.variables.get('x').state, HEAP);
    });

    it('marks local-only variable as stack', () => {
      const info = analyzeEscape('let f = fn() { let x = 10; let y = x + 1; y; };');
      // x doesn't escape (only used in arithmetic), f is stack
      assert.strictEqual(info.variables.get('f').state, STACK);
    });

    it('marks mutable captured variable as escaping', () => {
      const info = analyzeEscape('let c = fn() { let n = 0; fn() { set n = n + 1; n; }; };');
      assert.strictEqual(info.variables.get('n').state, HEAP);
    });

    it('marks variable passed as argument as escaping', () => {
      const info = analyzeEscape('let f = fn(callback) { callback(10); }; let x = fn(n) { n; }; f(x);');
      assert.strictEqual(info.variables.get('x').state, HEAP);
    });
  });

  describe('compiler annotations', () => {
    it('annotates CompiledFunction with escapes field', () => {
      const bc = compile('let f = fn() { 42; };');
      const fns = getCompiledFunctions(bc);
      assert.ok(fns.length >= 1);
      assert.ok('escapes' in fns[0]);
    });

    it('non-escaping simple function has escapes=false', () => {
      const bc = compile('let add = fn(a, b) { a + b; }; add(1, 2);');
      const fns = getCompiledFunctions(bc);
      assert.ok(fns.some(f => f.escapes === false));
    });

    it('returned inner closure has escapes=true', () => {
      const bc = compile('let maker = fn() { let x = 0; fn() { x; }; }; maker();');
      const fns = getCompiledFunctions(bc);
      // Inner closure (depth-first order, first constant) should have escapes=true
      assert.ok(fns.some(f => f.escapes === true));
    });
  });

  describe('VM correctness with escape optimization', () => {
    it('non-escaping closures produce correct results', () => {
      const result = runVM('let add = fn(a, b) { a + b; }; add(10, 20);');
      assert.strictEqual(result.value, 30);
    });

    it('escaping closures (counter) still work correctly', () => {
      const result = runVM(`
        let makeCounter = fn() {
          let count = 0;
          fn() { set count = count + 1; count; };
        };
        let c = makeCounter();
        c(); c(); c();
      `);
      assert.strictEqual(result.value, 3);
    });

    it('recursive function with non-escaping helper', () => {
      const result = runVM(`
        let fib = fn(n) {
          if (n < 2) { n; }
          else { fib(n - 1) + fib(n - 2); };
        };
        fib(10);
      `);
      assert.strictEqual(result.value, 55);
    });

    it('higher-order function with callback', () => {
      const result = runVM(`
        let apply = fn(f, x) { f(x); };
        apply(fn(n) { n * 3; }, 7);
      `);
      assert.strictEqual(result.value, 21);
    });

    it('nested closures with shared state', () => {
      const result = runVM(`
        let make = fn() {
          let x = 10;
          let inc = fn() { set x = x + 5; x; };
          let get = fn() { x; };
          [inc, get];
        };
        let pair = make();
        let inc = pair[0];
        let get = pair[1];
        inc(); inc();
        get();
      `);
      assert.strictEqual(result.value, 20);
    });

    it('accumulator pattern', () => {
      const result = runVM(`
        let acc = fn(init) {
          let sum = init;
          fn(n) { set sum = sum + n; sum; };
        };
        let a = acc(100);
        a(10); a(20); a(30);
      `);
      assert.strictEqual(result.value, 160);
    });
  });
});
