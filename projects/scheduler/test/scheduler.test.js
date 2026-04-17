import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/index.js';

describe('Scheduler', () => {
  it('runs tasks', async () => {
    const s = new Scheduler();
    s.schedule(() => 'a');
    s.schedule(() => 'b');
    const r = await s.run();
    assert.equal(r.length, 2);
    assert.equal(r[0].result, 'a');
  });

  it('priority ordering', async () => {
    const s = new Scheduler();
    s.schedule(() => 'low', { priority: 10 });
    s.schedule(() => 'high', { priority: 1 });
    const r = await s.run();
    assert.equal(r[0].result, 'high');
  });

  it('cancel', async () => {
    const s = new Scheduler();
    const id = s.schedule(() => 'nope');
    s.cancel(id);
    assert.equal(s.pending, 0);
  });

  it('handles errors', async () => {
    const s = new Scheduler();
    s.schedule(() => { throw new Error('boom'); });
    const r = await s.run();
    assert.equal(r[0].status, 'failed');
    assert.equal(r[0].error, 'boom');
  });

  it('runNext', async () => {
    const s = new Scheduler();
    s.schedule(() => 42);
    const r = await s.runNext();
    assert.equal(r.result, 42);
    assert.equal(s.pending, 0);
  });
});
