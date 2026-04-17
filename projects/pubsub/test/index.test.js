import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/index.js';

describe('Broker — basic pub/sub', () => {
  it('publish and subscribe', () => {
    const b = new Broker();
    let received = null;
    b.subscribe('events', (data) => { received = data; });
    b.publish('events', { type: 'test' });
    assert.deepEqual(received, { type: 'test' });
  });

  it('multiple subscribers', () => {
    const b = new Broker();
    const log = [];
    b.subscribe('x', (data) => log.push('A:' + data));
    b.subscribe('x', (data) => log.push('B:' + data));
    b.publish('x', 'hello');
    assert.deepEqual(log, ['A:hello', 'B:hello']);
  });

  it('no cross-talk between topics', () => {
    const b = new Broker();
    let called = false;
    b.subscribe('a', () => { called = true; });
    b.publish('b', 'data');
    assert.equal(called, false);
  });

  it('unsubscribe', () => {
    const b = new Broker();
    let count = 0;
    const id = b.subscribe('x', () => count++);
    b.publish('x', 1);
    b.unsubscribe(id);
    b.publish('x', 2);
    assert.equal(count, 1);
  });
});

describe('Broker — message metadata', () => {
  it('handler receives data and topic', () => {
    const b = new Broker();
    let receivedTopic;
    b.subscribe('x', (data, topic) => { receivedTopic = topic; });
    b.publish('x', 'hi');
    assert.equal(receivedTopic, 'x');
  });

  it('publish returns delivery count', () => {
    const b = new Broker();
    b.subscribe('x', () => {});
    b.subscribe('x', () => {});
    assert.equal(b.publish('x', 'hi'), 2);
  });
});

describe('Broker — consumer groups', () => {
  it('delivers to one per group', () => {
    const b = new Broker();
    const log = [];
    b.subscribe('x', (d) => log.push('A'), { group: 'workers' });
    b.subscribe('x', (d) => log.push('B'), { group: 'workers' });
    b.publish('x', 1);
    assert.equal(log.length, 1); // only one got it
  });

  it('different groups both receive', () => {
    const b = new Broker();
    const log = [];
    b.subscribe('x', (d) => log.push('G1'), { group: 'g1' });
    b.subscribe('x', (d) => log.push('G2'), { group: 'g2' });
    b.publish('x', 1);
    assert.deepEqual(log.sort(), ['G1', 'G2']);
  });
});

describe('Broker — filters', () => {
  it('filters messages', () => {
    const b = new Broker();
    const log = [];
    b.subscribe('events', (d) => log.push(d), {
      filter: (msg) => msg.data.priority === 'high',
    });
    b.publish('events', { priority: 'low', text: 'a' });
    b.publish('events', { priority: 'high', text: 'b' });
    assert.equal(log.length, 1);
    assert.equal(log[0].text, 'b');
  });
});

describe('Broker — error handling', () => {
  it('catches handler errors in dead letter', () => {
    const b = new Broker();
    b.subscribe('x', () => { throw new Error('fail'); });
    b.publish('x', 'data');
    assert.equal(b.deadLetter.length, 1);
  });

  it('dead letter handler fires for undelivered', () => {
    const b = new Broker();
    const dead = [];
    b.onDeadLetter((msg, topic) => dead.push(topic));
    b.publish('nobody', 'lost');
    assert.equal(dead.length, 1);
  });
});

describe('Broker — stats', () => {
  it('tracks topic stats', () => {
    const b = new Broker();
    b.subscribe('x', () => {});
    b.publish('x', 1); b.publish('x', 2);
    const stats = b.stats('x');
    assert.equal(stats.messages, 2);
    assert.equal(stats.subscribers, 1);
  });

  it('getTopics', () => {
    const b = new Broker();
    b.createTopic('a'); b.createTopic('b');
    assert.deepEqual(b.getTopics().sort(), ['a', 'b']);
  });
});

describe('Broker — wildcard topics', () => {
  it('matches wildcard pattern', () => {
    const b = new Broker();
    const log = [];
    b.subscribe('user.*', (d, topic) => log.push(topic));
    b.publish('user.login', {});
    b.publish('user.logout', {});
    b.publish('system.start', {});
    assert.deepEqual(log, ['user.login', 'user.logout']);
  });
});
