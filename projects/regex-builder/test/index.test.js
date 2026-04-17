import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { regex } from '../src/index.js';

describe('RegexBuilder — basic', () => {
  it('literal', () => {
    const re = regex().literal('hello').build();
    assert.ok(re.test('hello'));
    assert.ok(!re.test('world'));
  });

  it('escapes special chars', () => {
    const re = regex().literal('a.b').build();
    assert.ok(re.test('a.b'));
    assert.ok(!re.test('axb'));
  });

  it('digits', () => {
    const re = regex().startOfLine().digits().endOfLine().build();
    assert.ok(re.test('12345'));
    assert.ok(!re.test('abc'));
  });

  it('words', () => {
    const re = regex().words().build();
    assert.ok(re.test('hello_world'));
  });
});

describe('RegexBuilder — quantifiers', () => {
  it('optional', () => {
    const re = regex().literal('colo').literal('u').optional().literal('r').build();
    assert.ok(re.test('color'));
    assert.ok(re.test('colour'));
  });

  it('repeat exact', () => {
    const re = regex().startOfLine().digit().repeat(3).endOfLine().build();
    assert.ok(re.test('123'));
    assert.ok(!re.test('1234'));
  });

  it('repeat range', () => {
    const re = regex().startOfLine().digit().repeatRange(2, 4).endOfLine().build();
    assert.ok(re.test('12'));
    assert.ok(re.test('1234'));
    assert.ok(!re.test('1'));
  });
});

describe('RegexBuilder — groups', () => {
  it('capturing group', () => {
    const re = regex().group(g => g.digits()).build();
    const match = '42'.match(re);
    assert.equal(match[1], '42');
  });

  it('named group', () => {
    const re = regex().namedGroup('num', g => g.digits()).build();
    const match = 'abc 42 def'.match(re);
    assert.equal(match.groups.num, '42');
  });
});

describe('RegexBuilder — alternation', () => {
  it('or', () => {
    const re = regex().or(a => a.literal('cat'), b => b.literal('dog')).build();
    assert.ok(re.test('cat'));
    assert.ok(re.test('dog'));
    assert.ok(!re.test('fish'));
  });
});

describe('RegexBuilder — anchors', () => {
  it('start and end', () => {
    const re = regex().startOfLine().literal('exact').endOfLine().build();
    assert.ok(re.test('exact'));
    assert.ok(!re.test('not exact'));
  });
});

describe('RegexBuilder — flags', () => {
  it('case insensitive', () => {
    const re = regex().literal('hello').caseInsensitive().build();
    assert.ok(re.test('HELLO'));
  });

  it('global', () => {
    const re = regex().digits().global().build();
    const matches = 'a1b2c3'.match(re);
    assert.equal(matches.length, 3);
  });
});

describe('RegexBuilder — real-world patterns', () => {
  it('email-like', () => {
    const re = regex().words().literal('@').words().literal('.').words().build();
    assert.ok(re.test('user@example.com'));
  });

  it('phone number', () => {
    const re = regex().startOfLine().digit().repeat(3).literal('-').digit().repeat(3).literal('-').digit().repeat(4).endOfLine().build();
    assert.ok(re.test('123-456-7890'));
    assert.ok(!re.test('12-34-5678'));
  });
});
