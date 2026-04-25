// optimizer.test.js — Tests for Bytecode Optimizer
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { optimize, optimizeWithStats } from './optimizer.js';
import { disassemble, Opcodes } from './code.js';

function compile(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const prog = p.parseProgram();
  if (p.errors.length > 0) throw new Error(`Parser errors: ${p.errors.join(', ')}`);
  const c = new Compiler({ optimize: false });
  c.compile(prog);
  return c.bytecode();
}

function runOptimized(input) {
  const bc = compile(input);
  const opt = optimize(bc.instructions);
  bc.instructions = opt;
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem();
}

function getStats(input) {
  const bc = compile(input);
  const { stats } = optimizeWithStats(bc.instructions);
  return stats;
}

describe('Bytecode Optimizer', () => {
  describe('Dead code elimination', () => {
    it('removes dead code after unconditional jump', () => {
      // if(true) generates: OpTrue, JumpNotTruthy, <true-branch>, Jump, <false-branch>
      // Optimizer: OpTrue+JumpNotTruthy → falls through, false-branch becomes dead
      const stats = getStats('if (true) { 42 } else { 99 }');
      assert.ok(stats.savedBytes > 0, 'should save bytes');
    });

    it('preserves reachable code', () => {
      const result = runOptimized('let x = 10; x');
      assert.equal(result.value, 10);
    });

    it('preserves jump targets', () => {
      const result = runOptimized('if (true) { 1 } else { 2 }');
      assert.equal(result.value, 1);
    });
  });

  describe('Peephole optimization', () => {
    it('eliminates OpTrue + JumpNotTruthy', () => {
      const stats = getStats('if (true) { 42 } else { 0 }');
      assert.ok(stats.savedBytes > 0);
      assert.equal(runOptimized('if (true) { 42 } else { 0 }').value, 42);
    });

    it('converts OpFalse + JumpNotTruthy to OpJump', () => {
      const stats = getStats('if (false) { 42 } else { 99 }');
      assert.ok(stats.savedBytes > 0);
      assert.equal(runOptimized('if (false) { 42 } else { 99 }').value, 99);
    });

    it('converts OpNull + JumpNotTruthy to OpJump', () => {
      const stats = getStats('if (null) { 42 } else { 99 }');
      assert.ok(stats.savedBytes > 0);
      assert.equal(runOptimized('if (null) { 42 } else { 99 }').value, 99);
    });
  });

  describe('Correctness preservation', () => {
    it('simple arithmetic', () => {
      assert.equal(runOptimized('let a = 1; let b = 2; a + b').value, 3);
    });

    it('function calls', () => {
      assert.equal(runOptimized('let f = fn(x) { x + 1 }; f(5)').value, 6);
    });

    it('recursion', () => {
      assert.equal(runOptimized(`
        let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } };
        fib(10)
      `).value, 55);
    });

    it('closures', () => {
      assert.equal(runOptimized(`
        let make = fn(x) { fn(y) { x + y } };
        make(5)(10)
      `).value, 15);
    });

    it('mutable closures', () => {
      assert.equal(runOptimized(`
        let make = fn() {
          let n = 0;
          let inc = fn() { set n = n + 1; n };
          inc
        };
        let c = make();
        c(); c(); c()
      `).value, 3);
    });

    it('arrays', () => {
      assert.equal(runOptimized('[1, 2, 3][1]').value, 2);
    });

    it('for-in loop', () => {
      assert.equal(runOptimized(`
        let sum = 0;
        for (x in [1,2,3,4,5]) { set sum = sum + x; }
        sum
      `).value, 15);
    });

    it('match expression', () => {
      assert.equal(runOptimized('match 2 { 1 => "one", 2 => "two", _ => "other" }').value, 'two');
    });

    it('match with arrays', () => {
      assert.equal(runOptimized('match [1,2] { [1,2] => "yes", _ => "no" }').value, 'yes');
    });

    it('string operations', () => {
      assert.equal(runOptimized('"hello" + " " + "world"').value, 'hello world');
    });

    it('nested if/else', () => {
      assert.equal(runOptimized(`
        let x = 3;
        if (x > 5) { "big" } else { if (x > 1) { "medium" } else { "small" } }
      `).value, 'medium');
    });

    it('tail calls', () => {
      assert.equal(runOptimized(`
        let sum = fn(n, acc) { if (n == 0) { acc } else { sum(n - 1, acc + n) } };
        sum(100, 0)
      `).value, 5050);
    });
  });

  describe('Optimization statistics', () => {
    it('reports zero reduction when no optimization possible', () => {
      const stats = getStats('let x = 42; x');
      assert.equal(stats.savedBytes, 0);
    });

    it('reports positive reduction on optimizable code', () => {
      const stats = getStats('if (true) { 1 } else { 2 }');
      assert.ok(stats.savedBytes > 0);
      assert.ok(parseFloat(stats.reductionPct) > 0);
    });

    it('original size >= optimized size', () => {
      const stats = getStats('if (false) { 1 } else { 2 }');
      assert.ok(stats.originalSize >= stats.optimizedSize);
    });
  });

  describe('Edge cases', () => {
    it('empty-ish program', () => {
      assert.equal(runOptimized('0').value, 0);
    });

    it('already optimal code', () => {
      const bc = compile('let x = 42; x');
      const opt = optimize(bc.instructions);
      assert.equal(opt.length, bc.instructions.length);
    });

    it('multiple optimizations stack', () => {
      // if (true) { if (true) { 42 } else { 0 } } else { 0 }
      const result = runOptimized('if (true) { if (true) { 42 } else { 0 } } else { 0 }');
      assert.equal(result.value, 42);
    });
  });
});
