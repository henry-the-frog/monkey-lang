// new-builtins.test.js — Tests for newly added builtins (Session B, Apr 25)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VM } from './vm.js';
import { Compiler } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';

function runVM(input) {
  const l = new Lexer(input), p = new Parser(l), prog = p.parseProgram();
  const c = new Compiler(); c.compile(prog);
  const vm = new VM(c.bytecode()); vm.run();
  return vm.lastPoppedStackElem();
}

function runEval(input) {
  const l = new Lexer(input), p = new Parser(l), prog = p.parseProgram();
  return monkeyEval(prog, new Environment());
}

function assertBothEqual(input, expected, msg) {
  const ev = runEval(input);
  const vv = runVM(input);
  const evalVal = ev?.value ?? ev?.inspect?.() ?? String(ev);
  const vmVal = vv?.value ?? vv?.inspect?.() ?? String(vv);
  assert.strictEqual(evalVal, expected, `${msg} (evaluator)`);
  assert.strictEqual(vmVal, expected, `${msg} (VM)`);
}

describe('bool builtin', () => {
  it('bool(0) → false', () => assertBothEqual('bool(0)', false, 'bool(0)'));
  it('bool(1) → true', () => assertBothEqual('bool(1)', true, 'bool(1)'));
  it('bool("") → false', () => assertBothEqual('bool("")', false, 'bool("")'));
  it('bool("hi") → true', () => assertBothEqual('bool("hi")', true, 'bool("hi")'));
  it('bool([]) → false', () => assertBothEqual('bool([])', false, 'bool([])'));
  it('bool([1]) → true', () => assertBothEqual('bool([1])', true, 'bool([1])'));
  it('bool(null) → false', () => {
    // null needs special handling — evaluator uses NULL singleton
    const ev = runEval('let x = if (false) { 1; }; bool(x);');
    assert.strictEqual(ev?.value ?? ev?.inspect?.(), false, 'bool(null) eval');
  });
});

describe('char and ord builtins', () => {
  it('char(65) → "A"', () => assertBothEqual('char(65)', 'A', 'char(65)'));
  it('char(97) → "a"', () => assertBothEqual('char(97)', 'a', 'char(97)'));
  it('ord("A") → 65', () => assertBothEqual('ord("A")', 65, 'ord("A")'));
  it('ord("a") → 97', () => assertBothEqual('ord("a")', 97, 'ord("a")'));
  it('roundtrip: char(ord("Z")) → "Z"', () => assertBothEqual('char(ord("Z"))', 'Z', 'roundtrip'));
});

describe('padStart and padEnd', () => {
  it('padStart("42", 5, "0") → "00042"', () => assertBothEqual('padStart("42", 5, "0")', '00042', 'padStart'));
  it('padEnd("hi", 5) → "hi   "', () => assertBothEqual('padEnd("hi", 5)', 'hi   ', 'padEnd'));
  it('padStart("hello", 3) → "hello" (no truncation)', () => assertBothEqual('padStart("hello", 3)', 'hello', 'no truncation'));
  it('padStart("1", 4, "0") → "0001"', () => assertBothEqual('padStart("1", 4, "0")', '0001', 'padStart 4'));
  it('padEnd("x", 4, ".") → "x..."', () => assertBothEqual('padEnd("x", 4, ".")', 'x...', 'padEnd dots'));
});

describe('math builtins (VM)', () => {
  it('float(42) → 42', () => {
    const r = runVM('float(42)');
    assert.strictEqual(r.value, 42);
  });
  it('floor(3.7) → 3', () => assertBothEqual('floor(3.7)', 3, 'floor'));
  it('ceil(3.2) → 4', () => assertBothEqual('ceil(3.2)', 4, 'ceil'));
  it('sqrt(16) → 4', () => assertBothEqual('sqrt(16)', 4, 'sqrt'));
  it('sqrt(2) → ~1.414', () => {
    const r = runVM('sqrt(2)');
    assert.ok(Math.abs(r.value - 1.4142135623730951) < 1e-10, 'sqrt(2)');
  });
  it('pow(2, 10) → 1024', () => assertBothEqual('pow(2, 10)', 1024, 'pow'));
  it('pow(3, 0) → 1', () => assertBothEqual('pow(3, 0)', 1, 'pow(3,0)'));
});
