// vm.test.js — Tests for Monkey stack VM
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VM } from './vm.js';
import { Compiler } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { MonkeyInteger, MonkeyString, MonkeyArray, MonkeyHash, TRUE, FALSE, NULL } from './object.js';

function runVM(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  const program = p.parseProgram();
  const compiler = new Compiler();
  compiler.compile(program);
  const vm = new VM(compiler.bytecode());
  vm.run();
  return vm.lastPoppedStackElem();
}

function testIntegerObject(obj, expected) {
  // Accept both raw numbers (unboxed VM representation) and MonkeyInteger objects
  if (typeof obj === 'number') {
    assert.equal(obj, expected);
  } else {
    assert.ok(obj instanceof MonkeyInteger, `expected MonkeyInteger or number, got ${obj?.constructor?.name}: ${obj?.inspect?.()}`);
    assert.equal(obj.value, expected);
  }
}

function testBooleanObject(obj, expected) {
  assert.equal(obj, expected ? TRUE : FALSE);
}

describe('VM', () => {
  describe('integer arithmetic', () => {
    const tests = [
      ['1', 1],
      ['2', 2],
      ['1 + 2', 3],
      ['1 - 2', -1],
      ['1 * 2', 2],
      ['4 / 2', 2],
      ['50 / 2 * 2 + 10 - 5', 55],
      ['5 + 5 + 5 + 5 - 10', 10],
      ['2 * 2 * 2 * 2 * 2', 32],
      ['5 * 2 + 10', 20],
      ['5 + 2 * 10', 25],
      ['5 * (2 + 10)', 60],
      ['-5', -5],
      ['-10', -10],
      ['-50 + 100 + -50', 0],
      ['(5 + 10 * 2 + 15 / 3) * 2 + -10', 50],
    ];

    for (const [input, expected] of tests) {
      it(`evaluates ${input} = ${expected}`, () => {
        testIntegerObject(runVM(input), expected);
      });
    }
  });

  describe('boolean expressions', () => {
    const tests = [
      ['true', true],
      ['false', false],
      ['1 < 2', true],
      ['1 > 2', false],
      ['1 < 1', false],
      ['1 > 1', false],
      ['1 == 1', true],
      ['1 != 1', false],
      ['1 == 2', false],
      ['1 != 2', true],
      ['true == true', true],
      ['false == false', true],
      ['true == false', false],
      ['true != false', true],
      ['false != true', true],
      ['(1 < 2) == true', true],
      ['(1 < 2) == false', false],
      ['(1 > 2) == true', false],
      ['(1 > 2) == false', true],
      ['!true', false],
      ['!false', true],
      ['!5', false],
      ['!!true', true],
      ['!!false', false],
      ['!!5', true],
    ];

    for (const [input, expected] of tests) {
      it(`evaluates ${input} = ${expected}`, () => {
        testBooleanObject(runVM(input), expected);
      });
    }
  });

  describe('conditionals', () => {
    it('evaluates if (true) { 10 }', () => {
      testIntegerObject(runVM('if (true) { 10 }'), 10);
    });

    it('evaluates if (true) { 10 } else { 20 }', () => {
      testIntegerObject(runVM('if (true) { 10 } else { 20 }'), 10);
    });

    it('evaluates if (false) { 10 } else { 20 }', () => {
      testIntegerObject(runVM('if (false) { 10 } else { 20 }'), 20);
    });

    it('evaluates if (1) { 10 }', () => {
      testIntegerObject(runVM('if (1) { 10 }'), 10);
    });

    it('evaluates if (1 < 2) { 10 }', () => {
      testIntegerObject(runVM('if (1 < 2) { 10 }'), 10);
    });

    it('evaluates if (1 < 2) { 10 } else { 20 }', () => {
      testIntegerObject(runVM('if (1 < 2) { 10 } else { 20 }'), 10);
    });

    it('evaluates if (1 > 2) { 10 } else { 20 }', () => {
      testIntegerObject(runVM('if (1 > 2) { 10 } else { 20 }'), 20);
    });

    it('evaluates if (false) { 10 }', () => {
      assert.equal(runVM('if (false) { 10 }'), NULL);
    });
  });

  describe('global let statements', () => {
    it('evaluates let one = 1; one', () => {
      testIntegerObject(runVM('let one = 1; one'), 1);
    });

    it('evaluates let one = 1; let two = 2; one + two', () => {
      testIntegerObject(runVM('let one = 1; let two = 2; one + two'), 3);
    });

    it('evaluates let one = 1; let two = one + one; one + two', () => {
      testIntegerObject(runVM('let one = 1; let two = one + one; one + two'), 3);
    });
  });

  describe('string expressions', () => {
    it('evaluates "monkey"', () => {
      const result = runVM('"monkey"');
      assert.ok(result instanceof MonkeyString);
      assert.equal(result.value, 'monkey');
    });

    it('evaluates "mon" + "key"', () => {
      const result = runVM('"mon" + "key"');
      assert.ok(result instanceof MonkeyString);
      assert.equal(result.value, 'monkey');
    });

    it('evaluates "mon" + "key" + "banana"', () => {
      const result = runVM('"mon" + "key" + "banana"');
      assert.ok(result instanceof MonkeyString);
      assert.equal(result.value, 'monkeybanana');
    });
  });

  describe('array literals', () => {
    it('evaluates []', () => {
      const result = runVM('[]');
      assert.ok(result instanceof MonkeyArray);
      assert.equal(result.elements.length, 0);
    });

    it('evaluates [1, 2, 3]', () => {
      const result = runVM('[1, 2, 3]');
      assert.ok(result instanceof MonkeyArray);
      assert.equal(result.elements.length, 3);
      testIntegerObject(result.elements[0], 1);
      testIntegerObject(result.elements[1], 2);
      testIntegerObject(result.elements[2], 3);
    });

    it('evaluates [1 + 2, 3 * 4, 5 + 6]', () => {
      const result = runVM('[1 + 2, 3 * 4, 5 + 6]');
      testIntegerObject(result.elements[0], 3);
      testIntegerObject(result.elements[1], 12);
      testIntegerObject(result.elements[2], 11);
    });
  });

  describe('hash literals', () => {
    it('evaluates {}', () => {
      const result = runVM('{}');
      assert.ok(result.type() === 'HASH');
      assert.equal(result.pairs.size, 0);
    });

    it('evaluates {1: 2, 3: 4}', () => {
      const result = runVM('{1: 2, 3: 4}');
      assert.ok(result.type() === 'HASH');
      assert.equal(result.pairs.size, 2);
    });
  });

  describe('index expressions', () => {
    it('evaluates [1, 2, 3][1]', () => {
      testIntegerObject(runVM('[1, 2, 3][1]'), 2);
    });

    it('evaluates [1, 2, 3][0 + 2]', () => {
      testIntegerObject(runVM('[1, 2, 3][0 + 2]'), 3);
    });

    it('evaluates [[1, 1, 1]][0][0]', () => {
      testIntegerObject(runVM('[[1, 1, 1]][0][0]'), 1);
    });

    it('evaluates [][0]', () => {
      assert.equal(runVM('[][0]'), NULL);
    });

    it('evaluates [1, 2, 3][99]', () => {
      assert.equal(runVM('[1, 2, 3][99]'), NULL);
    });

    it('evaluates [1][-1]', () => {
      assert.equal(runVM('[1][-1]').value, 1); // negative indexing: last element
    });
  });

  describe('functions', () => {
    it('evaluates fn() { 5 + 10 }()', () => {
      testIntegerObject(runVM('fn() { 5 + 10 }()'), 15);
    });

    it('evaluates named function', () => {
      testIntegerObject(runVM('let f = fn() { 5 + 10 }; f()'), 15);
    });

    it('evaluates function with return', () => {
      testIntegerObject(runVM('let f = fn() { return 99; 100 }; f()'), 99);
    });

    it('evaluates function returning no value', () => {
      assert.equal(runVM('let f = fn() { }; f()'), NULL);
    });

    it('evaluates first-class functions', () => {
      testIntegerObject(runVM(`
        let returnsOne = fn() { 1 };
        let returnsOneReturner = fn() { returnsOne };
        returnsOneReturner()()
      `), 1);
    });
  });

  describe('local bindings', () => {
    it('local binding in function', () => {
      testIntegerObject(runVM('let f = fn() { let a = 55; a }; f()'), 55);
    });

    it('multiple local bindings', () => {
      testIntegerObject(runVM('let f = fn() { let a = 55; let b = 77; a + b }; f()'), 132);
    });

    it('local bindings in nested calls', () => {
      testIntegerObject(runVM(`
        let f = fn() { let a = 55; let b = 77; a + b };
        let g = fn() { let a = 66; let b = 88; a + b };
        f() + g()
      `), 286);
    });
  });

  describe('function arguments', () => {
    it('evaluates function with one argument', () => {
      testIntegerObject(runVM('let f = fn(a) { a }; f(24)'), 24);
    });

    it('evaluates function with multiple arguments', () => {
      testIntegerObject(runVM('let f = fn(a, b) { a + b }; f(24, 76)'), 100);
    });

    it('evaluates function with argument and local', () => {
      testIntegerObject(runVM('let f = fn(a) { let b = a + 1; b }; f(10)'), 11);
    });
  });

  describe('builtins', () => {
    it('evaluates len("")', () => {
      testIntegerObject(runVM('len("")'), 0);
    });

    it('evaluates len("hello")', () => {
      testIntegerObject(runVM('len("hello")'), 5);
    });

    it('evaluates len([1, 2, 3])', () => {
      testIntegerObject(runVM('len([1, 2, 3])'), 3);
    });

    it('evaluates first([1, 2, 3])', () => {
      testIntegerObject(runVM('first([1, 2, 3])'), 1);
    });

    it('evaluates last([1, 2, 3])', () => {
      testIntegerObject(runVM('last([1, 2, 3])'), 3);
    });

    it('evaluates rest([1, 2, 3])', () => {
      const result = runVM('rest([1, 2, 3])');
      assert.ok(result instanceof MonkeyArray);
      assert.equal(result.elements.length, 2);
      testIntegerObject(result.elements[0], 2);
    });

    it('evaluates push([], 1)', () => {
      const result = runVM('push([], 1)');
      assert.ok(result instanceof MonkeyArray);
      assert.equal(result.elements.length, 1);
      testIntegerObject(result.elements[0], 1);
    });
  });

  describe('closures', () => {
    it('evaluates closure over global', () => {
      testIntegerObject(runVM(`
        let x = 10;
        let f = fn() { x };
        f()
      `), 10);
    });

    it('evaluates closure over local', () => {
      testIntegerObject(runVM(`
        let newAdder = fn(a) { fn(b) { a + b } };
        let addTwo = newAdder(2);
        addTwo(8)
      `), 10);
    });

    it('evaluates deeply nested closure', () => {
      testIntegerObject(runVM(`
        let newAdderOuter = fn(a, b) {
          let c = a + b;
          fn(d) {
            let e = d + c;
            fn(f) { e + f }
          }
        };
        let newAdderInner = newAdderOuter(1, 2);
        let adder = newAdderInner(3);
        adder(8)
      `), 14);
    });
  });

  describe('recursive functions', () => {
    it('evaluates recursive countdown', () => {
      testIntegerObject(runVM(`
        let countdown = fn(x) {
          if (x == 0) { return 0 }
          countdown(x - 1)
        };
        countdown(1)
      `), 0);
    });

    it('evaluates recursive fibonacci', () => {
      testIntegerObject(runVM(`
        let fib = fn(n) {
          if (n < 2) { return n }
          fib(n - 1) + fib(n - 2)
        };
        fib(10)
      `), 55);
    });
  });

  describe('mutable closures in hash literals', () => {
    it('shares mutable state across sibling closures in hash', () => {
      testIntegerObject(runVM(`
        let make = fn() {
          let x = 0;
          {
            "inc": fn() { set x = x + 1; x; },
            "get": fn() { x; }
          };
        };
        let obj = make();
        obj["inc"]();
        obj["inc"]();
        obj["get"]();
      `), 2);
    });

    it('mutation in one hash closure visible to another', () => {
      testIntegerObject(runVM(`
        let counter = fn() {
          let n = 0;
          {
            "add": fn(x) { set n = n + x; },
            "val": fn() { n; }
          };
        };
        let c = counter();
        c["add"](10);
        c["add"](20);
        c["val"]();
      `), 30);
    });
  });
});
