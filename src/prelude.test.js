// prelude.test.js — Tests for monkey-lang standard library prelude
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileWithPrelude, PRELUDE_FUNCTIONS } from './prelude.js';
import { VM } from './vm.js';

function run(input) {
  const bc = compileWithPrelude(input);
  const vm = new VM(bc);
  vm.run();
  return vm.lastPoppedStackElem();
}

describe('prelude: map', () => {
  it('doubles each element', () => {
    const r = run('map([1, 2, 3], fn(x) { x * 2; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [2, 4, 6]);
  });
  it('handles empty array', () => {
    const r = run('map([], fn(x) { x; })');
    assert.deepStrictEqual(r.elements, []);
  });
  it('converts types', () => {
    const r = run('map([1, 2, 3], fn(x) { str(x); })');
    assert.deepStrictEqual(r.elements.map(e => e.value), ['1', '2', '3']);
  });
});

describe('prelude: filter', () => {
  it('keeps elements matching predicate', () => {
    const r = run('filter([1, 2, 3, 4, 5], fn(x) { x > 3; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [4, 5]);
  });
  it('empty result', () => {
    const r = run('filter([1, 2, 3], fn(x) { x > 10; })');
    assert.deepStrictEqual(r.elements, []);
  });
  it('all match', () => {
    const r = run('filter([1, 2, 3], fn(x) { x > 0; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 3]);
  });
});

describe('prelude: reduce', () => {
  it('sums array', () => {
    const r = run('reduce([1, 2, 3, 4, 5], 0, fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 15);
  });
  it('concatenates strings', () => {
    const r = run('reduce(["a", "b", "c"], "", fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 'abc');
  });
  it('computes product', () => {
    const r = run('reduce([1, 2, 3, 4], 1, fn(acc, x) { acc * x; })');
    assert.strictEqual(r.value, 24);
  });
});

describe('prelude: any', () => {
  it('true when at least one matches', () => {
    const r = run('any([1, 2, 3], fn(x) { x > 2; })');
    assert.strictEqual(r.value, true);
  });
  it('false when none match', () => {
    const r = run('any([1, 2, 3], fn(x) { x > 10; })');
    assert.strictEqual(r.value, false);
  });
});

describe('prelude: all', () => {
  it('true when all match', () => {
    const r = run('all([1, 2, 3], fn(x) { x > 0; })');
    assert.strictEqual(r.value, true);
  });
  it('false when one fails', () => {
    const r = run('all([1, 2, 3], fn(x) { x > 1; })');
    assert.strictEqual(r.value, false);
  });
});

describe('prelude: find', () => {
  it('finds first matching element', () => {
    const r = run('find([1, 2, 3, 4], fn(x) { x > 2; })');
    assert.strictEqual(r.value, 3);
  });
  it('returns null when not found', () => {
    const r = run('find([1, 2, 3], fn(x) { x > 10; })');
    // VM returns NULL singleton
    assert.ok(r.value === null || r.inspect?.() === 'null' || r === null);
  });
});

describe('prelude: take', () => {
  it('takes first N elements', () => {
    const r = run('take([1, 2, 3, 4, 5], 3)');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 3]);
  });
  it('takes fewer than N if array shorter', () => {
    const r = run('take([1, 2], 5)');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2]);
  });
});

describe('prelude: drop', () => {
  it('drops first N elements', () => {
    const r = run('drop([1, 2, 3, 4, 5], 2)');
    assert.deepStrictEqual(r.elements.map(e => e.value), [3, 4, 5]);
  });
  it('drops all', () => {
    const r = run('drop([1, 2], 5)');
    assert.deepStrictEqual(r.elements, []);
  });
});

describe('prelude: composition', () => {
  it('map + filter', () => {
    const r = run('filter(map([1, 2, 3, 4, 5], fn(x) { x * 2; }), fn(x) { x > 6; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [8, 10]);
  });
  it('reduce(filter(map(...)))', () => {
    const r = run('reduce(filter(map([1,2,3,4,5], fn(x) { x * 2; }), fn(x) { x > 4; }), 0, fn(acc, x) { acc + x; })');
    assert.strictEqual(r.value, 24); // 6+8+10
  });
});

describe('prelude: take_while', () => {
  it('takes while predicate holds', () => {
    const r = run('take_while([1,2,3,4,5], fn(x) { x < 4; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 3]);
  });
  it('empty when first element fails', () => {
    const r = run('take_while([5,1,2], fn(x) { x < 3; })');
    assert.deepStrictEqual(r.elements, []);
  });
  it('all when all match', () => {
    const r = run('take_while([1,2,3], fn(x) { x < 10; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 3]);
  });
});

describe('prelude: scan', () => {
  it('running sum', () => {
    const r = run('scan([1,2,3,4,5], 0, fn(acc, x) { acc + x; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 3, 6, 10, 15]);
  });
  it('empty array', () => {
    const r = run('scan([], 0, fn(acc, x) { acc + x; })');
    assert.deepStrictEqual(r.elements, []);
  });
  it('running product', () => {
    const r = run('scan([1,2,3,4], 1, fn(acc, x) { acc * x; })');
    assert.deepStrictEqual(r.elements.map(e => e.value), [1, 2, 6, 24]);
  });
});

describe('prelude: chunk', () => {
  it('chunks array into pieces', () => {
    const r = run('chunk([1,2,3,4,5,6,7], 3)');
    assert.strictEqual(r.elements.length, 3); // [1,2,3], [4,5,6], [7]
    assert.deepStrictEqual(r.elements[0].elements.map(e => e.value), [1, 2, 3]);
    assert.deepStrictEqual(r.elements[2].elements.map(e => e.value), [7]);
  });
  it('exact division', () => {
    const r = run('chunk([1,2,3,4,5,6], 2)');
    assert.strictEqual(r.elements.length, 3);
  });
  it('empty array', () => {
    const r = run('chunk([], 3)');
    assert.deepStrictEqual(r.elements, []);
  });
});
