// native-hof.test.js — Tests for native HOF builtins (callClosureSync mechanism)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWithPrelude } from './prelude.js';
import { VM } from './vm.js';

function run(input) {
  const bc = compileWithPrelude(input);
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem();
}

describe('callClosureSync: map', () => {
  it('basic map', () => {
    const r = run('map([1, 2, 3], fn(x) { x * 2; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [2, 4, 6]);
  });

  it('map with closure over outer variable', () => {
    const r = run('let factor = 10; map([1, 2, 3], fn(x) { x * factor; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [10, 20, 30]);
  });

  it('map with string operations', () => {
    const r = run('map(["a", "b", "c"], fn(s) { s + "!"; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), ['a!', 'b!', 'c!']);
  });

  it('empty array', () => {
    const r = run('map([], fn(x) { x; })');
    assert.deepStrictEqual(r.elements, []);
  });

  it('single element', () => {
    const r = run('map([42], fn(x) { x + 1; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [43]);
  });

  it('callback calls other functions', () => {
    const r = run(`
      let double = fn(x) { x * 2; };
      map([1, 2, 3], fn(x) { double(x) + 1; });
    `);
    assert.deepStrictEqual(r.elements.map(e => e.value), [3, 5, 7]);
  });

  it('nested map', () => {
    const r = run(`
      map([1, 2, 3], fn(x) {
        let inner = map([10, 20], fn(y) { x + y; });
        first(inner);
      });
    `);
    assert.deepStrictEqual(r.elements.map(e => e.value), [11, 12, 13]);
  });
});

describe('callClosureSync: filter', () => {
  it('basic filter', () => {
    const r = run('filter([1, 2, 3, 4, 5], fn(x) { x > 3; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [4, 5]);
  });

  it('all match', () => {
    const r = run('filter([1, 2, 3], fn(x) { x > 0; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 3]);
  });

  it('none match', () => {
    const r = run('filter([1, 2, 3], fn(x) { x > 10; })');
    assert.deepStrictEqual(r.elements, []);
  });

  it('filter with closure', () => {
    const r = run('let threshold = 3; filter([1, 2, 3, 4, 5], fn(x) { x >= threshold; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [3, 4, 5]);
  });
});

describe('callClosureSync: reduce', () => {
  it('sum', () => {
    const r = run('reduce([1, 2, 3, 4, 5], 0, fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 15);
  });

  it('string concat', () => {
    const r = run('reduce(["a", "b", "c"], "", fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 'abc');
  });

  it('product', () => {
    const r = run('reduce([1, 2, 3, 4], 1, fn(acc, x) { acc * x; })');
    assert.strictEqual(r.value, 24);
  });

  it('empty array returns init', () => {
    const r = run('reduce([], 42, fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 42);
  });

  it('build array', () => {
    const r = run('reduce([1, 2, 3], [], fn(acc, x) { push(acc, x * 2); })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [2, 4, 6]);
  });
});

describe('callClosureSync: forEach', () => {
  it('basic each', () => {
    // each should return null, but execute side effects
    const r = run(`
      let total = 0;
      each([1, 2, 3], fn(x) { puts(x); });
    `);
    // each returns null
  });
});

describe('callClosureSync: chained HOFs', () => {
  it('map then filter', () => {
    const r = run('filter(map([1, 2, 3, 4, 5], fn(x) { x * 2; }), fn(x) { x > 5; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [6, 8, 10]);
  });

  it('filter then reduce', () => {
    const r = run('reduce(filter([1, 2, 3, 4, 5], fn(x) { x > 2; }), 0, fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 12);
  });

  it('map-filter-reduce pipeline', () => {
    const r = run(`
      let data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let doubled = map(data, fn(x) { x * 2; });
      let evens = filter(doubled, fn(x) { x > 10; });
      reduce(evens, 0, fn(acc, x) { acc + x; });
    `);
    assert.strictEqual(r.value, 12 + 14 + 16 + 18 + 20);
  });
});

describe('callClosureSync: recursion in callback', () => {
  it('callback calls itself recursively', () => {
    const r = run(`
      let fib = fn(n) {
        if (n < 2) { n; }
        else { fib(n - 1) + fib(n - 2); };
      };
      map([0, 1, 2, 3, 4, 5, 6], fn(x) { fib(x); });
    `);
    assert.deepStrictEqual(r.elements.map(e => e.value), [0, 1, 1, 2, 3, 5, 8]);
  });
});
