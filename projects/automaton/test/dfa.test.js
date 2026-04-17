import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DFA } from '../src/index.js';

describe('DFA', () => {
  function evenZeros() {
    // Accepts strings with even number of 0s
    const dfa = new DFA();
    dfa.addState('even', { start: true, accept: true });
    dfa.addState('odd');
    dfa.addTransition('even', '0', 'odd');
    dfa.addTransition('even', '1', 'even');
    dfa.addTransition('odd', '0', 'even');
    dfa.addTransition('odd', '1', 'odd');
    return dfa;
  }

  it('accepts valid input', () => { assert.equal(evenZeros().run('1001'), true); });
  it('rejects invalid input', () => { assert.equal(evenZeros().run('0'), false); });
  it('empty string accepted (even zeros)', () => { assert.equal(evenZeros().run(''), true); });
  it('all ones accepted', () => { assert.equal(evenZeros().run('111'), true); });
  it('trace', () => {
    const t = evenZeros().trace('01');
    assert.deepEqual(t.path, ['even', 'odd', 'odd']);
    assert.equal(t.accepted, false);
  });
});

describe('Binary divisibility', () => {
  it('divisible by 3', () => {
    // DFA for binary numbers divisible by 3
    const dfa = new DFA();
    dfa.addState('r0', { start: true, accept: true }); // remainder 0
    dfa.addState('r1'); // remainder 1
    dfa.addState('r2'); // remainder 2
    dfa.addTransition('r0', '0', 'r0');
    dfa.addTransition('r0', '1', 'r1');
    dfa.addTransition('r1', '0', 'r2');
    dfa.addTransition('r1', '1', 'r0');
    dfa.addTransition('r2', '0', 'r1');
    dfa.addTransition('r2', '1', 'r2');

    assert.equal(dfa.run('0'), true);   // 0 % 3 = 0
    assert.equal(dfa.run('11'), true);  // 3 % 3 = 0
    assert.equal(dfa.run('110'), true); // 6 % 3 = 0
    assert.equal(dfa.run('10'), false); // 2 % 3 ≠ 0
    assert.equal(dfa.run('101'), false); // 5 % 3 ≠ 0
  });
});

describe('minimize', () => {
  it('reduces equivalent states', () => {
    // DFA with redundant states
    const dfa = new DFA();
    dfa.addState('A', { start: true });
    dfa.addState('B', { accept: true });
    dfa.addState('C', { accept: true }); // Equivalent to B
    dfa.addTransition('A', '0', 'B');
    dfa.addTransition('A', '1', 'C');
    dfa.addTransition('B', '0', 'B');
    dfa.addTransition('B', '1', 'B');
    dfa.addTransition('C', '0', 'C');
    dfa.addTransition('C', '1', 'C');

    const min = dfa.minimize();
    assert.ok(min.stateCount <= dfa.stateCount);
    // Should still accept same strings
    assert.equal(min.run('0'), true);
    assert.equal(min.run('1'), true);
  });
});
