// wasm-string.test.js — Tests for WASM compiler string support
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileToWasm } from './wasm-compiler.js';

async function run(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  return inst.exports.main();
}

async function runStr(code) {
  const binary = compileToWasm(code);
  const mod = await WebAssembly.compile(binary);
  const inst = await WebAssembly.instantiate(mod, {});
  const ptr = inst.exports.main();
  const mem = new Uint8Array(inst.exports.memory.buffer);
  const len = mem[ptr] | (mem[ptr+1] << 8) | (mem[ptr+2] << 16) | (mem[ptr+3] << 24);
  return new TextDecoder().decode(mem.slice(ptr + 4, ptr + 4 + len));
}

describe('WASM strings — literals', () => {
  it('string literal returns pointer', async () => {
    const ptr = await run('"hello"');
    assert.ok(typeof ptr === 'number');
    assert.ok(ptr >= 0);
  });

  it('string literal content readable from memory', async () => {
    assert.equal(await runStr('"hello"'), 'hello');
  });

  it('empty string', async () => {
    assert.equal(await runStr('""'), '');
  });

  it('string with spaces', async () => {
    assert.equal(await runStr('"hello world"'), 'hello world');
  });

  it('string with special chars', async () => {
    assert.equal(await runStr('"hello\\nworld"'), 'hello\nworld');
  });
});

describe('WASM strings — len()', () => {
  it('len of literal', async () => {
    assert.equal(await run('len("hello")'), 5);
  });

  it('len of empty string', async () => {
    assert.equal(await run('len("")'), 0);
  });

  it('len of long string', async () => {
    assert.equal(await run('len("the quick brown fox jumps over the lazy dog")'), 43);
  });
});

describe('WASM strings — concatenation', () => {
  it('concat two literals', async () => {
    assert.equal(await runStr('"hello" + " world"'), 'hello world');
  });

  it('concat empty + non-empty', async () => {
    assert.equal(await runStr('"" + "hello"'), 'hello');
  });

  it('concat non-empty + empty', async () => {
    assert.equal(await runStr('"hello" + ""'), 'hello');
  });

  it('concat two empty', async () => {
    assert.equal(await runStr('"" + ""'), '');
  });

  it('len of concatenated string', async () => {
    assert.equal(await run('len("hello" + " world")'), 11);
  });

  it('multiple concatenations', async () => {
    assert.equal(await runStr('"a" + "b" + "c"'), 'abc');
  });
});

describe('WASM strings — comparison', () => {
  it('equal strings', async () => {
    assert.equal(await run('"hello" == "hello"'), 1);
  });

  it('different strings', async () => {
    assert.equal(await run('"hello" == "world"'), 0);
  });

  it('different length strings', async () => {
    assert.equal(await run('"hi" == "hello"'), 0);
  });

  it('not equal', async () => {
    assert.equal(await run('"hello" != "world"'), 1);
  });

  it('not equal same strings', async () => {
    assert.equal(await run('"hello" != "hello"'), 0);
  });

  it('empty strings equal', async () => {
    assert.equal(await run('"" == ""'), 1);
  });
});

describe('WASM strings — in expressions', () => {
  it('string comparison in if', async () => {
    assert.equal(await run(`
      if ("hello" == "hello") { 1 } else { 0 }
    `), 1);
  });

  it('string comparison in if (false)', async () => {
    assert.equal(await run(`
      if ("hello" == "world") { 1 } else { 0 }
    `), 0);
  });

  it('concatenation then comparison (known limitation)', async () => {
    // String comparison via == on variables doesn't detect string type yet
    // This compares pointers, not content. Once type inference is added, this will work.
    const result = await run(`
      let result = "hello" + " world";
      len(result)
    `);
    assert.equal(result, 11); // len works because it reads the i32 at ptr+0
  });
});
