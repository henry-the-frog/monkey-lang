// compiler.test.js — Tests for Monkey bytecode compiler
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Compiler, SymbolTable, SymbolScopes, CompiledFunction } from './compiler.js';
import { Opcodes, make, concatInstructions, disassemble } from './code.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { MonkeyInteger, MonkeyString } from './object.js';

function parse(input) {
  const l = new Lexer(input);
  const p = new Parser(l);
  return p.parseProgram();
}

function testCompile(input, options = {}) {
  const program = parse(input);
  const compiler = new Compiler({ optimize: false, ...options });
  compiler.compile(program);
  return compiler.bytecode();
}

function testInstructions(expected) {
  return concatInstructions(...expected);
}

describe('Compiler', () => {
  describe('integer arithmetic', () => {
    it('compiles 1 + 2 (constant folded)', () => {
      const bc = testCompile('1 + 2');
      const expected = testInstructions([
        make(Opcodes.OpConstant, 0),
        make(Opcodes.OpPop),
      ]);
      assert.deepEqual([...bc.instructions], [...expected]);
      // Constant folded: 1 + 2 = 3
      assert.equal(bc.constants[0].value, 3);
    });

    it('compiles 1 - 2 (constant folded)', () => {
      const bc = testCompile('1 - 2');
      assert.equal(bc.constants[0].value, -1);
    });

    it('compiles 1 * 2 (constant folded)', () => {
      const bc = testCompile('1 * 2');
      assert.equal(bc.constants[0].value, 2);
    });

    it('compiles 2 / 1 (constant folded)', () => {
      const bc = testCompile('2 / 1');
      assert.equal(bc.constants[0].value, 2);
    });

    it('compiles -1 (constant folded)', () => {
      const bc = testCompile('-1');
      assert.equal(bc.constants[0].value, -1);
    });

    it('compiles complex constant: (2 + 3) * 4', () => {
      const bc = testCompile('(2 + 3) * 4');
      // Should fold to 20
      assert.equal(bc.constants[0].value, 20);
    });
  });

  describe('boolean expressions', () => {
    it('compiles true', () => {
      const bc = testCompile('true');
      assert.ok(bc.instructions.includes(Opcodes.OpTrue));
    });

    it('compiles false', () => {
      const bc = testCompile('false');
      assert.ok(bc.instructions.includes(Opcodes.OpFalse));
    });

    it('compiles 1 > 2 (constant-folded to false)', () => {
      const bc = testCompile('1 > 2');
      // Constant folding reduces 1 > 2 to false at compile time
      assert.ok(bc.instructions.includes(Opcodes.OpFalse));
    });

    it('compiles 1 < 2 (constant-folded to true)', () => {
      const bc = testCompile('1 < 2');
      assert.ok(bc.instructions.includes(Opcodes.OpTrue));
    });

    it('compiles 1 == 2 (constant-folded to false)', () => {
      const bc = testCompile('1 == 2');
      assert.ok(bc.instructions.includes(Opcodes.OpFalse));
    });

    it('compiles 1 != 2 (constant-folded to true)', () => {
      const bc = testCompile('1 != 2');
      assert.ok(bc.instructions.includes(Opcodes.OpTrue));
    });

    it('compiles !true (constant-folded to false)', () => {
      const bc = testCompile('!true');
      assert.ok(bc.instructions.includes(Opcodes.OpFalse));
    });
  });

  describe('conditionals', () => {
    it('compiles if (true) { 10 }', () => {
      const bc = testCompile('if (true) { 10 }');
      assert.ok(bc.instructions.includes(Opcodes.OpJumpNotTruthy));
      assert.ok(bc.instructions.includes(Opcodes.OpJump));
      assert.ok(bc.instructions.includes(Opcodes.OpNull)); // no else → null
    });

    it('compiles if (true) { 10 } else { 20 }', () => {
      const bc = testCompile('if (true) { 10 } else { 20 }');
      assert.ok(bc.instructions.includes(Opcodes.OpJumpNotTruthy));
      assert.ok(bc.instructions.includes(Opcodes.OpJump));
      assert.equal(bc.constants.length, 2);
    });
  });

  describe('let statements', () => {
    it('compiles let x = 1; let y = 2;', () => {
      const bc = testCompile('let x = 1; let y = 2;');
      assert.ok(bc.instructions.includes(Opcodes.OpSetGlobal));
    });

    it('compiles let x = 1; x;', () => {
      const bc = testCompile('let x = 1; x;');
      assert.ok(bc.instructions.includes(Opcodes.OpSetGlobal));
      // After constant substitution, x is replaced with 1 directly
      // So OpGetGlobal may not be present (optimized away)
      assert.ok(bc.constants.some(c => c.value === 1));
    });
  });

  describe('string expressions', () => {
    it('compiles "hello"', () => {
      const bc = testCompile('"hello"');
      assert.equal(bc.constants[0].value, 'hello');
    });

    it('compiles string concatenation', () => {
      const bc = testCompile('"hello" + " world"');
      // Constant folding: "hello" + " world" → "hello world" at compile time
      assert.equal(bc.constants.length, 1);
      assert.equal(bc.constants[0].value, 'hello world');
    });
  });

  describe('arrays', () => {
    it('compiles []', () => {
      const bc = testCompile('[]');
      assert.ok(bc.instructions.includes(Opcodes.OpArray));
    });

    it('compiles [1, 2, 3]', () => {
      const bc = testCompile('[1, 2, 3]');
      assert.equal(bc.constants.length, 3);
      assert.ok(bc.instructions.includes(Opcodes.OpArray));
    });

    it('compiles [1, 2, 3][1]', () => {
      const bc = testCompile('[1, 2, 3][1]');
      assert.ok(bc.instructions.includes(Opcodes.OpIndex));
    });
  });

  describe('hash literals', () => {
    it('compiles {}', () => {
      const bc = testCompile('{}');
      assert.ok(bc.instructions.includes(Opcodes.OpHash));
    });

    it('compiles {1: 2, 3: 4}', () => {
      const bc = testCompile('{1: 2, 3: 4}');
      assert.ok(bc.instructions.includes(Opcodes.OpHash));
    });
  });

  describe('functions', () => {
    it('compiles fn() { return 5 + 10 }', () => {
      const bc = testCompile('fn() { return 5 + 10 }');
      assert.ok(bc.constants.some(c => c instanceof CompiledFunction));
      assert.ok(bc.instructions.includes(Opcodes.OpClosure));
    });

    it('compiles fn() { 5 + 10 } (implicit return)', () => {
      const bc = testCompile('fn() { 5 + 10 }');
      const fn = bc.constants.find(c => c instanceof CompiledFunction);
      assert.ok(fn);
      // Should have OpReturnValue (replaced from OpPop)
      assert.ok(fn.instructions.includes(Opcodes.OpReturnValue));
    });

    it('compiles fn() { } (empty body → OpReturn)', () => {
      const bc = testCompile('fn() { }');
      const fn = bc.constants.find(c => c instanceof CompiledFunction);
      assert.ok(fn);
      assert.ok(fn.instructions.includes(Opcodes.OpReturn));
    });

    it('compiles function call', () => {
      const bc = testCompile('let f = fn() { 1 }; f();');
      assert.ok(bc.instructions.includes(Opcodes.OpCall));
    });
  });
});

describe('SymbolTable', () => {
  it('defines and resolves globals', () => {
    const st = new SymbolTable();
    const a = st.define('a');
    assert.equal(a.scope, SymbolScopes.GLOBAL);
    assert.equal(a.index, 0);

    const b = st.define('b');
    assert.equal(b.index, 1);

    assert.deepEqual(st.resolve('a'), a);
    assert.deepEqual(st.resolve('b'), b);
  });

  it('resolves locals', () => {
    const global = new SymbolTable();
    global.define('a');
    const local = new SymbolTable(global);
    const b = local.define('b');
    assert.equal(b.scope, SymbolScopes.LOCAL);
  });

  it('resolves free variables', () => {
    const global = new SymbolTable();
    global.define('a');
    const first = new SymbolTable(global);
    first.define('b');
    const second = new SymbolTable(first);

    // 'b' is defined in first scope, resolved from second → free variable
    const resolved = second.resolve('b');
    assert.equal(resolved.scope, SymbolScopes.FREE);
    assert.equal(resolved.index, 0);
    assert.equal(second.freeSymbols.length, 1);
  });

  it('resolves builtins from any scope', () => {
    const global = new SymbolTable();
    global.defineBuiltin(0, 'len');
    const local = new SymbolTable(global);
    const nested = new SymbolTable(local);

    const resolved = nested.resolve('len');
    assert.equal(resolved.scope, SymbolScopes.BUILTIN);
    assert.equal(resolved.index, 0);
  });

  it('returns null for undefined names', () => {
    const st = new SymbolTable();
    assert.equal(st.resolve('undefined_var'), null);
  });
});
