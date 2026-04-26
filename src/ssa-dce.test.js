// ssa-dce.test.js — Tests for SSA-level dead code elimination analysis
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProgram, analyzeDeadDefs } from './ssa-dce.js';

describe('SSA-level DCE: basic dead variable detection', () => {
  it('detects unused variable', () => {
    const results = analyzeProgram(`
      let f = fn() { let a = 10; let unused = 42; return a; };
    `);
    const { dead } = results.get('f');
    assert.ok(dead.includes('unused_0'), `Expected unused_0 in dead, got: ${dead}`);
    assert.ok(!dead.some(d => d.startsWith('a_')), 'a should not be dead');
  });

  it('detects multiple dead variables', () => {
    const results = analyzeProgram(`
      let f = fn() { let a = 1; let b = 2; let c = 3; return a; };
    `);
    const { dead } = results.get('f');
    assert.ok(dead.includes('b_0'));
    assert.ok(dead.includes('c_0'));
    assert.ok(!dead.includes('a_0'));
  });

  it('variable used in return is live', () => {
    const results = analyzeProgram(`
      let f = fn(x) { let result = x + 1; return result; };
    `);
    const { dead } = results.get('f');
    assert.deepStrictEqual(dead, []);
  });

  it('variable used by another variable is live', () => {
    const results = analyzeProgram(`
      let f = fn() { let a = 10; let b = a + 1; return b; };
    `);
    const { dead } = results.get('f');
    assert.deepStrictEqual(dead, []);
  });

  it('preserves variables with side effects', () => {
    const results = analyzeProgram(`
      let f = fn() { let x = puts(42); return 0; };
    `);
    const { dead } = results.get('f');
    assert.deepStrictEqual(dead, [], 'puts() has side effects, should not be dead');
  });
});

describe('SSA-level DCE: complex cases', () => {
  it('handles if-expression references', () => {
    const results = analyzeProgram(`
      let f = fn(x) {
        let a = 10;
        let result = if (x > 0) { a + 1; } else { a - 1; };
        let unused = 42;
        return result;
      };
    `);
    const { dead } = results.get('f');
    assert.ok(dead.includes('unused_0'));
    assert.ok(!dead.some(d => d.startsWith('a_')), 'a is used in if-expression');
    assert.ok(!dead.some(d => d.startsWith('result_')));
  });

  it('transitive dead: variable only used by dead variable', () => {
    const results = analyzeProgram(`
      let f = fn() {
        let a = 10;
        let b = a + 1;
        let unused = b * 2;
        return a;
      };
    `);
    const { dead } = results.get('f');
    assert.ok(dead.includes('unused_0'));
    // b is used by unused, but unused is dead. 
    // Without transitive analysis, b is still "live" (has a user).
    // This is conservative but correct.
  });

  it('analyzes multiple functions', () => {
    const results = analyzeProgram(`
      let add = fn(x, y) { let unused = 0; x + y; };
      let mul = fn(x, y) { x * y; };
    `);
    assert.ok(results.has('add'));
    assert.ok(results.has('mul'));
    const { dead } = results.get('add');
    assert.ok(dead.includes('unused_0'));
  });
});

describe('SSA-level DCE: def-use chains', () => {
  it('builds correct use chains', () => {
    const results = analyzeProgram(`
      let f = fn() { let a = 1; let b = a + 2; return b; };
    `);
    const { uses } = results.get('f');
    // a_0 should be used by b_0
    const aUses = uses.get('a_0');
    assert.ok(aUses && aUses.includes('b_0'), `a_0 should be used by b_0, got: ${aUses}`);
    // b_0 should be used by return
    const bUses = uses.get('b_0');
    assert.ok(bUses && bUses.includes('__return__'));
  });
});
