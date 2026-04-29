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

describe('WASM strings — through variables (type inference)', () => {
  it('concat via string variables', async () => {
    assert.equal(await runStr(`
      let a = "hello";
      let b = " world";
      a + b
    `), 'hello world');
  });

  it('len of variable concat', async () => {
    assert.equal(await run(`
      let a = "hello";
      let b = " world";
      let c = a + b;
      len(c)
    `), 11);
  });

  it('equality of string variables', async () => {
    assert.equal(await run(`
      let a = "hello";
      let b = "hello";
      a == b
    `), 1);
  });

  it('inequality of different string variables', async () => {
    assert.equal(await run(`
      let a = "hello";
      let b = "world";
      a == b
    `), 0);
  });

  it('concat result compared to literal', async () => {
    assert.equal(await run(`
      let a = "hello";
      let b = " world";
      let c = a + b;
      c == "hello world"
    `), 1);
  });

  it('string != through variables', async () => {
    assert.equal(await run(`
      let a = "hello";
      let b = "world";
      a != b
    `), 1);
  });

  it('multiple concat chain through variables', async () => {
    assert.equal(await runStr(`
      let a = "hello";
      let b = " ";
      let c = "world";
      a + b + c
    `), 'hello world');
  });

  it('string variable in if condition', async () => {
    assert.equal(await run(`
      let greeting = "hello";
      if (greeting == "hello") { 42 } else { 0 }
    `), 42);
  });

  it('string assigned from concat', async () => {
    assert.equal(await run(`
      let greeting = "hi" + " there";
      len(greeting)
    `), 8);
  });

  it('string in function parameter', async () => {
    assert.equal(await run(`
      let check = fn(s) {
        s == "hello"
      };
      check("hello")
    `), 1);
  });
});

describe('WASM strings — function parameter type inference', () => {
  it('string concat through function', async () => {
    assert.equal(await runStr(`
      let a = "hello";
      let b = " world";
      let concat = fn(x, y) { x + y };
      concat(a, b)
    `), 'hello world');
  });

  it('string comparison through function', async () => {
    assert.equal(await run(`
      let check = fn(s, target) { s == target };
      let a = "hello";
      let b = "hello";
      check(a, b)
    `), 1);
  });

  it('string function returning concat result', async () => {
    assert.equal(await run(`
      let greet = fn(name) { "Hello, " + name };
      let result = greet("world");
      len(result)
    `), 12);
  });

  it('string function with comparison in if', async () => {
    assert.equal(await run(`
      let isHello = fn(s) {
        if (s == "hello") { 1 } else { 0 }
      };
      let word = "hello";
      isHello(word)
    `), 1);
  });

  it('multiple string function calls', async () => {
    assert.equal(await run(`
      let add_prefix = fn(prefix, s) { prefix + s };
      let a = add_prefix("hello", " world");
      let b = add_prefix("foo", "bar");
      len(a) + len(b)
    `), 11 + 6);
  });
});

describe('WASM strings — charAt', () => {
  it('first character', async () => {
    assert.equal(await runStr('charAt("hello", 0)'), 'h');
  });

  it('last character', async () => {
    assert.equal(await runStr('charAt("hello", 4)'), 'o');
  });

  it('middle character', async () => {
    assert.equal(await runStr('charAt("hello", 2)'), 'l');
  });

  it('charAt equals literal', async () => {
    assert.equal(await run('charAt("abc", 1) == "b"'), 1);
  });

  it('charAt on variable', async () => {
    assert.equal(await runStr(`
      let s = "world";
      charAt(s, 0)
    `), 'w');
  });

  it('charAt in loop', async () => {
    assert.equal(await run(`
      let s = "hello";
      let count = 0;
      let i = 0;
      while (i < len(s)) {
        if (charAt(s, i) == "l") {
          set count = count + 1
        };
        set i = i + 1
      };
      count
    `), 2);
  });
});

describe('WASM strings — substring', () => {
  it('first half', async () => {
    assert.equal(await runStr('substring("hello world", 0, 5)'), 'hello');
  });

  it('second half', async () => {
    assert.equal(await runStr('substring("hello world", 6, 11)'), 'world');
  });

  it('middle', async () => {
    assert.equal(await runStr('substring("abcdef", 2, 4)'), 'cd');
  });

  it('single char', async () => {
    assert.equal(await runStr('substring("hello", 0, 1)'), 'h');
  });

  it('full string', async () => {
    assert.equal(await runStr(`
      let s = "hello";
      substring(s, 0, len(s))
    `), 'hello');
  });

  it('empty substring', async () => {
    assert.equal(await run('len(substring("hello", 2, 2))'), 0);
  });

  it('substring equals literal', async () => {
    assert.equal(await run('substring("hello world", 0, 5) == "hello"'), 1);
  });

  it('substring of concat', async () => {
    assert.equal(await runStr(`
      let s = "hello" + " world";
      substring(s, 6, 11)
    `), 'world');
  });
});

describe('WASM strings — indexOf', () => {
  it('find word at beginning', async () => {
    assert.equal(await run('indexOf("hello world", "hello")'), 0);
  });

  it('find word in middle', async () => {
    assert.equal(await run('indexOf("hello world", "world")'), 6);
  });

  it('not found', async () => {
    assert.equal(await run('indexOf("hello world", "xyz")'), -1);
  });

  it('empty needle', async () => {
    assert.equal(await run('indexOf("hello", "")'), 0);
  });

  it('single char', async () => {
    assert.equal(await run('indexOf("hello", "l")'), 2);
  });

  it('needle longer than haystack', async () => {
    assert.equal(await run('indexOf("hi", "hello world")'), -1);
  });

  it('indexOf with variables', async () => {
    assert.equal(await run(`
      let s = "the quick brown fox";
      let target = "quick";
      indexOf(s, target)
    `), 4);
  });

  it('indexOf in conditional', async () => {
    assert.equal(await run(`
      let s = "hello world";
      if (indexOf(s, "world") >= 0) { 1 } else { 0 }
    `), 1);
  });
});

describe('WASM strings — toUpperCase/toLowerCase', () => {
  it('toUpperCase basic', async () => {
    assert.equal(await runStr('toUpperCase("hello")'), 'HELLO');
  });

  it('toLowerCase basic', async () => {
    assert.equal(await runStr('toLowerCase("HELLO")'), 'hello');
  });

  it('toUpperCase with non-alpha', async () => {
    assert.equal(await runStr('toUpperCase("hello world 123!")'), 'HELLO WORLD 123!');
  });

  it('toLowerCase with non-alpha', async () => {
    assert.equal(await runStr('toLowerCase("HELLO WORLD 123!")'), 'hello world 123!');
  });

  it('toUpperCase comparison', async () => {
    assert.equal(await run('toUpperCase("hello") == "HELLO"'), 1);
  });

  it('toLowerCase comparison', async () => {
    assert.equal(await run('toLowerCase("HELLO") == "hello"'), 1);
  });

  it('roundtrip: lower(upper(s))', async () => {
    assert.equal(await runStr('toLowerCase(toUpperCase("Hello World"))'), 'hello world');
  });

  it('toUpperCase empty string', async () => {
    assert.equal(await run('len(toUpperCase(""))'), 0);
  });

  it('toUpperCase on variable', async () => {
    assert.equal(await runStr(`
      let s = "hello";
      toUpperCase(s)
    `), 'HELLO');
  });

  it('case-insensitive comparison pattern', async () => {
    assert.equal(await run(`
      let a = "Hello";
      let b = "HELLO";
      toLowerCase(a) == toLowerCase(b)
    `), 1);
  });
});

describe('WASM strings — split', () => {
  it('split by space', async () => {
    assert.equal(await run(`
      let parts = split("hello world foo", " ");
      len(parts)
    `), 3);
  });

  it('split content verification', async () => {
    assert.equal(await run(`
      let parts = split("a,b,c", ",");
      parts[0] == "a"
    `), 1);
  });

  it('split all parts correct', async () => {
    assert.equal(await run(`
      let parts = split("hello,world,foo", ",");
      let ok1 = parts[0] == "hello";
      let ok2 = parts[1] == "world";
      let ok3 = parts[2] == "foo";
      ok1 + ok2 + ok3
    `), 3);
  });

  it('split with multi-char delimiter', async () => {
    assert.equal(await run(`
      let parts = split("one::two::three", "::");
      len(parts)
    `), 3);
  });

  it('split no delimiter found', async () => {
    assert.equal(await run(`
      let parts = split("hello", ",");
      len(parts)
    `), 1);
  });

  it('split iterate with for-in', async () => {
    assert.equal(await run(`
      let parts = split("1,2,3,4,5", ",");
      let count = 0;
      for (p in parts) {
        set count = count + 1
      };
      count
    `), 5);
  });

  it('split lengths sum', async () => {
    assert.equal(await run(`
      let parts = split("hello world", " ");
      len(parts[0]) + len(parts[1])
    `), 5 + 5);
  });
});

describe('WASM strings — replace', () => {
  it('replace basic', async () => {
    assert.equal(await runStr('replace("hello world", "world", "earth")'), 'hello earth');
  });

  it('replace at beginning', async () => {
    assert.equal(await runStr('replace("hello world", "hello", "hi")'), 'hi world');
  });

  it('replace not found', async () => {
    assert.equal(await runStr('replace("hello", "xyz", "abc")'), 'hello');
  });

  it('replace with empty', async () => {
    assert.equal(await runStr('replace("hello world", " world", "")'), 'hello');
  });

  it('replace first occurrence only', async () => {
    assert.equal(await runStr('replace("aaa", "a", "b")'), 'baa');
  });

  it('replace comparison', async () => {
    assert.equal(await run('replace("hello world", "world", "earth") == "hello earth"'), 1);
  });
});

describe('WASM strings — trim', () => {
  it('trim leading spaces', async () => {
    assert.equal(await runStr('trim("  hello")'), 'hello');
  });

  it('trim trailing spaces', async () => {
    assert.equal(await runStr('trim("hello  ")'), 'hello');
  });

  it('trim both', async () => {
    assert.equal(await runStr('trim("  hello  ")'), 'hello');
  });

  it('trim no whitespace', async () => {
    assert.equal(await runStr('trim("hello")'), 'hello');
  });

  it('trim all whitespace', async () => {
    assert.equal(await run('len(trim("   "))'), 0);
  });

  it('trim tabs and newlines', async () => {
    assert.equal(await run('len(trim("\\t\\nhello\\n\\t"))'), 5);
  });

  it('trim comparison', async () => {
    assert.equal(await run('trim("  hello  ") == "hello"'), 1);
  });
});

describe('WASM strings — intToString', () => {
  it('positive integer', async () => {
    assert.equal(await runStr('intToString(42)'), '42');
  });

  it('zero', async () => {
    assert.equal(await runStr('intToString(0)'), '0');
  });

  it('large number', async () => {
    assert.equal(await runStr('intToString(12345)'), '12345');
  });

  it('negative number', async () => {
    assert.equal(await runStr('intToString(0 - 42)'), '-42');
  });

  it('single digit', async () => {
    assert.equal(await runStr('intToString(7)'), '7');
  });

  it('comparison', async () => {
    assert.equal(await run('intToString(100) == "100"'), 1);
  });

  it('concat with string', async () => {
    assert.equal(await runStr('"value: " + intToString(42)'), 'value: 42');
  });

  it('len of number string', async () => {
    assert.equal(await run('len(intToString(12345))'), 5);
  });
});
