// optimizer-integration.test.js — Verify optimized bytecode produces same results
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Compiler } from './compiler.js';
import { Parser } from './parser.js';
import { Lexer } from './lexer.js';
import { VM } from './vm.js';

function parse(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  return p.parseProgram();
}

function runWithOptimize(input, optimize) {
  const program = parse(input);
  const compiler = new Compiler({ optimize });
  compiler.compile(program);
  const bc = compiler.bytecode();
  const vm = new VM(bc);
  vm.run();
  return { result: vm.lastPoppedStackElem(), byteLen: bc.instructions.length };
}

function assertSameResult(input) {
  const unopt = runWithOptimize(input, false);
  const opt = runWithOptimize(input, true);
  const uVal = unopt.result?.value ?? unopt.result;
  const oVal = opt.result?.value ?? opt.result;
  assert.deepStrictEqual(oVal, uVal, `Mismatch for: ${input}`);
  return { unoptLen: unopt.byteLen, optLen: opt.byteLen };
}

describe('Optimizer Integration', () => {
  describe('produces same results', () => {
    const cases = [
      '1 + 2',
      '10 * 3 + 5',
      'if (true) { 10 } else { 20 }',
      'if (false) { 10 } else { 20 }',
      'let x = 5; let y = x + 3; y',
      'let x = 10; if (x > 5) { x * 2 } else { 0 }',
      '"hello" + " " + "world"',
      '[1, 2, 3][1]',
      '{"a": 1, "b": 2}["a"]',
      'let add = fn(a, b) { a + b }; add(3, 4)',
      'let fib = fn(n) { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } }; fib(10)',
      'let x = 1; let y = 2; let z = 3; x + y + z',
      'if (1 > 2) { "yes" } else { "no" }',
      'let arr = [1, 2, 3, 4, 5]; len(arr)',
      'let fact = fn(n) { if (n == 0) { 1 } else { n * fact(n - 1) } }; fact(5)',
    ];

    for (const input of cases) {
      it(`same result for: ${input.substring(0, 50)}`, () => {
        assertSameResult(input);
      });
    }
  });

  describe('reduces bytecode size', () => {
    it('reduces conditionals with constant test', () => {
      const { unoptLen, optLen } = assertSameResult('if (true) { 10 } else { 20 }');
      assert.ok(optLen < unoptLen, `Expected reduction: ${unoptLen} -> ${optLen}`);
    });

    it('reduces false conditionals', () => {
      const { unoptLen, optLen } = assertSameResult('if (false) { 10 } else { 20 }');
      assert.ok(optLen < unoptLen, `Expected reduction: ${unoptLen} -> ${optLen}`);
    });
  });
});
