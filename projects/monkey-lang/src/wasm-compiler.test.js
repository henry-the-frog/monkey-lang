// Tests for Monkey → WASM Compiler
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileAndRun, compileToInstance, formatWasmValue, WasmCompiler } from './wasm-compiler.js';
import { disassemble } from './wasm-dis.js';

describe('WASM Compiler', () => {

  describe('Integer literals', () => {
    it('compiles integer constant', async () => {
      assert.strictEqual(await compileAndRun('42'), 42);
    });

    it('compiles zero', async () => {
      assert.strictEqual(await compileAndRun('0'), 0);
    });

    it('compiles negative via prefix', async () => {
      assert.strictEqual(await compileAndRun('-5'), -5);
    });
  });

  describe('Boolean literals', () => {
    it('true is 1', async () => {
      assert.strictEqual(await compileAndRun('true'), 1);
    });

    it('false is 0', async () => {
      assert.strictEqual(await compileAndRun('false'), 0);
    });
  });

  describe('Arithmetic', () => {
    it('addition', async () => {
      assert.strictEqual(await compileAndRun('3 + 4'), 7);
    });

    it('subtraction', async () => {
      assert.strictEqual(await compileAndRun('10 - 3'), 7);
    });

    it('multiplication', async () => {
      assert.strictEqual(await compileAndRun('6 * 7'), 42);
    });

    it('division', async () => {
      assert.strictEqual(await compileAndRun('42 / 6'), 7);
    });

    it('modulo', async () => {
      assert.strictEqual(await compileAndRun('10 % 3'), 1);
    });

    it('complex expression', async () => {
      assert.strictEqual(await compileAndRun('(2 + 3) * (4 + 1)'), 25);
    });

    it('nested arithmetic', async () => {
      assert.strictEqual(await compileAndRun('1 + 2 * 3 + 4'), 11);
    });
  });

  describe('Comparisons', () => {
    it('equal true', async () => {
      assert.strictEqual(await compileAndRun('5 == 5'), 1);
    });

    it('equal false', async () => {
      assert.strictEqual(await compileAndRun('5 == 6'), 0);
    });

    it('not equal', async () => {
      assert.strictEqual(await compileAndRun('5 != 6'), 1);
    });

    it('less than', async () => {
      assert.strictEqual(await compileAndRun('3 < 5'), 1);
    });

    it('greater than', async () => {
      assert.strictEqual(await compileAndRun('5 > 3'), 1);
    });

    it('less or equal', async () => {
      assert.strictEqual(await compileAndRun('5 <= 5'), 1);
    });

    it('greater or equal', async () => {
      assert.strictEqual(await compileAndRun('5 >= 6'), 0);
    });
  });

  describe('Prefix operators', () => {
    it('negation', async () => {
      assert.strictEqual(await compileAndRun('-10'), -10);
    });

    it('bang true', async () => {
      assert.strictEqual(await compileAndRun('!true'), 0);
    });

    it('bang false', async () => {
      assert.strictEqual(await compileAndRun('!false'), 1);
    });

    it('double negation', async () => {
      assert.strictEqual(await compileAndRun('!!true'), 1);
    });

    it('bang zero', async () => {
      assert.strictEqual(await compileAndRun('!0'), 1);
    });

    it('bang nonzero', async () => {
      assert.strictEqual(await compileAndRun('!5'), 0);
    });
  });

  describe('Let bindings', () => {
    it('simple let', async () => {
      assert.strictEqual(await compileAndRun('let x = 10; x'), 10);
    });

    it('let with expression', async () => {
      assert.strictEqual(await compileAndRun('let x = 5 + 3; x'), 8);
    });

    it('multiple lets', async () => {
      assert.strictEqual(await compileAndRun('let x = 5; let y = 10; x + y'), 15);
    });

    it('let using previous binding', async () => {
      assert.strictEqual(await compileAndRun('let x = 5; let y = x * 2; y'), 10);
    });
  });

  describe('Assignment', () => {
    it('simple assignment', async () => {
      assert.strictEqual(await compileAndRun('let x = 5; x = 10; x'), 10);
    });

    it('assignment with arithmetic', async () => {
      assert.strictEqual(await compileAndRun('let x = 5; x = x + 3; x'), 8);
    });
  });

  describe('If/else expressions', () => {
    it('if true', async () => {
      assert.strictEqual(await compileAndRun('if (true) { 10 } else { 20 }'), 10);
    });

    it('if false', async () => {
      assert.strictEqual(await compileAndRun('if (false) { 10 } else { 20 }'), 20);
    });

    it('if with comparison', async () => {
      assert.strictEqual(await compileAndRun('if (5 > 3) { 1 } else { 0 }'), 1);
    });

    it('if without else', async () => {
      assert.strictEqual(await compileAndRun('if (false) { 10 }'), 0);
    });

    it('nested if', async () => {
      assert.strictEqual(await compileAndRun(`
        if (true) {
          if (false) { 1 } else { 2 }
        } else {
          3
        }
      `), 2);
    });

    it('if with let in body', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 5;
        if (x > 3) { x * 2 } else { x * 3 }
      `), 10);
    });
  });

  describe('While loops', () => {
    it('basic while', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 0;
        let i = 0;
        while (i < 10) {
          x = x + i;
          i = i + 1;
        }
        x
      `), 45);
    });

    it('while with early exit condition', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 1;
        while (x < 100) {
          x = x * 2;
        }
        x
      `), 128);
    });
  });

  describe('For loops', () => {
    it('basic for loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = 0;
        for (let i = 1; i <= 10; i = i + 1) {
          sum = sum + i;
        }
        sum
      `), 55);
    });

    it('for loop with multiplication', async () => {
      assert.strictEqual(await compileAndRun(`
        let result = 1;
        for (let i = 1; i <= 5; i = i + 1) {
          result = result * i;
        }
        result
      `), 120);
    });

    it('for-in loop over array', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = 0;
        let arr = [10, 20, 30];
        for (x in arr) {
          sum = sum + x;
        }
        sum
      `), 60);
    });

    it('for-in with puts', async () => {
      const lines = [];
      await compileAndRun(`
        for (x in [1, 2, 3]) {
          puts(x);
        }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '2', '3']);
    });

    it('range expression', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = 0..5;
        len(arr)
      `), 5);
    });

    it('for-in with range', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = 0;
        for (x in 0..10) {
          sum = sum + x;
        }
        sum
      `), 45);
    });

    it('range with variables', async () => {
      const lines = [];
      await compileAndRun(`
        for (i in 1..4) {
          puts(i);
        }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '2', '3']);
    });
  });

  describe('Functions', () => {
    it('simple function call', async () => {
      const instance = await compileToInstance(`
        let double = fn(x) { x * 2 };
        double(21)
      `);
      assert.strictEqual(instance.exports.main(), 42);
      assert.strictEqual(instance.exports.double(5), 10);
    });

    it('function with multiple params', async () => {
      assert.strictEqual(await compileAndRun(`
        let add = fn(a, b) { a + b };
        add(10, 32)
      `), 42);
    });

    it('function with if', async () => {
      assert.strictEqual(await compileAndRun(`
        let max = fn(a, b) { if (a > b) { a } else { b } };
        max(5, 10)
      `), 10);
    });

    it('function with local variables', async () => {
      assert.strictEqual(await compileAndRun(`
        let compute = fn(x) {
          let doubled = x * 2;
          let result = doubled + 1;
          result
        };
        compute(5)
      `), 11);
    });

    it('recursive function (fibonacci)', async () => {
      assert.strictEqual(await compileAndRun(`
        let fib = fn(n) {
          if (n <= 1) { n } else { fib(n - 1) + fib(n - 2) }
        };
        fib(10)
      `), 55);
    });

    it('recursive function (factorial)', async () => {
      assert.strictEqual(await compileAndRun(`
        let factorial = fn(n) {
          if (n <= 1) { 1 } else { n * factorial(n - 1) }
        };
        factorial(10)
      `), 3628800);
    });

    it('multiple functions calling each other', async () => {
      assert.strictEqual(await compileAndRun(`
        let square = fn(x) { x * x };
        let sumOfSquares = fn(a, b) { square(a) + square(b) };
        sumOfSquares(3, 4)
      `), 25);
    });
  });

  describe('Return statements', () => {
    it('explicit return', async () => {
      assert.strictEqual(await compileAndRun(`
        let abs = fn(x) {
          if (x < 0) { return -x; }
          x
        };
        abs(-42)
      `), 42);
    });

    it('return from main', async () => {
      assert.strictEqual(await compileAndRun('return 99;'), 99);
    });
  });

  describe('Logical operators', () => {
    it('and true', async () => {
      assert.strictEqual(await compileAndRun('true && true'), 1);
    });

    it('and false', async () => {
      assert.strictEqual(await compileAndRun('true && false'), 0);
    });

    it('and short circuit', async () => {
      assert.strictEqual(await compileAndRun('false && 42'), 0);
    });

    it('or true', async () => {
      assert.strictEqual(await compileAndRun('false || true'), 1);
    });

    it('or short circuit', async () => {
      assert.strictEqual(await compileAndRun('5 || 0'), 5);
    });
  });

  describe('Arrays', () => {
    it('array literal and indexing', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [10, 20, 30];
        arr[1]
      `), 20);
    });

    it('array length', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [1, 2, 3, 4, 5];
        len(arr)
      `), 5);
    });

    it('array first and last', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [100, 200, 300];
        arr[0] + arr[2]
      `), 400);
    });

    it('array with computed elements', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 5;
        let arr = [x, x * 2, x * 3];
        arr[0] + arr[1] + arr[2]
      `), 30);
    });

    it('array sum via loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [1, 2, 3, 4, 5];
        let sum = 0;
        let i = 0;
        while (i < len(arr)) {
          sum = sum + arr[i];
          i = i + 1;
        }
        sum
      `), 15);
    });

    it('push creates new array', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [1, 2, 3];
        let arr2 = push(arr, 4);
        len(arr2)
      `), 4);
    });

    it('push preserves elements', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [10, 20];
        let arr2 = push(arr, 30);
        arr2[0] + arr2[1] + arr2[2]
      `), 60);
    });

    it('empty array', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [];
        len(arr)
      `), 0);
    });

    it('build array with push in loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [];
        let i = 0;
        while (i < 5) {
          arr = push(arr, i * i);
          i = i + 1;
        }
        arr[3]
      `), 9);
    });
  });

  describe('Strings', () => {
    it('string literal returns pointer', async () => {
      // String literal returns a non-zero pointer
      const result = await compileAndRun('"hello"');
      assert.ok(result > 0, `expected positive pointer, got ${result}`);
    });

    it('string length', async () => {
      assert.strictEqual(await compileAndRun('len("hello")'), 5);
    });

    it('empty string length', async () => {
      assert.strictEqual(await compileAndRun('len("")'), 0);
    });

    it('string stored in variable', async () => {
      assert.strictEqual(await compileAndRun(`
        let s = "world";
        len(s)
      `), 5);
    });

    it('can read string bytes from memory', async () => {
      const instance = await compileToInstance('"Hi"');
      const result = instance.exports.main();
      const mem = new Uint8Array(instance.exports.memory.buffer);
      // At result+8 should be 'H', result+9 should be 'i'
      assert.strictEqual(mem[result + 8], 72);  // 'H'
      assert.strictEqual(mem[result + 9], 105); // 'i'
    });
  });

  describe('puts and output', () => {
    it('puts integer', async () => {
      const lines = [];
      await compileAndRun('puts(42)', { outputLines: lines });
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0], '42');
    });

    it('puts multiple values', async () => {
      const lines = [];
      await compileAndRun('puts(1); puts(2); puts(3)', { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '2', '3']);
    });

    it('puts in loop', async () => {
      const lines = [];
      await compileAndRun(`
        let i = 0;
        while (i < 5) {
          puts(i);
          i = i + 1;
        }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['0', '1', '2', '3', '4']);
    });

    it('puts string literal', async () => {
      const lines = [];
      await compileAndRun('puts("hello")', { outputLines: lines });
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0], 'hello');
    });

    it('puts array', async () => {
      const lines = [];
      await compileAndRun('puts([1, 2, 3])', { outputLines: lines });
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0], '[1, 2, 3]');
    });

    it('puts from function', async () => {
      const lines = [];
      await compileAndRun(`
        let greet = fn(x) { puts(x); x };
        greet(42)
      `, { outputLines: lines });
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0], '42');
    });

    it('puts returns null (0)', async () => {
      const result = await compileAndRun('puts(42)');
      assert.strictEqual(result, 0);
    });

    it('fizzbuzz with puts', async () => {
      const lines = [];
      await compileAndRun(`
        let i = 1;
        while (i <= 15) {
          if (i % 15 == 0) { puts(0); }
          if (i % 15 != 0) {
            if (i % 3 == 0) { puts(3); }
            if (i % 3 != 0) {
              if (i % 5 == 0) { puts(5); }
              if (i % 5 != 0) { puts(i); }
            }
          }
          i = i + 1;
        }
      `, { outputLines: lines });
      assert.strictEqual(lines.length, 15);
      // 1,2,fizz,4,buzz,fizz,7,8,fizz,buzz,11,fizz,13,14,fizzbuzz
      assert.strictEqual(lines[0], '1');
      assert.strictEqual(lines[2], '3');  // fizz (represented as 3)
      assert.strictEqual(lines[4], '5');  // buzz (represented as 5)
      assert.strictEqual(lines[14], '0'); // fizzbuzz (represented as 0)
    });
  });

  describe('String operations', () => {
    it('string concatenation', async () => {
      const lines = [];
      await compileAndRun('puts("hello" + " " + "world")', { outputLines: lines });
      assert.strictEqual(lines[0], 'hello world');
    });

    it('str() converts integer to string', async () => {
      const lines = [];
      await compileAndRun('puts(str(42))', { outputLines: lines });
      assert.strictEqual(lines[0], '42');
    });

    it('str() + string concatenation', async () => {
      const lines = [];
      await compileAndRun('puts("answer: " + str(42))', { outputLines: lines });
      assert.strictEqual(lines[0], 'answer: 42');
    });

    it('string comparison ==', async () => {
      assert.strictEqual(await compileAndRun('"hello" == "hello"'), 1);
    });

    it('string comparison == false', async () => {
      assert.strictEqual(await compileAndRun('"hello" == "world"'), 0);
    });

    it('string comparison !=', async () => {
      assert.strictEqual(await compileAndRun('"a" != "b"'), 1);
    });

    it('string concat in loop', async () => {
      const lines = [];
      await compileAndRun(`
        let i = 0;
        while (i < 3) {
          puts("item " + str(i));
          i = i + 1;
        }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['item 0', 'item 1', 'item 2']);
    });

    it('string concat with multiple str() calls', async () => {
      const lines = [];
      await compileAndRun(`
        let a = 3;
        let b = 4;
        puts(str(a) + " + " + str(b) + " = " + str(a + b))
      `, { outputLines: lines });
      assert.strictEqual(lines[0], '3 + 4 = 7');
    });

    it('fibonacci with string output', async () => {
      const lines = [];
      await compileAndRun(`
        let fib = fn(n) {
          if (n <= 1) { n } else { fib(n - 1) + fib(n - 2) }
        };
        puts("fib(10) = " + str(fib(10)))
      `, { outputLines: lines });
      assert.strictEqual(lines[0], 'fib(10) = 55');
    });
  });

  describe('Closures', () => {
    it('simple closure capturing outer variable', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 10;
        let f = fn(y) { x + y };
        f(32)
      `), 42);
    });

    it('makeAdder (closure factory)', async () => {
      assert.strictEqual(await compileAndRun(`
        let makeAdder = fn(x) { fn(y) { x + y } };
        let add5 = makeAdder(5);
        add5(3)
      `), 8);
    });

    it('multiple closures from same factory', async () => {
      assert.strictEqual(await compileAndRun(`
        let makeAdder = fn(x) { fn(y) { x + y } };
        let add10 = makeAdder(10);
        let add20 = makeAdder(20);
        add10(5) + add20(5)
      `), 40);
    });

    it('closure capturing multiple variables', async () => {
      assert.strictEqual(await compileAndRun(`
        let a = 10;
        let b = 20;
        let f = fn(c) { a + b + c };
        f(12)
      `), 42);
    });

    it('counter closure', async () => {
      // Captured variable read at creation time
      assert.strictEqual(await compileAndRun(`
        let x = 5;
        let getX = fn() { x };
        getX()
      `), 5);
    });

    it('closure mutation persists between calls', async () => {
      // Mutations to captured variables write back to the heap environment
      assert.strictEqual(await compileAndRun(`
        let make = fn() { let c = 0; fn() { c = c + 1; c } };
        let inc = make();
        inc(); inc(); inc()
      `), 3);
    });

    it('closure counter 5 calls', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() { let c = 0; fn() { c = c + 1; c } };
        let inc = make();
        inc(); inc(); inc(); inc(); inc()
      `), 5);
    });

    it('closure with function call inside', async () => {
      assert.strictEqual(await compileAndRun(`
        let double = fn(x) { x * 2 };
        let apply = fn(f, x) { f(x) };
        apply(double, 21)
      `), 42);
    });

    it('immediately invoked function', async () => {
      assert.strictEqual(await compileAndRun(`
        (fn(x) { x * 2 })(21)
      `), 42);
    });

    it('closure in arithmetic', async () => {
      assert.strictEqual(await compileAndRun(`
        let makeMultiplier = fn(factor) { fn(x) { factor * x } };
        let double = makeMultiplier(2);
        let triple = makeMultiplier(3);
        double(5) + triple(5)
      `), 25);
    });

    it('higher-order: apply function', async () => {
      assert.strictEqual(await compileAndRun(`
        let apply = fn(f, x) { f(x) };
        let inc = fn(x) { x + 1 };
        apply(inc, 41)
      `), 42);
    });
  });

  describe('Constant folding', () => {
    it('folds simple addition', async () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('2 + 3');
      const binary = builder.build();
      const wat = disassemble(binary);
      // Main function should only have i32.const 5, no i32.add
      const mainFunc = wat.split(';; main')[1] || '';
      assert.ok(mainFunc.includes('i32.const 5'));
      assert.ok(!mainFunc.includes('i32.add'));
      assert.strictEqual(await compileAndRun('2 + 3'), 5);
    });

    it('folds complex arithmetic', async () => {
      assert.strictEqual(await compileAndRun('(10 + 20) * (3 - 1)'), 60);
    });

    it('folds comparisons', async () => {
      assert.strictEqual(await compileAndRun('5 > 3'), 1);
      assert.strictEqual(await compileAndRun('2 == 2'), 1);
      assert.strictEqual(await compileAndRun('1 != 1'), 0);
    });

    it('folds nested expressions', async () => {
      assert.strictEqual(await compileAndRun('1 + 2 + 3 + 4 + 5'), 15);
    });

    it('folds with negation', async () => {
      assert.strictEqual(await compileAndRun('-5 + 10'), 5);
    });

    it('folds modulo', async () => {
      assert.strictEqual(await compileAndRun('100 % 7'), 2);
    });

    it('does not fold when variables involved', async () => {
      // This should still work correctly even though x is not constant
      assert.strictEqual(await compileAndRun('let x = 5; x + 3'), 8);
    });
  });

  describe('Complex programs', () => {
    it('GCD', async () => {
      assert.strictEqual(await compileAndRun(`
        let gcd = fn(a, b) {
          if (b == 0) { a } else { gcd(b, a % b) }
        };
        gcd(48, 18)
      `), 6);
    });

    it('power function', async () => {
      assert.strictEqual(await compileAndRun(`
        let pow = fn(base, exp) {
          if (exp == 0) { return 1; }
          base * pow(base, exp - 1)
        };
        pow(2, 10)
      `), 1024);
    });

    it('sum with accumulator', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = 0;
        let i = 1;
        while (i <= 100) {
          sum = sum + i;
          i = i + 1;
        }
        sum
      `), 5050);
    });

    it('nested loops', async () => {
      assert.strictEqual(await compileAndRun(`
        let count = 0;
        let i = 0;
        while (i < 10) {
          let j = 0;
          while (j < 10) {
            count = count + 1;
            j = j + 1;
          }
          i = i + 1;
        }
        count
      `), 100);
    });
  });

  describe('Extended syntax', () => {
    it('arrow function', async () => {
      assert.strictEqual(await compileAndRun('let double = (x) => x * 2; double(21)'), 42);
    });

    it('arrow function as closure', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 10;
        let addX = (y) => x + y;
        addX(32)
      `), 42);
    });

    it('null coalescing with null', async () => {
      assert.strictEqual(await compileAndRun('let x = 0; x ?? 42'), 42);
    });

    it('null coalescing with value', async () => {
      assert.strictEqual(await compileAndRun('let x = 5; x ?? 42'), 5);
    });

    it('pipe operator', async () => {
      assert.strictEqual(await compileAndRun('let double = fn(x) { x * 2 }; 21 |> double'), 42);
    });

    it('array mutation', async () => {
      assert.strictEqual(await compileAndRun('let arr = [1, 2, 3]; arr[1] = 42; arr[1]'), 42);
    });

    it('compound assignment operators', async () => {
      assert.strictEqual(await compileAndRun('let x = 10; x += 5; x -= 3; x *= 2; x'), 24);
    });

    it('ternary expression', async () => {
      assert.strictEqual(await compileAndRun('true ? 42 : 0'), 42);
      assert.strictEqual(await compileAndRun('false ? 0 : 42'), 42);
    });

    it('template literal', async () => {
      const lines = [];
      await compileAndRun('let x = 42; puts(`answer: ${x}`)', { outputLines: lines });
      assert.strictEqual(lines[0], 'answer: 42');
    });

    it('range in variable', async () => {
      assert.strictEqual(await compileAndRun('let r = 0..5; len(r)'), 5);
    });

    it('do-while', async () => {
      assert.strictEqual(await compileAndRun('let x = 1; do { x = x * 2; } while (x < 100); x'), 128);
    });
  });

  describe('Hash maps', () => {
    it('hash literal with integer keys', async () => {
      assert.strictEqual(await compileAndRun('let h = {1: 10, 2: 20, 3: 30}; h[2]'), 20);
    });

    it('hash literal with string keys', async () => {
      const lines = [];
      await compileAndRun('let h = {"x": 42, "y": 99}; puts(str(h["x"]))', { outputLines: lines });
      assert.strictEqual(lines[0], '42');
    });

    it('hash mutation', async () => {
      assert.strictEqual(await compileAndRun('let h = {1: 10}; h[2] = 20; h[2]'), 20);
    });

    it('hash overwrite', async () => {
      assert.strictEqual(await compileAndRun('let h = {1: 10}; h[1] = 99; h[1]'), 99);
    });

    it('hash missing key returns 0', async () => {
      assert.strictEqual(await compileAndRun('let h = {1: 10}; h[999]'), 0);
    });
  });

  describe('Match expressions', () => {
    it('simple value match', async () => {
      assert.strictEqual(await compileAndRun('match (3) { 1 => 10, 2 => 20, 3 => 30, _ => 0 }'), 30);
    });

    it('wildcard match', async () => {
      assert.strictEqual(await compileAndRun('match (99) { 1 => 10, _ => 42 }'), 42);
    });

    it('match with variable', async () => {
      assert.strictEqual(await compileAndRun('let x = 2; match (x) { 1 => 10, 2 => 20, _ => 0 }'), 20);
    });

    it('match in let binding', async () => {
      assert.strictEqual(await compileAndRun('let x = match (1) { 1 => 100, _ => 0 }; x + 1'), 101);
    });
  });

  describe('Optional chaining', () => {
    it('optional chain on hash', async () => {
      assert.strictEqual(await compileAndRun('let h = {"a": 42}; h?.a'), 42);
    });

    it('optional chain on null returns 0', async () => {
      assert.strictEqual(await compileAndRun('let h = 0; h?.a'), 0);
    });

    it('optional chain with null coalescing', async () => {
      assert.strictEqual(await compileAndRun('let h = 0; h?.a ?? 99'), 99);
    });

    it('dot access on hash', async () => {
      assert.strictEqual(await compileAndRun('let h = {"name": 42}; h.name'), 42);
    });
  });

  describe('Source maps', () => {
    it('tracks source lines for functions', () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('let fib = fn(n) {\n  if (n <= 1) { n }\n  else { fib(n-1) + fib(n-2) }\n};\nfib(10)');
      const maps = builder.getSourceMaps();
      const funcIndices = Object.keys(maps);
      assert.ok(funcIndices.length > 0, 'should have source maps');
      // Fib function should reference lines 2-3 (may be any func index due to compilation order)
      const allLines = funcIndices.flatMap(idx => maps[idx].map(e => e.line));
      assert.ok(allLines.includes(2) || allLines.includes(3), `should reference lines 2-3, got ${[...new Set(allLines)]}`);
    });
  });

  describe('Enums', () => {
    it('enum values are sequential integers', async () => {
      assert.strictEqual(await compileAndRun('enum Color { Red, Green, Blue } Color.Red'), 0);
      assert.strictEqual(await compileAndRun('enum Color { Red, Green, Blue } Color.Green'), 1);
      assert.strictEqual(await compileAndRun('enum Color { Red, Green, Blue } Color.Blue'), 2);
    });

    it('enum short names', async () => {
      assert.strictEqual(await compileAndRun('enum Dir { Up, Down } Down'), 1);
    });

    it('enum with match', async () => {
      assert.strictEqual(await compileAndRun('enum Dir { Up, Down, Left, Right } match (Right) { 0 => 10, 1 => 20, 2 => 30, 3 => 40, _ => 0 }'), 40);
    });
  });

  describe('Destructuring', () => {
    it('array destructuring', async () => {
      assert.strictEqual(await compileAndRun('let [a, b, c] = [10, 20, 30]; a + b + c'), 60);
    });

    it('destructuring with skip (_)', async () => {
      assert.strictEqual(await compileAndRun('let [_, b, _] = [10, 20, 30]; b'), 20);
    });

    it('spread in array literals', async () => {
      const instanceRef = {};
      const result = await compileAndRun('let a = [1, 2]; let b = [3, 4]; [...a, ...b]', { instance: instanceRef });
      const view = new DataView(instanceRef.ref.exports.memory.buffer);
      assert.strictEqual(formatWasmValue(result, view), '[1, 2, 3, 4]');
    });

    it('mixed elements and spread', async () => {
      const instanceRef = {};
      const result = await compileAndRun('let a = [2, 3]; [1, ...a, 4]', { instance: instanceRef });
      const view = new DataView(instanceRef.ref.exports.memory.buffer);
      assert.strictEqual(formatWasmValue(result, view), '[1, 2, 3, 4]');
    });
  });

  describe('Break and Continue', () => {
    it('break exits loop early', async () => {
      const lines = [];
      await compileAndRun('for (i in 0..10) { if (i == 3) { break; } puts(str(i)); }', { outputLines: lines });
      assert.deepStrictEqual(lines, ['0', '1', '2']);
    });

    it('continue skips iteration', async () => {
      const lines = [];
      await compileAndRun('for (i in 0..6) { if (i % 2 == 0) { continue; } puts(str(i)); }', { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '3', '5']);
    });

    it('break in while loop', async () => {
      assert.strictEqual(await compileAndRun('let x = 0; while (true) { x += 1; if (x == 5) { break; } } x'), 5);
    });

    it('continue in while loop', async () => {
      const lines = [];
      await compileAndRun('let i = 0; while (i < 5) { i += 1; if (i == 3) { continue; } puts(str(i)); }', { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '2', '4', '5']);
    });
  });

  describe('String ordering', () => {
    it('string less than', async () => {
      assert.strictEqual(await compileAndRun('"apple" < "banana"'), 1);
      assert.strictEqual(await compileAndRun('"banana" < "apple"'), 0);
    });

    it('string greater than', async () => {
      assert.strictEqual(await compileAndRun('"banana" > "apple"'), 1);
    });

    it('string less than or equal', async () => {
      assert.strictEqual(await compileAndRun('"apple" <= "apple"'), 1);
      assert.strictEqual(await compileAndRun('"apple" <= "banana"'), 1);
    });

    it('string greater than or equal', async () => {
      assert.strictEqual(await compileAndRun('"banana" >= "apple"'), 1);
      assert.strictEqual(await compileAndRun('"apple" >= "banana"'), 0);
    });

    it('string iteration with for-in', async () => {
      const lines = [];
      await compileAndRun('for (ch in "abc") { puts(ch); }', { outputLines: lines });
      assert.deepStrictEqual(lines, ['a', 'b', 'c']);
    });

    it('string index access', async () => {
      const lines = [];
      await compileAndRun('puts("hello"[1])', { outputLines: lines });
      assert.strictEqual(lines[0], 'e');
    });
  });

  describe('Integration tests', () => {
    it('Collatz conjecture', async () => {
      assert.strictEqual(await compileAndRun(`
        let collatz = fn(n) {
          let steps = 0;
          while (n != 1) {
            if (n % 2 == 0) { n = n / 2; } else { n = n * 3 + 1; }
            steps = steps + 1;
          }
          steps
        };
        collatz(27)
      `), 111);
    });

    it('prime counting', async () => {
      assert.strictEqual(await compileAndRun(`
        let isPrime = fn(n) {
          if (n < 2) { return 0; }
          let i = 2;
          while (i * i <= n) {
            if (n % i == 0) { return 0; }
            i = i + 1;
          }
          1
        };
        let count = 0;
        for (n in 2..100) {
          if (isPrime(n) == 1) { count = count + 1; }
        }
        count
      `), 25);
    });

    it('compound assignment', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 10;
        x += 5;
        x -= 3;
        x *= 2;
        x
      `), 24);
    });

    it('template literal with computation', async () => {
      const lines = [];
      await compileAndRun('let x = 6; let y = 7; puts(`${x} * ${y} = ${x * y}`)', { outputLines: lines });
      assert.strictEqual(lines[0], '6 * 7 = 42');
    });

    it('do-while loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 1;
        do {
          x = x * 2;
        } while (x < 100);
        x
      `), 128);
    });

    it('range sum', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = 0;
        for (i in 0..10) { sum = sum + i; }
        sum
      `), 45);
    });

    it('nested function calls with closures', async () => {
      assert.strictEqual(await compileAndRun(`
        let compose = fn(f, g) { fn(x) { f(g(x)) } };
        let double = fn(x) { x * 2 };
        let inc = fn(x) { x + 1 };
        let doubleInc = compose(inc, double);
        doubleInc(5)
      `), 11);
    });

    it('array building in loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let squares = [];
        for (i in 1..6) {
          squares = push(squares, i * i);
        }
        squares[0] + squares[1] + squares[2] + squares[3] + squares[4]
      `), 55);
    });

    it('multiple string puts', async () => {
      const lines = [];
      await compileAndRun(`
        puts("hello");
        puts("world");
        puts("!" + "!");
      `, { outputLines: lines });
      assert.strictEqual(lines.length, 3);
      assert.strictEqual(lines[0], 'hello');
      assert.strictEqual(lines[1], 'world');
      assert.strictEqual(lines[2], '!!');
    });

    it('fibonacci with puts', async () => {
      const lines = [];
      await compileAndRun(`
        let fib = fn(n) {
          if (n <= 1) { n } else { fib(n - 1) + fib(n - 2) }
        };
        for (i in 0..8) {
          puts(str(fib(i)));
        }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['0', '1', '1', '2', '3', '5', '8', '13']);
    });

    it('mutual recursion via closures', async () => {
      assert.strictEqual(await compileAndRun(`
        let isEven = fn(n) { if (n == 0) { 1 } else { isOdd(n - 1) } };
        let isOdd = fn(n) { if (n == 0) { 0 } else { isEven(n - 1) } };
        isEven(10)
      `), 1);
    });

    it('first/last/rest builtins', async () => {
      assert.strictEqual(await compileAndRun('first([10, 20, 30])'), 10);
      assert.strictEqual(await compileAndRun('last([10, 20, 30])'), 30);
      assert.strictEqual(await compileAndRun('len(rest([10, 20, 30]))'), 2);
      assert.strictEqual(await compileAndRun('rest([10, 20, 30])[0]'), 20);
    });

    it('recursive list processing with rest', async () => {
      assert.strictEqual(await compileAndRun(`
        let sum = fn(arr) {
          if (len(arr) == 0) { 0 }
          else { first(arr) + sum(rest(arr)) }
        };
        sum([1, 2, 3, 4, 5])
      `), 15);
    });

    it('user-defined map with closures', async () => {
      const lines = [];
      await compileAndRun(`
        let map = fn(arr, f) {
          let result = [];
          for (x in arr) { result = push(result, f(x)); }
          result
        };
        let doubled = map([1, 2, 3], fn(x) { x * 2 });
        for (x in doubled) { puts(x); }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['2', '4', '6']);
    });

    it('user-defined filter with closures', async () => {
      assert.strictEqual(await compileAndRun(`
        let filter = fn(arr, pred) {
          let result = [];
          for (x in arr) {
            if (pred(x) == 1) { result = push(result, x); }
          }
          result
        };
        len(filter([1, 2, 3, 4, 5, 6], fn(x) { x % 2 == 0 }))
      `), 3);
    });

    it('user-defined reduce', async () => {
      assert.strictEqual(await compileAndRun(`
        let reduce = fn(arr, init, f) {
          let acc = init;
          for (x in arr) { acc = f(acc, x); }
          acc
        };
        reduce([1, 2, 3, 4, 5], 0, fn(acc, x) { acc + x })
      `), 15);
    });

    it('chained map + filter + reduce', async () => {
      assert.strictEqual(await compileAndRun(`
        let map = fn(arr, f) {
          let result = [];
          for (x in arr) { result = push(result, f(x)); }
          result
        };
        let filter = fn(arr, pred) {
          let result = [];
          for (x in arr) {
            if (pred(x) == 1) { result = push(result, x); }
          }
          result
        };
        let reduce = fn(arr, init, f) {
          let acc = init;
          for (x in arr) { acc = f(acc, x); }
          acc
        };
        let nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let result = reduce(
          map(
            filter(nums, fn(x) { x % 2 == 0 }),
            fn(x) { x * x }
          ),
          0,
          fn(acc, x) { acc + x }
        );
        result
      `), 220);
    });

    it('sieve of eratosthenes', async () => {
      assert.strictEqual(await compileAndRun(`
        let sieve = fn(n) {
          let is_prime = [];
          for (i in 0..n) { is_prime = push(is_prime, 1); }
          is_prime[0] = 0;
          is_prime[1] = 0;
          for (i in 2..n) {
            if (is_prime[i] == 1) {
              let j = i * i;
              while (j < n) { is_prime[j] = 0; j += i; }
            }
          }
          let count = 0;
          for (i in 0..n) { if (is_prime[i] == 1) { count += 1; } }
          count
        };
        sieve(100)
      `), 25);
    });

    it('map/filter/reduce pipeline', async () => {
      assert.strictEqual(await compileAndRun(`
        let map = fn(arr, f) { let r = []; for (x in arr) { r = push(r, f(x)); } r };
        let filter = fn(arr, p) { let r = []; for (x in arr) { if (p(x)) { r = push(r, x); } } r };
        let reduce = fn(arr, init, f) { let acc = init; for (x in arr) { acc = f(acc, x); } acc };
        reduce(map(filter([1,2,3,4,5,6,7,8,9,10], fn(x) { x % 2 != 0 }), fn(x) { x * x }), 0, fn(a,b) { a + b })
      `), 165);
    });

    it('runtime type checking', async () => {
      const lines = [];
      await compileAndRun('let x = [1,2]; if (type(x) == "ARRAY") { puts("array"); } else { puts("other"); }', { outputLines: lines });
      assert.strictEqual(lines[0], 'array');
    });

    it('const enforcement', async () => {
      await assert.rejects(() => compileAndRun('const x = 5; x = 10; x'), /cannot assign to const/);
    });

    it('string concatenation in loop', async () => {
      const lines = [];
      await compileAndRun('let s = ""; for (i in 0..5) { s = s + str(i); } puts(s)', { outputLines: lines });
      assert.strictEqual(lines[0], '01234');
    });

    it('nested closures with captured variables', async () => {
      assert.strictEqual(await compileAndRun(`
        let mult = fn(x) { fn(y) { x * y } };
        let triple = mult(3);
        triple(14)
      `), 42);
    });

    it('fibonacci with array memoization', async () => {
      assert.strictEqual(await compileAndRun(`
        let memo = [0, 1];
        for (i in 2..20) {
          memo = push(memo, memo[i-1] + memo[i-2]);
        }
        memo[19]
      `), 4181);
    });

    it('functional composition', async () => {
      assert.strictEqual(await compileAndRun('let compose = fn(f, g) { fn(x) { f(g(x)) } }; let double = fn(x) { x * 2 }; let inc = fn(x) { x + 1 }; let doubleAndInc = compose(inc, double); doubleAndInc(20)'), 41);
    });

    it('string iteration and rebuild', async () => {
      const lines = [];
      await compileAndRun('let s = "abc"; let r = ""; for (ch in s) { r = r + ch; } puts(r)', { outputLines: lines });
      assert.strictEqual(lines[0], 'abc');
    });

    it('GCD via Euclidean algorithm', async () => {
      assert.strictEqual(await compileAndRun(`
        let gcd = fn(a, b) {
          while (b != 0) { let temp = b; b = a % b; a = temp; }
          a
        };
        gcd(48, 18)
      `), 6);
    });

    it('power function', async () => {
      assert.strictEqual(await compileAndRun(`
        let pow = fn(base, exp) {
          let result = 1;
          for (i in 0..exp) { result = result * base; }
          result
        };
        pow(2, 10)
      `), 1024);
    });

    it('string sorting with dynamic comparison', async () => {
      const lines = [];
      await compileAndRun('let a = ["banana", "apple", "cherry"]; for (i in 0..3) { for (j in 0..2) { if (a[j] > a[j+1]) { let temp = a[j]; a[j] = a[j+1]; a[j+1] = temp; } } } for (x in a) { puts(x); }', { outputLines: lines });
      assert.deepStrictEqual(lines, ['apple', 'banana', 'cherry']);
    });
  });

  describe('Array Comprehensions', () => {
    it('simple comprehension', async () => {
      const lines = [];
      await compileAndRun(`
        let arr = [1, 2, 3, 4, 5];
        let doubled = [x * 2 for x in arr];
        for (v in doubled) { puts(v); }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['2', '4', '6', '8', '10']);
    });

    it('comprehension with filter', async () => {
      const lines = [];
      await compileAndRun(`
        let arr = [1, 2, 3, 4, 5, 6];
        let evens = [x for x in arr if x % 2 == 0];
        for (v in evens) { puts(v); }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['2', '4', '6']);
    });

    it('comprehension returns correct length', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [1, 2, 3];
        let result = [x + 10 for x in arr];
        len(result)
      `), 3);
    });

    it('comprehension with range iterable', async () => {
      const lines = [];
      await compileAndRun(`
        let squares = [x * x for x in 1..6];
        for (v in squares) { puts(v); }
      `, { outputLines: lines });
      assert.deepStrictEqual(lines, ['1', '4', '9', '16', '25']);
    });

    it('comprehension with filter reduces length', async () => {
      assert.strictEqual(await compileAndRun(`
        let arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let big = [x for x in arr if x > 7];
        len(big)
      `), 3);
    });
  });

  describe('Hash Destructuring', () => {
    it('basic hash destructuring', async () => {
      assert.strictEqual(await compileAndRun(`
        let h = {"x": 10, "y": 20};
        let {x, y} = h;
        x + y
      `), 30);
    });

    it('hash destructuring with three keys', async () => {
      assert.strictEqual(await compileAndRun(`
        let h = {"a": 1, "b": 2, "c": 3};
        let {a, b, c} = h;
        a + b + c
      `), 6);
    });
  });

  describe('Try/Throw (real WASM exception handling)', () => {
    it('try-catch without throw returns try body value', async () => {
      assert.strictEqual(await compileAndRun(`
        let result = try { 42 } catch (e) { 0 };
        result
      `), 42);
    });

    it('try-catch with computation returns result', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 10;
        let result = try { x * 5 } catch (e) { 0 };
        result
      `), 50);
    });

    it('throw is caught by catch block', async () => {
      assert.strictEqual(await compileAndRun(`
        try { throw 99; 0 } catch (e) { e }
      `), 99);
    });

    it('catch block receives thrown value', async () => {
      assert.strictEqual(await compileAndRun(`
        try { throw 42; 0 } catch (e) { e + 8 }
      `), 50);
    });

    it('try-catch in let binding', async () => {
      assert.strictEqual(await compileAndRun(`
        let result = try { throw 10; 0 } catch (e) { e * 3 };
        result
      `), 30);
    });

    it('nested try-catch', async () => {
      assert.strictEqual(await compileAndRun(`
        try {
          try { throw 5; 0 } catch (e) { e + 10 }
        } catch (e) { 0 }
      `), 15);
    });

    it('throw propagates through nested try', async () => {
      assert.strictEqual(await compileAndRun(`
        try {
          try { throw 5; 0 } catch (e) { throw e + 10; 0 }
        } catch (e) { e }
      `), 15);
    });
  });

  describe('Classes', () => {
    it('basic class with init and field access', async () => {
      assert.strictEqual(await compileAndRun(`
        class Dog {
          let name;
          fn init(n) { self.name = n; }
        }
        let d = Dog(42);
        d.name
      `), 42);
    });

    it('class with method calls', async () => {
      assert.strictEqual(await compileAndRun(`
        class Calculator {
          let result;
          fn init() { self.result = 0; }
          fn add(n) { self.result = self.result + n; self.result }
        }
        let c = Calculator();
        c.add(10);
        c.add(20);
        c.add(5)
      `), 35);
    });

    it('class with multiple fields and methods', async () => {
      assert.strictEqual(await compileAndRun(`
        class Point {
          let x;
          let y;
          fn init(x, y) { self.x = x; self.y = y; }
          fn distance() { self.x * self.x + self.y * self.y }
        }
        let p = Point(3, 4);
        p.distance()
      `), 25);
    });

    it('multiple instances are independent', async () => {
      assert.strictEqual(await compileAndRun(`
        class Counter {
          let count;
          fn init() { self.count = 0; }
          fn inc() { self.count = self.count + 1; self.count }
        }
        let a = Counter();
        let b = Counter();
        a.inc();
        a.inc();
        a.inc();
        b.inc();
        a.count * 10 + b.count
      `), 31);
    });

    it('method with arguments', async () => {
      assert.strictEqual(await compileAndRun(`
        class Math {
          fn init() { }
          fn multiply(a, b) { a * b }
        }
        let m = Math();
        m.multiply(7, 6)
      `), 42);
    });

    it('class with no init args', async () => {
      assert.strictEqual(await compileAndRun(`
        class Greeter {
          let value;
          fn init() { self.value = 100; }
          fn get() { self.value }
        }
        let g = Greeter();
        g.get()
      `), 100);
    });

    it('inheritance — inherited method', async () => {
      assert.strictEqual(await compileAndRun(`
        class Animal {
          let name;
          fn init(n) { self.name = n; }
          fn getName() { self.name }
        }
        class Dog extends Animal {
          fn bark() { 42 }
        }
        let d = Dog(99);
        d.getName()
      `), 99);
    });

    it('inheritance — method override', async () => {
      assert.strictEqual(await compileAndRun(`
        class Animal {
          fn init() { }
          fn speak() { 0 }
        }
        class Dog extends Animal {
          fn speak() { 42 }
        }
        let d = Dog();
        d.speak()
      `), 42);
    });

    it('inheritance — combined parent + child methods', async () => {
      assert.strictEqual(await compileAndRun(`
        class Base {
          fn init() { }
          fn baseMethod() { 10 }
        }
        class Child extends Base {
          fn childMethod() { 20 }
        }
        let c = Child();
        c.baseMethod() + c.childMethod()
      `), 30);
    });

    it('inheritance — parent and child fields', async () => {
      assert.strictEqual(await compileAndRun(`
        class Animal {
          let name;
          fn init(n) { self.name = n; }
        }
        class Dog extends Animal {
          let breed;
          fn setBreed(b) { self.breed = b; self.breed }
        }
        let d = Dog(99);
        d.setBreed(42) + d.name
      `), 141);
    });
  });

  describe('Import/Generator stubs', () => {
    it('import statement compiles with warning', async () => {
      const warnings = [];
      await compileAndRun(`
        import "math";
        0
      `, { warnings });
      assert.ok(warnings.some(w => w.includes('limited in WASM')));
    });

    it('generator literal compiles with warning', async () => {
      const warnings = [];
      await compileAndRun(`
        let g = gen(n) { yield n; };
        0
      `, { warnings });
      assert.ok(warnings.some(w => w.includes('not supported in WASM')));
    });
  });
});

describe('Integration Tests', () => {
  it('fibonacci with WASM exception on negative input', async () => {
    assert.strictEqual(await compileAndRun(`
      let fib = fn(n) {
        if (n < 0) { throw -1 }
        if (n < 2) { n } else { fib(n-1) + fib(n-2) }
      }
      let result = try { fib(10) } catch (e) { e }
      result
    `), 55);
  });

  it('class with inheritance + method calls + arithmetic', async () => {
    assert.strictEqual(await compileAndRun(`
      class Shape {
        let sides
        fn init(s) { self.sides = s }
        fn perimeter(length) { self.sides * length }
      }
      class Square extends Shape {
        fn area(length) { length * length }
      }
      let s = Square(4)
      s.perimeter(5) + s.area(3)
    `), 29);
  });

  it('array comprehension + hash destructuring + HOF', async () => {
    assert.strictEqual(await compileAndRun(`
      let config = {"scale": 2, "offset": 10}
      let {scale, offset} = config
      let data = [1, 2, 3, 4, 5]
      let transformed = [x * scale + offset for x in data]
      let sum = 0
      for (v in transformed) { sum = sum + v }
      sum
    `), 80);
  });

  it('closure factory + for-in loop + accumulator', async () => {
    assert.strictEqual(await compileAndRun(`
      let makeAdder = fn(x) { fn(y) { x + y } }
      let add10 = makeAdder(10)
      let add20 = makeAdder(20)
      let total = 0
      for (i in 0..5) {
        total = total + add10(i) + add20(i)
      }
      total
    `), 170); // 30+32+34+36+38 = 170
  });

  it('nested try-catch with class methods', async () => {
    assert.strictEqual(await compileAndRun(`
      class Validator {
        fn init() { }
        fn check(n) {
          if (n < 0) { throw n }
          n * 2
        }
      }
      let v = Validator()
      let a = try { v.check(5) } catch (e) { e }
      let b = try { v.check(-3) } catch (e) { e }
      a * 10 + b
    `), 97);
  });

  it('while loop with break-like pattern', async () => {
    assert.strictEqual(await compileAndRun(`
      let sum = 0
      let i = 1
      while (i <= 100) {
        sum = sum + i
        i = i + 1
      }
      sum
    `), 5050);
  });
});

describe('Super Calls', () => {
  it('super.method() calls parent method', async () => {
    assert.strictEqual(await compileAndRun(`
      class A {
        fn init() { }
        fn value() { 10 }
      }
      class B extends A {
        fn value() { super.value() + 20 }
      }
      let b = B()
      b.value()
    `), 30);
  });

  it('super.method() with self field access', async () => {
    assert.strictEqual(await compileAndRun(`
      class Animal {
        let name
        fn init(n) { self.name = n }
        fn getName() { self.name }
      }
      class Dog extends Animal {
        fn getName() { super.getName() + 1000 }
      }
      let d = Dog(42)
      d.getName()
    `), 1042);
  });

  it('super with arguments', async () => {
    assert.strictEqual(await compileAndRun(`
      class Base {
        fn init() { }
        fn add(a, b) { a + b }
      }
      class Child extends Base {
        fn add(a, b) { super.add(a, b) * 2 }
      }
      let c = Child()
      c.add(3, 4)
    `), 14);
  });
});

describe('Float Support', () => {
  // Helper: run code and capture puts() output (which formats floats correctly)
  async function runWithOutput(code) {
    const outputLines = [];
    await compileAndRun(code, { outputLines });
    return outputLines;
  }

  describe('Float literals', () => {
    it('compiles float literal via puts', async () => {
      const output = await runWithOutput('puts(3.14)');
      assert.strictEqual(output[0], '3.14');
    });

    it('compiles negative float literal', async () => {
      const output = await runWithOutput('puts(-2.5)');
      assert.strictEqual(output[0], '-2.5');
    });

    it('compiles float with zero fractional part', async () => {
      const output = await runWithOutput('puts(5.0)');
      assert.strictEqual(output[0], '5.0');
    });
  });

  describe('Float arithmetic', () => {
    it('adds two floats', async () => {
      const output = await runWithOutput('puts(1.5 + 2.5)');
      assert.strictEqual(output[0], '4');
    });

    it('subtracts floats', async () => {
      const output = await runWithOutput('puts(5.5 - 2.3)');
      assert.strictEqual(output[0], '3.2');
    });

    it('multiplies floats', async () => {
      const output = await runWithOutput('puts(2.5 * 4.0)');
      assert.strictEqual(output[0], '10');
    });

    it('divides floats', async () => {
      const output = await runWithOutput('puts(7.5 / 2.5)');
      assert.strictEqual(output[0], '3');
    });

    it('modulus with floats', async () => {
      const output = await runWithOutput('puts(7.5 % 2.0)');
      assert.strictEqual(output[0], '1.5');
    });

    it('negates a float', async () => {
      const output = await runWithOutput('puts(-3.14)');
      assert.strictEqual(output[0], '-3.14');
    });
  });

  describe('Mixed int/float arithmetic', () => {
    it('adds int and float', async () => {
      const output = await runWithOutput('puts(1 + 2.5)');
      assert.strictEqual(output[0], '3.5');
    });

    it('subtracts float from int', async () => {
      const output = await runWithOutput('puts(5 - 1.5)');
      assert.strictEqual(output[0], '3.5');
    });

    it('multiplies int by float', async () => {
      const output = await runWithOutput('puts(3 * 2.5)');
      assert.strictEqual(output[0], '7.5');
    });

    it('divides int by float', async () => {
      const output = await runWithOutput('puts(10 / 2.5)');
      assert.strictEqual(output[0], '4');
    });

    it('int division returning float', async () => {
      const output = await runWithOutput('puts(7.0 / 2.0)');
      assert.strictEqual(output[0], '3.5');
    });
  });

  describe('Float comparisons', () => {
    it('float equality', async () => {
      const output = await runWithOutput('puts(3.14 == 3.14)');
      assert.strictEqual(output[0], '1');
    });

    it('float inequality', async () => {
      const output = await runWithOutput('puts(3.14 == 2.71)');
      assert.strictEqual(output[0], '0');
    });

    it('float less than', async () => {
      const output = await runWithOutput('puts(2.5 < 3.5)');
      assert.strictEqual(output[0], '1');
    });

    it('float greater than', async () => {
      const output = await runWithOutput('puts(3.5 > 2.5)');
      assert.strictEqual(output[0], '1');
    });

    it('mixed int/float comparison', async () => {
      const output = await runWithOutput('puts(2 < 2.5)');
      assert.strictEqual(output[0], '1');
    });
  });

  describe('Float in variables and functions', () => {
    it('let binding with float', async () => {
      const output = await runWithOutput('let x = 3.14; puts(x)');
      assert.strictEqual(output[0], '3.14');
    });

    it('float in function return', async () => {
      const output = await runWithOutput(`
        let circle_area = fn(r) { 3.14159 * r * r };
        puts(circle_area(2.0))
      `);
      assert.strictEqual(output[0], '12.56636');
    });

    it('float accumulation in loop', async () => {
      const output = await runWithOutput(`
        let sum = 0.0;
        let i = 0;
        while (i < 5) {
          sum = sum + 0.5;
          i = i + 1;
        }
        puts(sum)
      `);
      assert.strictEqual(output[0], '2.5');
    });

    it('float in closure capture', async () => {
      const output = await runWithOutput(`
        let pi = 3.14;
        let scale = fn(x) { pi * x };
        puts(scale(2))
      `);
      assert.strictEqual(output[0], '6.28');
    });
  });
});

describe('Edge Cases (Stress Tests)', () => {
  describe('Recursion', () => {
    it('mutual recursion (isEven/isOdd)', async () => {
      assert.strictEqual(await compileAndRun(`
        let isEven = fn(n) {
          if (n == 0) { 1 }
          else { isOdd(n - 1) }
        };
        let isOdd = fn(n) {
          if (n == 0) { 0 }
          else { isEven(n - 1) }
        };
        isEven(10) * 10 + isOdd(7)
      `), 11);
    });

    it('fibonacci with memoization', async () => {
      assert.strictEqual(await compileAndRun(`
        let memo = {};
        let fib = fn(n) {
          if (n < 2) { return n; }
          let key = n;
          if (memo[key]) { return memo[key]; }
          let result = fib(n - 1) + fib(n - 2);
          memo[key] = result;
          result
        };
        fib(10)
      `), 55);
    });
  });

  describe('Complex patterns', () => {
    it('deeply nested closures (3 levels)', async () => {
      assert.strictEqual(await compileAndRun(`
        let make_adder = fn(x) {
          fn(y) {
            fn(z) { x + y + z }
          }
        };
        let add5 = make_adder(5);
        let add5_10 = add5(10);
        add5_10(20)
      `), 35);
    });

    it('middle function with puts and nested closure', async () => {
      const outputLines = [];
      await compileAndRun(`
        let f = fn(x) {
          fn(y) {
            puts(y);
            fn(z) { z }
          }
        };
        f(5)(10)(20)
      `, { outputLines });
      assert.strictEqual(outputLines[0], '10');
    });

    it('4-level nested closures', async () => {
      assert.strictEqual(await compileAndRun(`
        let f = fn(a) {
          fn(b) {
            fn(c) {
              fn(d) { a + b + c + d }
            }
          }
        };
        f(1)(2)(3)(4)
      `), 10);
    });

    it('nested closure with intermediate computation', async () => {
      assert.strictEqual(await compileAndRun(`
        let f = fn(x) {
          let doubled = x * 2;
          fn(y) {
            let sum = doubled + y;
            fn(z) { sum + z }
          }
        };
        f(5)(10)(20)
      `), 40); // doubled=10, sum=10+10=20, result=20+20=40
    });

    it('higher-order map function', async () => {
      assert.strictEqual(await compileAndRun(`
        let map = fn(arr, f) {
          let result = [];
          let i = 0;
          while (i < len(arr)) {
            result = push(result, f(arr[i]));
            i = i + 1;
          }
          result
        };
        let double = fn(x) { x * 2 };
        let arr = [1, 2, 3, 4, 5];
        let doubled = map(arr, double);
        doubled[4]
      `), 10);
    });

    it('chained method calls', async () => {
      assert.strictEqual(await compileAndRun(`
        class Builder {
          let value;
          fn init() { self.value = 0; }
          fn add(n) { self.value = self.value + n; self }
          fn result() { self.value }
        }
        let b = Builder();
        b.add(10).add(20).add(30).result()
      `), 60);
    });

    it('try/catch in loop', async () => {
      assert.strictEqual(await compileAndRun(`
        let total = 0;
        let i = 0;
        while (i < 5) {
          try {
            if (i == 3) { throw("skip"); }
            total = total + i;
          } catch (e) {
            total = total + 100;
          }
          i = i + 1;
        }
        total
      `), 107);
    });

    it('three-level class inheritance', async () => {
      assert.strictEqual(await compileAndRun(`
        class Shape {
          let area;
          fn init() { self.area = 0; }
          fn getArea() { self.area }
        }
        class Rectangle extends Shape {
          let width;
          let height;
          fn init(w, h) {
            super.init();
            self.width = w;
            self.height = h;
            self.area = w * h;
          }
        }
        class Square extends Rectangle {
          fn init(s) {
            super.init(s, s);
          }
        }
        let sq = Square(5);
        sq.getArea()
      `), 25);
    });

    it('nested array indexing', async () => {
      assert.strictEqual(await compileAndRun('let a = [[1, 2], [3, 4], [5, 6]]; a[1][0] + a[2][1]'), 9);
    });
  });

  describe('Float edge cases', () => {
    it('float comparison with integer', async () => {
      assert.strictEqual(await compileAndRun('if (2.5 > 2) { 1 } else { 0 }'), 1);
    });

    it('classic floating point imprecision', async () => {
      assert.strictEqual(await compileAndRun('0.1 + 0.2 == 0.3'), 0);
    });

    it('float in array', async () => {
      const outputLines = [];
      await compileAndRun('puts([1.1, 2.2, 3.3][1])', { outputLines });
      assert.strictEqual(outputLines[0], '2.2');
    });
  });

  describe('Numeric edge cases', () => {
    it('deeply nested function calls', async () => {
      assert.strictEqual(await compileAndRun(`
        let add1 = fn(x) { x + 1 };
        add1(add1(add1(add1(add1(add1(add1(add1(add1(add1(0))))))))))
      `), 10);
    });

    it('loop 100 iterations', async () => {
      assert.strictEqual(await compileAndRun(`
        let x = 0;
        let i = 0;
        while (i < 100) {
          x = x + 1;
          i = i + 1;
        }
        x
      `), 100);
    });

    it('boolean arithmetic', async () => {
      assert.strictEqual(await compileAndRun('(1 == 1) + (2 == 2) + (3 == 4)'), 2);
    });
  });
});

describe('String Methods', () => {
  it('split', async () => {
    const outputLines = [];
    await compileAndRun('let parts = split("hello world", " "); puts(parts[0]); puts(parts[1])', { outputLines });
    assert.deepStrictEqual(outputLines, ['hello', 'world']);
  });

  it('trim', async () => {
    const outputLines = [];
    await compileAndRun('puts(trim("  hello  "))', { outputLines });
    assert.strictEqual(outputLines[0], 'hello');
  });

  it('replace', async () => {
    const outputLines = [];
    await compileAndRun('puts(replace("hello world", "world", "earth"))', { outputLines });
    assert.strictEqual(outputLines[0], 'hello earth');
  });

  it('indexOf', async () => {
    assert.strictEqual(await compileAndRun('indexOf("hello world", "world")'), 6);
  });

  it('indexOf not found', async () => {
    assert.strictEqual(await compileAndRun('indexOf("hello", "xyz")'), -1);
  });

  it('startsWith', async () => {
    assert.strictEqual(await compileAndRun('startsWith("hello world", "hello")'), 1);
    assert.strictEqual(await compileAndRun('startsWith("hello world", "world")'), 0);
  });

  it('endsWith', async () => {
    assert.strictEqual(await compileAndRun('endsWith("hello world", "world")'), 1);
    assert.strictEqual(await compileAndRun('endsWith("hello world", "hello")'), 0);
  });

  it('toUpper', async () => {
    const outputLines = [];
    await compileAndRun('puts(toUpper("hello"))', { outputLines });
    assert.strictEqual(outputLines[0], 'HELLO');
  });

  it('toLower', async () => {
    const outputLines = [];
    await compileAndRun('puts(toLower("HELLO"))', { outputLines });
    assert.strictEqual(outputLines[0], 'hello');
  });

  it('substring', async () => {
    const outputLines = [];
    await compileAndRun('puts(substring("hello world", 6))', { outputLines });
    assert.strictEqual(outputLines[0], 'world');
  });

  it('substring with end', async () => {
    const outputLines = [];
    await compileAndRun('puts(substring("hello world", 0, 5))', { outputLines });
    assert.strictEqual(outputLines[0], 'hello');
  });
});

// Box/Cell Closure Regression Tests (Apr 28, 2026)
// These test the 3 closure bugs found during Apr 27 exploration
describe('Box/Cell Closures', () => {
  describe('Bug 1: Self-referencing closures with multiple captures', () => {
    it('self-ref closure with captured variable returns correct value', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let x = 100;
          let f = fn(n) { if (n <= 0) { x } else { f(n - 1) } };
          f(3)
        };
        make()
      `), 100);
    });

    it('self-ref closure with multiple captured vars', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let a = 10;
          let b = 20;
          let f = fn(n) { if (n <= 0) { a + b } else { f(n - 1) } };
          f(5)
        };
        make()
      `), 30);
    });
  });

  describe('Bug 2: Shared mutable state between closures', () => {
    it('two closures share the same mutable variable', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let x = 0;
          let inc = fn() { x = x + 1; x };
          let get = fn() { x };
          inc();
          get()
        };
        make()
      `), 1);
    });

    it('multiple increments visible through getter', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let x = 0;
          let inc = fn() { x = x + 1; x };
          let get = fn() { x };
          inc(); inc(); inc();
          get()
        };
        make()
      `), 3);
    });

    it('outer scope reads mutations from inner closure', async () => {
      assert.strictEqual(await compileAndRun(`
        let f = fn() {
          let result = 0;
          let inner = fn(i) { result = result + i; result };
          inner(1); inner(2); inner(3);
          result
        };
        f()
      `), 6);
    });

    it('counter pattern with inc/dec/get', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let count = 10;
          let inc = fn() { count = count + 1; count };
          let dec = fn() { count = count - 1; count };
          let get = fn() { count };
          inc(); inc(); dec();
          get()
        };
        make()
      `), 11);
    });
  });

  describe('Bug 3: Recursive closures with mutable captures', () => {
    it('recursive accumulation', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let result = 0;
          let loop = fn(i) { if (i > 0) { result = result + i; loop(i - 1) } else { result } };
          loop(5)
        };
        make()
      `), 15);
    });

    it('recursive factorial via mutable accumulator', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let acc = 1;
          let fact = fn(n) { if (n <= 1) { acc } else { acc = acc * n; fact(n - 1) } };
          fact(5)
        };
        make()
      `), 120);
    });
  });

  describe('Box/cell does not break non-boxed closures', () => {
    it('simple counter (single closure, no sharing needed)', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let x = 0;
          let inc = fn() { x = x + 1; x };
          inc(); inc(); inc()
        };
        make()
      `), 3);
    });

    it('non-mutating closure (no boxing needed)', async () => {
      assert.strictEqual(await compileAndRun(`
        let make = fn() {
          let x = 42;
          let get = fn() { x };
          get()
        };
        make()
      `), 42);
    });
  });
});

describe('Higher-Order Function Builtins', () => {
  // Helper: compile and get formatted result
  async function run(code) {
    const opts = { outputLines: [], instance: {} };
    const result = await compileAndRun(code, opts);
    const view = new DataView(opts.instance.ref.exports.memory.buffer);
    return formatWasmValue(result, view);
  }

  describe('map', () => {
    it('doubles each element', async () => {
      assert.strictEqual(await run('map([1, 2, 3, 4, 5], fn(x) { x * 2 })'), '[2, 4, 6, 8, 10]');
    });

    it('squares each element', async () => {
      assert.strictEqual(await run('map([3, 4, 5], fn(x) { x * x })'), '[9, 16, 25]');
    });

    it('empty array', async () => {
      assert.strictEqual(await run('map([], fn(x) { x * 2 })'), '[]');
    });

    it('closure captures variable', async () => {
      assert.strictEqual(await run('let f = 10; map([1, 2, 3], fn(x) { x * f })'), '[10, 20, 30]');
    });

    it('single element', async () => {
      assert.strictEqual(await run('map([42], fn(x) { x + 1 })'), '[43]');
    });
  });

  describe('filter', () => {
    it('filters greater than', async () => {
      assert.strictEqual(await run('filter([1, 2, 3, 4, 5, 6], fn(x) { x > 3 })'), '[4, 5, 6]');
    });

    it('filters even numbers', async () => {
      assert.strictEqual(await run('filter([1, 2, 3, 4, 5, 6], fn(x) { x % 2 == 0 })'), '[2, 4, 6]');
    });

    it('empty result', async () => {
      assert.strictEqual(await run('filter([1, 2, 3], fn(x) { x > 100 })'), '[]');
    });

    it('all pass', async () => {
      assert.strictEqual(await run('filter([1, 2, 3], fn(x) { x > 0 })'), '[1, 2, 3]');
    });

    it('closure captures threshold', async () => {
      assert.strictEqual(await run('let t = 3; filter([1, 2, 3, 4, 5], fn(x) { x > t })'), '[4, 5]');
    });
  });

  describe('reduce', () => {
    it('sum with initial value', async () => {
      assert.strictEqual(await compileAndRun('reduce([1, 2, 3, 4, 5], fn(a, b) { a + b }, 0)'), 15);
    });

    it('sum without initial value', async () => {
      assert.strictEqual(await compileAndRun('reduce([1, 2, 3, 4, 5], fn(a, b) { a + b })'), 15);
    });

    it('product', async () => {
      assert.strictEqual(await compileAndRun('reduce([1, 2, 3, 4, 5], fn(a, b) { a * b }, 1)'), 120);
    });

    it('single element no init', async () => {
      assert.strictEqual(await compileAndRun('reduce([42], fn(a, b) { a + b })'), 42);
    });

    it('max value', async () => {
      assert.strictEqual(await compileAndRun(`
        reduce([3, 1, 4, 1, 5, 9, 2, 6], fn(a, b) { if (b > a) { b } else { a } })
      `), 9);
    });
  });

  describe('find', () => {
    it('finds first match', async () => {
      assert.strictEqual(await compileAndRun('find([1, 2, 3, 4, 5], fn(x) { x > 3 })'), 4);
    });

    it('returns 0 (null) when not found', async () => {
      assert.strictEqual(await compileAndRun('find([1, 2, 3], fn(x) { x > 100 })'), 0);
    });
  });

  describe('any', () => {
    it('returns true when match exists', async () => {
      assert.strictEqual(await compileAndRun('any([1, 2, 10], fn(x) { x > 5 })'), 1);
    });

    it('returns false when no match', async () => {
      assert.strictEqual(await compileAndRun('any([1, 2, 3], fn(x) { x > 5 })'), 0);
    });
  });

  describe('every', () => {
    it('returns true when all match', async () => {
      assert.strictEqual(await compileAndRun('every([2, 4, 6], fn(x) { x > 0 })'), 1);
    });

    it('returns false when one fails', async () => {
      assert.strictEqual(await compileAndRun('every([2, 4, -1], fn(x) { x > 0 })'), 0);
    });

    it('empty array returns true', async () => {
      assert.strictEqual(await compileAndRun('every([], fn(x) { x > 0 })'), 1);
    });
  });

  describe('chaining', () => {
    it('filter then map', async () => {
      assert.strictEqual(
        await run('let a = [1,2,3,4,5,6,7,8,9,10]; let e = filter(a, fn(x) { x % 2 == 0 }); map(e, fn(x) { x * x })'),
        '[4, 16, 36, 64, 100]'
      );
    });

    it('map then reduce', async () => {
      assert.strictEqual(
        await compileAndRun('reduce(map([1, 2, 3, 4], fn(x) { x * x }), fn(a, b) { a + b }, 0)'),
        30 // 1 + 4 + 9 + 16
      );
    });

    it('filter then reduce', async () => {
      assert.strictEqual(
        await compileAndRun('reduce(filter([1, 2, 3, 4, 5, 6], fn(x) { x % 2 == 0 }), fn(a, b) { a + b }, 0)'),
        12 // 2 + 4 + 6
      );
    });
  });

  describe('user-defined shadows', () => {
    it('user-defined map takes precedence', async () => {
      assert.strictEqual(await run(`
        let map = fn(arr, f) {
          let result = [];
          for (x in arr) { result = push(result, f(x)); }
          result
        };
        map([1, 2, 3], fn(x) { x + 10 })
      `), '[11, 12, 13]');
    });

    it('user-defined filter takes precedence', async () => {
      assert.strictEqual(await compileAndRun(`
        let filter = fn(arr, pred) {
          let result = [];
          for (x in arr) {
            if (pred(x)) { result = push(result, x); }
          }
          len(result)
        };
        filter([1, 2, 3, 4, 5], fn(x) { x > 2 })
      `), 3);
    });
  });

  describe('higher-order closures', () => {
    it('Y-combinator factorial', async () => {
      assert.strictEqual(await compileAndRun(`
        let Y = fn(f) { f(fn(x) { Y(f)(x) }) };
        let fact = Y(fn(self) { fn(n) { if (n <= 1) { 1 } else { n * self(n - 1) } } });
        fact(5)
      `), 120);
    });

    it('closure parameter single call', async () => {
      assert.strictEqual(await compileAndRun(`
        let wrap = fn(f) { f(fn(x) { x }) };
        let fn1 = wrap(fn(self) { fn(n) { self(n) } });
        fn1(42)
      `), 42);
    });
  });

  describe('sort', () => {
    it('default ascending sort', async () => {
      assert.strictEqual(await run('sort([5, 3, 1, 4, 2])'), '[1, 2, 3, 4, 5]');
    });

    it('custom comparator (descending)', async () => {
      assert.strictEqual(await run('sort([5, 3, 1, 4, 2], fn(a, b) { b - a })'), '[5, 4, 3, 2, 1]');
    });

    it('empty array', async () => {
      assert.strictEqual(await run('sort([])'), '[]');
    });

    it('single element', async () => {
      assert.strictEqual(await run('sort([42])'), '[42]');
    });

    it('already sorted', async () => {
      assert.strictEqual(await run('sort([1, 2, 3])'), '[1, 2, 3]');
    });

    it('duplicates', async () => {
      assert.strictEqual(await run('sort([3, 1, 2, 1, 3])'), '[1, 1, 2, 3, 3]');
    });
  });

  describe('large arrays (stress)', () => {
    it('reduce 10000 elements (heap boundary test)', async () => {
      assert.strictEqual(
        await compileAndRun('reduce(range(1, 10001), fn(a, b) { a + b }, 0)'),
        50005000 // n*(n+1)/2 for n=10000
      );
    });

    it('filter 10000 elements', async () => {
      assert.strictEqual(
        await compileAndRun('len(filter(range(0, 10000), fn(x) { x % 7 == 0 }))'),
        1429
      );
    });

    it('map + reduce chain on 5000 elements', async () => {
      assert.strictEqual(
        await compileAndRun('reduce(map(range(1, 5001), fn(x) { x * 2 }), fn(a, b) { a + b }, 0)'),
        25005000
      );
    });

    it('push loop + map on 1000 elements (memory growth)', async () => {
      assert.strictEqual(
        await compileAndRun('let a = []; let i = 0; while (i < 1000) { a = push(a, i); i = i + 1; }; let b = map(a, fn(x) { x * 2 }); b[999]'),
        1998
      );
    });
  });

  describe('forEach', () => {
    it('calls function for each element', async () => {
      const outputLines = [];
      await compileAndRun('forEach([10, 20, 30], fn(x) { puts(x) })', { outputLines });
      assert.deepStrictEqual(outputLines, ['10', '20', '30']);
    });

    it('empty array does nothing', async () => {
      const outputLines = [];
      await compileAndRun('forEach([], fn(x) { puts(x) })', { outputLines });
      assert.deepStrictEqual(outputLines, []);
    });

    it('returns null (0)', async () => {
      assert.strictEqual(await compileAndRun('forEach([1, 2, 3], fn(x) { x })'), 0);
    });
  });

  describe('flatMap', () => {
    it('maps and flattens one level', async () => {
      assert.strictEqual(await run('flatMap([1, 2, 3], fn(x) { [x, x * 10] })'), '[1, 10, 2, 20, 3, 30]');
    });

    it('flattens nested arrays', async () => {
      assert.strictEqual(await run('flatMap([[1, 2], [3, 4], [5, 6]], fn(x) { x })'), '[1, 2, 3, 4, 5, 6]');
    });

    it('empty array', async () => {
      assert.strictEqual(await run('flatMap([], fn(x) { [x] })'), '[]');
    });

    it('non-array return is kept as-is', async () => {
      assert.strictEqual(await run('flatMap([1, 2, 3], fn(x) { x * 2 })'), '[2, 4, 6]');
    });
  });

  describe('zip', () => {
    it('pairs elements from two arrays', async () => {
      assert.strictEqual(await run('zip([1, 2, 3], [10, 20, 30])'), '[[1, 10], [2, 20], [3, 30]]');
    });

    it('truncates to shorter array', async () => {
      assert.strictEqual(await run('zip([1, 2, 3], [10, 20])'), '[[1, 10], [2, 20]]');
    });

    it('empty arrays', async () => {
      assert.strictEqual(await run('zip([], [])'), '[]');
    });
  });

  describe('enumerate', () => {
    it('pairs each element with its index', async () => {
      assert.strictEqual(await run('enumerate([10, 20, 30])'), '[[0, 10], [1, 20], [2, 30]]');
    });

    it('empty array', async () => {
      assert.strictEqual(await run('enumerate([])'), '[]');
    });

    it('single element', async () => {
      assert.strictEqual(await run('enumerate([42])'), '[[0, 42]]');
    });
  });
});
