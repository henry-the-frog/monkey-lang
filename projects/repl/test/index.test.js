import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPL, History } from '../src/index.js';

describe('History', () => {
  it('adds entries', () => {
    const h = new History();
    h.add('cmd1'); h.add('cmd2');
    assert.equal(h.size, 2);
  });

  it('navigates up/down', () => {
    const h = new History();
    h.add('a'); h.add('b'); h.add('c');
    assert.equal(h.up(), 'c');
    assert.equal(h.up(), 'b');
    assert.equal(h.up(), 'a');
    assert.equal(h.down(), 'b');
  });

  it('down from end returns null', () => {
    const h = new History();
    h.add('x');
    assert.equal(h.down(), null);
  });

  it('deduplicates consecutive', () => {
    const h = new History();
    h.add('x'); h.add('x'); h.add('x');
    assert.equal(h.size, 1);
  });

  it('max size', () => {
    const h = new History(3);
    h.add('a'); h.add('b'); h.add('c'); h.add('d');
    assert.equal(h.size, 3);
    assert.deepEqual(h.entries(), ['b', 'c', 'd']);
  });

  it('search', () => {
    const h = new History();
    h.add('git commit'); h.add('git push'); h.add('npm test');
    assert.deepEqual(h.search('git'), ['git commit', 'git push']);
  });
});

describe('REPL — evaluation', () => {
  it('evaluates with default echo', () => {
    const repl = new REPL();
    assert.equal(repl.processInput('hello'), 'hello');
  });

  it('evaluates with custom evaluator', () => {
    const repl = new REPL({ evaluator: (x) => eval(x) });
    assert.equal(repl.processInput('2 + 3'), 5);
  });

  it('catches errors', () => {
    const repl = new REPL({ evaluator: () => { throw new Error('oops'); } });
    const result = repl.processInput('bad');
    assert.ok(result.includes('Error'));
  });

  it('ignores empty input', () => {
    const repl = new REPL();
    assert.equal(repl.processInput('  '), null);
  });

  it('tracks output', () => {
    const repl = new REPL();
    repl.processInput('hello');
    repl.processInput('world');
    assert.equal(repl.output.length, 2);
  });
});

describe('REPL — commands', () => {
  it('/help lists commands', () => {
    const repl = new REPL();
    const result = repl.processInput('/help');
    assert.ok(result.includes('help'));
    assert.ok(result.includes('history'));
  });

  it('/history shows history', () => {
    const repl = new REPL();
    repl.processInput('first');
    repl.processInput('second');
    const result = repl.processInput('/history');
    assert.ok(result.includes('first'));
  });

  it('custom command', () => {
    const repl = new REPL();
    repl.registerCommand('greet', (args) => `Hello ${args[0]}`);
    assert.equal(repl.processInput('/greet World'), 'Hello World');
  });

  it('unknown command', () => {
    const repl = new REPL();
    const result = repl.processInput('/nope');
    assert.ok(result.includes('Unknown'));
  });
});

describe('REPL — tab completion', () => {
  it('completes single match', () => {
    const repl = new REPL({ completions: ['console', 'const', 'continue'] });
    const result = repl.complete('consol');
    assert.equal(result.text, 'console');
    assert.equal(result.isComplete, true);
  });

  it('common prefix for multiple', () => {
    const repl = new REPL({ completions: ['console', 'const', 'continue'] });
    const result = repl.complete('con');
    assert.equal(result.text, 'con');
    assert.equal(result.matches.length, 3);
  });

  it('no matches', () => {
    const repl = new REPL({ completions: ['foo', 'bar'] });
    const result = repl.complete('xyz');
    assert.equal(result.matches.length, 0);
  });
});
