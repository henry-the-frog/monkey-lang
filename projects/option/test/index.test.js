import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { some, none, fromNullable } from '../src/index.js';

describe('Some', () => {
  it('isSome', () => assert.equal(some(1).isSome, true));
  it('unwrap', () => assert.equal(some(42).unwrap(), 42));
  it('map', () => assert.equal(some(2).map(x => x * 3).unwrap(), 6));
  it('flatMap', () => assert.equal(some(2).flatMap(x => some(x + 1)).unwrap(), 3));
  it('filter pass', () => assert.equal(some(5).filter(x => x > 3).isSome, true));
  it('filter fail', () => assert.equal(some(1).filter(x => x > 3).isNone, true));
  it('and', () => assert.equal(some(1).and(some(2)).unwrap(), 2));
  it('zip', () => assert.deepEqual(some(1).zip(some(2)).unwrap(), [1, 2]));
  it('match some', () => assert.equal(some(5).match({ some: v => v + 1, none: () => 0 }), 6));
});

describe('None', () => {
  it('isNone', () => assert.equal(none().isNone, true));
  it('unwrap throws', () => assert.throws(() => none().unwrap()));
  it('map is no-op', () => assert.equal(none().map(x => x * 2).isNone, true));
  it('unwrapOr', () => assert.equal(none().unwrapOr(42), 42));
  it('or', () => assert.equal(none().or(some(1)).unwrap(), 1));
  it('zip', () => assert.equal(some(1).zip(none()).isNone, true));
  it('match none', () => assert.equal(none().match({ some: () => 1, none: () => 0 }), 0));
});

describe('fromNullable', () => {
  it('value → Some', () => assert.equal(fromNullable(42).unwrap(), 42));
  it('null → None', () => assert.equal(fromNullable(null).isNone, true));
  it('undefined → None', () => assert.equal(fromNullable(undefined).isNone, true));
  it('0 → Some', () => assert.equal(fromNullable(0).isSome, true));
  it('empty string → Some', () => assert.equal(fromNullable('').isSome, true));
});
