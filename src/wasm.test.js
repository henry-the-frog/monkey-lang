// wasm.test.js — Tests for WASM compilation
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

function wasmRun(source, funcName, ...args) {
  const binary = compileToWasm(source);
  const mod = new WebAssembly.Module(binary);
  const instance = new WebAssembly.Instance(mod);
  return instance.exports[funcName](...args);
}

describe('WASM: arithmetic', () => {
  it('addition', () => {
    assert.strictEqual(wasmRun('let add = fn(a, b) { a + b; };', 'add', 3, 4), 7);
  });
  
  it('subtraction', () => {
    assert.strictEqual(wasmRun('let sub = fn(a, b) { a - b; };', 'sub', 10, 3), 7);
  });
  
  it('multiplication', () => {
    assert.strictEqual(wasmRun('let mul = fn(a, b) { a * b; };', 'mul', 6, 7), 42);
  });
  
  it('division', () => {
    assert.strictEqual(wasmRun('let div = fn(a, b) { a / b; };', 'div', 20, 4), 5);
  });
  
  it('modulo', () => {
    assert.strictEqual(wasmRun('let mod = fn(a, b) { a % b; };', 'mod', 17, 5), 2);
  });
  
  it('complex expression', () => {
    assert.strictEqual(
      wasmRun('let calc = fn(x) { (x + 1) * (x - 1); };', 'calc', 5),
      24 // 6 * 4
    );
  });
  
  it('negation', () => {
    assert.strictEqual(wasmRun('let neg = fn(x) { -x; };', 'neg', 42), -42);
  });
  
  it('negative literal', () => {
    assert.strictEqual(wasmRun('let f = fn(x) { x + (-10); };', 'f', 15), 5);
  });
});

describe('WASM: comparisons', () => {
  it('less than', () => {
    assert.strictEqual(wasmRun('let lt = fn(a, b) { a < b; };', 'lt', 3, 5), 1);
    assert.strictEqual(wasmRun('let lt = fn(a, b) { a < b; };', 'lt', 5, 3), 0);
  });
  
  it('greater than', () => {
    assert.strictEqual(wasmRun('let gt = fn(a, b) { a > b; };', 'gt', 5, 3), 1);
    assert.strictEqual(wasmRun('let gt = fn(a, b) { a > b; };', 'gt', 3, 5), 0);
  });
  
  it('equality', () => {
    assert.strictEqual(wasmRun('let eq = fn(a, b) { a == b; };', 'eq', 5, 5), 1);
    assert.strictEqual(wasmRun('let eq = fn(a, b) { a == b; };', 'eq', 5, 3), 0);
  });
  
  it('inequality', () => {
    assert.strictEqual(wasmRun('let ne = fn(a, b) { a != b; };', 'ne', 5, 3), 1);
    assert.strictEqual(wasmRun('let ne = fn(a, b) { a != b; };', 'ne', 5, 5), 0);
  });
  
  it('boolean not', () => {
    assert.strictEqual(wasmRun('let not = fn(x) { !x; };', 'not', 0), 1);
    assert.strictEqual(wasmRun('let not = fn(x) { !x; };', 'not', 1), 0);
  });
});

describe('WASM: if/else', () => {
  it('basic if-else', () => {
    const src = 'let max = fn(a, b) { if (a > b) { a; } else { b; }; };';
    assert.strictEqual(wasmRun(src, 'max', 3, 7), 7);
    assert.strictEqual(wasmRun(src, 'max', 10, 5), 10);
  });
  
  it('if with complex condition', () => {
    const src = 'let clamp = fn(x, lo, hi) { if (x < lo) { lo; } else { if (x > hi) { hi; } else { x; }; }; };';
    assert.strictEqual(wasmRun(src, 'clamp', 5, 0, 10), 5);
    assert.strictEqual(wasmRun(src, 'clamp', -5, 0, 10), 0);
    assert.strictEqual(wasmRun(src, 'clamp', 15, 0, 10), 10);
  });
  
  it('absolute value', () => {
    const src = 'let abs = fn(x) { if (x < 0) { -x; } else { x; }; };';
    assert.strictEqual(wasmRun(src, 'abs', -42), 42);
    assert.strictEqual(wasmRun(src, 'abs', 7), 7);
    assert.strictEqual(wasmRun(src, 'abs', 0), 0);
  });
});

describe('WASM: local variables', () => {
  it('simple let binding', () => {
    const src = 'let f = fn(x) { let y = x * 2; y + 1; };';
    assert.strictEqual(wasmRun(src, 'f', 5), 11);
  });
  
  it('multiple locals', () => {
    const src = 'let f = fn(x, y) { let sum = x + y; let diff = x - y; sum * diff; };';
    assert.strictEqual(wasmRun(src, 'f', 5, 3), 16); // 8 * 2
  });
  
  it('locals with if', () => {
    const src = 'let f = fn(x) { let sign = if (x > 0) { 1; } else { if (x < 0) { -1; } else { 0; }; }; sign; };';
    assert.strictEqual(wasmRun(src, 'f', 5), 1);
    assert.strictEqual(wasmRun(src, 'f', -5), -1);
    assert.strictEqual(wasmRun(src, 'f', 0), 0);
  });
});

describe('WASM: function calls', () => {
  it('call another function', () => {
    const src = 'let double = fn(x) { x * 2; };\nlet triple = fn(x) { x * 3; };\nlet f = fn(x) { double(x) + triple(x); };';
    assert.strictEqual(wasmRun(src, 'f', 5), 25); // 10 + 15
  });
  
  it('nested function calls', () => {
    const src = 'let inc = fn(x) { x + 1; };\nlet f = fn(x) { inc(inc(inc(x))); };';
    assert.strictEqual(wasmRun(src, 'f', 0), 3);
  });
  
  it('recursive fibonacci', () => {
    const src = 'let fib = fn(n) { if (n < 2) { n; } else { fib(n - 1) + fib(n - 2); }; };';
    assert.strictEqual(wasmRun(src, 'fib', 0), 0);
    assert.strictEqual(wasmRun(src, 'fib', 1), 1);
    assert.strictEqual(wasmRun(src, 'fib', 10), 55);
    assert.strictEqual(wasmRun(src, 'fib', 20), 6765);
  });
  
  it('recursive factorial', () => {
    const src = 'let fact = fn(n) { if (n <= 1) { 1; } else { n * fact(n - 1); }; };';
    assert.strictEqual(wasmRun(src, 'fact', 1), 1);
    assert.strictEqual(wasmRun(src, 'fact', 5), 120);
    assert.strictEqual(wasmRun(src, 'fact', 10), 3628800);
  });
});

describe('WASM: return statement', () => {
  it('explicit return', () => {
    const src = 'let f = fn(x) { return x * 2; };';
    assert.strictEqual(wasmRun(src, 'f', 5), 10);
  });
  
  it('early return', () => {
    const src = `let f = fn(x) {
      if (x < 0) { return -1; };
      return x;
    };`;
    assert.strictEqual(wasmRun(src, 'f', 5), 5);
    assert.strictEqual(wasmRun(src, 'f', -5), -1);
  });
});

describe('WASM: main expression', () => {
  it('compiles standalone expression as main()', () => {
    const src = 'let double = fn(x) { x * 2; };\ndouble(21);';
    assert.strictEqual(wasmRun(src, 'main'), 42);
  });
});

describe('WASM: while loops', () => {
  it('basic while loop', () => {
    const src = `let sum_to = fn(n) {
      let total = 0;
      let i = 1;
      while (i <= n) {
        set total = total + i;
        set i = i + 1;
      };
      total;
    };`;
    assert.strictEqual(wasmRun(src, 'sum_to', 10), 55);
    assert.strictEqual(wasmRun(src, 'sum_to', 100), 5050);
  });

  it('iterative factorial', () => {
    const src = `let fact = fn(n) {
      let result = 1;
      let i = 1;
      while (i <= n) {
        set result = result * i;
        set i = i + 1;
      };
      result;
    };`;
    assert.strictEqual(wasmRun(src, 'fact', 5), 120);
    assert.strictEqual(wasmRun(src, 'fact', 10), 3628800);
  });

  it('iterative fibonacci', () => {
    const src = `let fib = fn(n) {
      let a = 0;
      let b = 1;
      let i = 0;
      while (i < n) {
        let temp = b;
        set b = a + b;
        set a = temp;
        set i = i + 1;
      };
      a;
    };`;
    assert.strictEqual(wasmRun(src, 'fib', 0), 0);
    assert.strictEqual(wasmRun(src, 'fib', 1), 1);
    assert.strictEqual(wasmRun(src, 'fib', 10), 55);
    assert.strictEqual(wasmRun(src, 'fib', 20), 6765);
  });

  it('while with zero iterations', () => {
    const src = `let f = fn(n) {
      let x = 42;
      while (n > 0) {
        set x = 0;
        set n = n - 1;
      };
      x;
    };`;
    assert.strictEqual(wasmRun(src, 'f', 0), 42); // no iterations
    assert.strictEqual(wasmRun(src, 'f', 1), 0);  // one iteration
  });
});

describe('WASM: set statement', () => {
  it('reassign local', () => {
    const src = `let f = fn(x) {
      let y = x;
      set y = y * 2;
      set y = y + 1;
      y;
    };`;
    assert.strictEqual(wasmRun(src, 'f', 5), 11); // (5 * 2) + 1
  });
});

describe('WASM: for loop', () => {
  it('C-style for loop', () => {
    const src = `let sum_range = fn(start, end) {
      let total = 0;
      for (let i = start; i < end; set i = i + 1) {
        set total = total + i;
      };
      total;
    };`;
    assert.strictEqual(wasmRun(src, 'sum_range', 1, 11), 55);
    assert.strictEqual(wasmRun(src, 'sum_range', 0, 100), 4950);
  });

  it('for loop with multiplication', () => {
    const src = `let power = fn(base, exp) {
      let result = 1;
      for (let i = 0; i < exp; set i = i + 1) {
        set result = result * base;
      };
      result;
    };`;
    assert.strictEqual(wasmRun(src, 'power', 2, 10), 1024);
    assert.strictEqual(wasmRun(src, 'power', 3, 5), 243);
  });
});
