// const-subst.test.js — Tests for constant substitution optimization
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Compiler } from './compiler.js';
import { VM } from './vm.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';

function compileAndRun(code) {
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  assert.equal(p.errors.length, 0, `Parse errors: ${p.errors.join(', ')}`);
  const c = new Compiler();
  c.compile(program);
  const vm = new VM(c.bytecode());
  vm.run();
  return { result: vm.lastPoppedStackElem(), bytecode: c.bytecode() };
}

function evalCode(code) {
  const l = new Lexer(code);
  const p = new Parser(l);
  const program = p.parseProgram();
  return monkeyEval(program, new Environment());
}

describe('Constant substitution', () => {
  it('propagates simple integer constant', () => {
    const { result, bytecode } = compileAndRun('let x = 42; x');
    assert.equal(result.value, 42);
    // x should be substituted → 42 should be in constants
    assert.ok(bytecode.constants.some(c => c.value === 42));
  });

  it('propagates and folds arithmetic', () => {
    const { result } = compileAndRun('let x = 10; let y = x + 5; y');
    assert.equal(result.value, 15);
  });

  it('chains propagation through multiple variables', () => {
    const { result } = compileAndRun('let a = 3; let b = a * 4; let c = b + 2; c');
    assert.equal(result.value, 14); // 3*4+2
  });

  it('handles string constants', () => {
    const { result } = compileAndRun('let greeting = "hello"; greeting');
    assert.equal(result.value, 'hello');
  });

  it('handles boolean constants', () => {
    const { result } = compileAndRun('let flag = true; flag');
    assert.equal(result.value, true);
  });

  it('does not substitute inside function bodies (safety)', () => {
    // x could be shadowed in the closure — don't substitute
    const { result } = compileAndRun(`
      let x = 10;
      let f = fn(x) { x + 1 };
      f(20)
    `);
    assert.equal(result.value, 21); // fn uses its own x, not the outer one
  });

  it('evaluator and VM agree after optimization', () => {
    const code = 'let x = 5; let y = x * 3; let z = y + x; z';
    const evalResult = evalCode(code);
    const { result: vmResult } = compileAndRun(code);
    assert.equal(evalResult.value, vmResult.value);
    assert.equal(vmResult.value, 20); // 5*3 + 5
  });

  it('handles non-constant variables correctly', () => {
    // fn call result is not constant — should not be substituted
    const { result } = compileAndRun(`
      let add = fn(a, b) { a + b };
      let x = add(3, 4);
      x
    `);
    assert.equal(result.value, 7);
  });

  it('array constants are not substituted', () => {
    // Arrays are mutable — don't propagate
    const { result } = compileAndRun(`
      let arr = [1, 2, 3];
      arr[1]
    `);
    assert.equal(result.value, 2);
  });
});
