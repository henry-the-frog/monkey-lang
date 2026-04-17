import { describe, it } from 'node:test'; import assert from 'node:assert/strict';
import { escapeHTML, unescapeHTML, escapeRegex, escapeShell, escapeJSON, escapeCSV } from '../src/index.js';
describe('HTML', () => {
  it('escapes', () => assert.equal(escapeHTML('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  it('unescapes', () => assert.equal(unescapeHTML('&lt;b&gt;'), '<b>'));
  it('roundtrip', () => assert.equal(unescapeHTML(escapeHTML('<a>')), '<a>'));
});
describe('regex', () => { it('escapes', () => assert.equal(escapeRegex('a.b+c'), 'a\\.b\\+c')); });
describe('shell', () => { it('escapes', () => { const result = escapeShell("hello 'world'"); assert.ok(result.includes('hello') && result.includes('world')); }); });
describe('JSON', () => { it('escapes', () => assert.equal(escapeJSON('hello\n"world"'), 'hello\\n\\"world\\"')); });
describe('CSV', () => { it('quotes', () => assert.equal(escapeCSV('a,b'), '"a,b"')); it('no quotes', () => assert.equal(escapeCSV('abc'), 'abc')); });
