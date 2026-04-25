// session-b-integration.test.js — Integration tests for all Session B features
// Tests the combination of new features working together
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Compiler, CompiledFunction } from './compiler.js';
import { VM } from './vm.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { monkeyEval } from './evaluator.js';
import { Environment } from './object.js';
import { compileWithPrelude } from './prelude.js';
import { EscapeAnalyzer, HEAP } from './escape.js';
import { perFunctionSSA, formatSSA } from './ssa.js';

function runVM(input) {
  const l = new Lexer(input), p = new Parser(l), prog = p.parseProgram();
  assert.deepStrictEqual(p.errors, [], `Parse errors: ${p.errors[0]}`);
  const c = new Compiler(); c.compile(prog);
  const vm = new VM(c.bytecode()); vm.run();
  return vm.lastPoppedStackElem();
}

function runEval(input) {
  const l = new Lexer(input), p = new Parser(l), prog = p.parseProgram();
  assert.deepStrictEqual(p.errors, []);
  return monkeyEval(prog, new Environment());
}

function runPrelude(input) {
  const bc = compileWithPrelude(input);
  const vm = new VM(bc); vm.run();
  return vm.lastPoppedStackElem();
}

describe('Session B integration: comments + template literals', () => {
  it('comments inside complex expressions', () => {
    const r = runVM(`
      // This is a counter factory
      let makeCounter = fn() {
        let n = 0; /* starts at zero */
        fn() {
          set n = n + 1; // increment
          n;
        };
      };
      let c = makeCounter();
      c(); c(); c(); // should be 3
    `);
    assert.strictEqual(r.value, 3);
  });

  it('template literals with complex expressions', () => {
    const r = runVM('let arr = [1,2,3]; `len=${len(arr)}, sum=${arr[0]+arr[1]+arr[2]}`;');
    assert.strictEqual(r.value, 'len=3, sum=6');
  });
});

describe('Session B integration: prelude + closures', () => {
  it('map with closure capturing variable', () => {
    const r = runPrelude(`
      let multiplier = 3;
      let result = map([1,2,3,4], fn(x) { x * multiplier; });
      reduce(result, 0, fn(acc, x) { acc + x; });
    `);
    assert.strictEqual(r.value, 30);
  });

  it('filter + reduce pipeline', () => {
    const r = runPrelude(`
      let data = [1,2,3,4,5,6,7,8,9,10];
      let result = reduce(
        filter(data, fn(x) { x > 5; }),
        0,
        fn(acc, x) { acc + x; }
      );
      result;
    `);
    assert.strictEqual(r.value, 40);
  });

  it('nested prelude functions with closures', () => {
    const r = runPrelude(`
      let data = [1,2,3,4,5];
      let makeMultiplier = fn(n) { fn(x) { x * n; }; };
      let triple = makeMultiplier(3);
      let result = map(data, triple);
      all(result, fn(x) { x > 2; });
    `);
    assert.strictEqual(r.value, true);
  });
});

describe('Session B integration: escape analysis + compilation', () => {
  it('escape analysis annotates correctly', () => {
    const input = `
      let maker = fn() { let x = 0; fn() { set x = x + 1; x; }; };
      let c = maker(); c(); c(); c();
    `;
    const l = new Lexer(input), p = new Parser(l), prog = p.parseProgram();
    const analyzer = new EscapeAnalyzer();
    const info = analyzer.analyze(prog);
    assert.strictEqual(info.variables.get('x').state, HEAP, 'x should escape');
  });

  it('per-function SSA works on real programs', () => {
    const input = `
      let fib = fn(n) { if (n < 2) { n; } else { fib(n-1) + fib(n-2); }; };
    `;
    const results = perFunctionSSA(input);
    assert.ok(results.size >= 1, 'should analyze at least 1 function');
    assert.ok(results.has('fib'), 'should have fib');
  });

  it('compiled code with escape info runs correctly', () => {
    const r = runVM(`
      let outer = fn() {
        let x = 0;
        let inner = fn() { set x = x + 1; x; };
        inner;
      };
      let f = outer();
      f(); f(); f();
    `);
    assert.strictEqual(r.value, 3);
  });
});

describe('Session B integration: builtins', () => {
  it('padStart + template literal', () => {
    const r = runVM('let n = 42; `${padStart(str(n), 5, "0")}`;');
    assert.strictEqual(r.value, '00042');
  });

  it('math builtins in expressions', () => {
    const r = runVM('sqrt(pow(3, 2) + pow(4, 2));');
    assert.strictEqual(r.value, 5);
  });

  it('char/ord roundtrip', () => {
    const r = runVM('let s = "H"; let code = ord(s); char(code);');
    assert.strictEqual(r.value, 'H');
  });
});

describe('Session B integration: import system', () => {
  it('import statement parses correctly', () => {
    const l = new Lexer('import "math" { abs, pow };');
    const p = new Parser(l);
    const prog = p.parseProgram();
    assert.strictEqual(p.errors.length, 0);
    assert.strictEqual(prog.statements.length, 1);
    assert.strictEqual(prog.statements[0].constructor.name, 'ImportStatement');
  });

  it('import as alias parses correctly', () => {
    const l = new Lexer('import "strings" as str_lib;');
    const p = new Parser(l);
    const prog = p.parseProgram();
    assert.strictEqual(p.errors.length, 0);
  });

  it('import() function call works at runtime', () => {
    const r = runEval('let m = import("math"); m["abs"](-42);');
    assert.strictEqual(r.value, 42);
  });
});

describe('Session B integration: comprehensive programs', () => {
  it('fibonacci with prelude + comments + template', () => {
    const r = runPrelude(`
      // Compute fibonacci numbers using prelude
      let fib = fn(n) {
        if (n < 2) { n; }
        else { fib(n - 1) + fib(n - 2); };
      };
      /* Map fib over a range */
      let results = map([0,1,2,3,4,5,6,7,8,9], fib);
      let total = reduce(results, 0, fn(a, x) { a + x; });
      total;
    `);
    assert.strictEqual(r.value, 88); // sum of fib(0..9) = 0+1+1+2+3+5+8+13+21+34 = 88
  });

  it('data pipeline with all new features', () => {
    const r = runPrelude(`
      // Process student scores
      let scores = [95, 87, 92, 78, 88, 91, 85, 93, 89, 76];
      
      // Filter passing scores (> 80), double them, sum
      let result = reduce(
        map(
          filter(scores, fn(s) { s > 80; }),
          fn(s) { s * 2; }
        ),
        0,
        fn(acc, x) { acc + x; }
      );
      result;
    `);
    // Passing: 95,87,92,88,91,85,93,89 = 8 scores
    // Doubled: 190+174+184+176+182+170+186+178 = 1440
    assert.strictEqual(r.value, 1440);
  });
});
