// Tests for WASM Disassembler
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BinaryReader, WasmDisassembler, disassemble, formatWAT } from './wasm-dis.js';
import { WasmModuleBuilder, FuncBodyBuilder, Op, ValType, ExportKind } from './wasm.js';
import { WasmCompiler } from './wasm-compiler.js';

describe('WASM Disassembler', () => {

  describe('BinaryReader', () => {
    it('reads ULEB128', () => {
      const reader = new BinaryReader(new Uint8Array([0xe5, 0x8e, 0x26]));
      assert.strictEqual(reader.readULEB128(), 624485);
    });

    it('reads SLEB128 positive', () => {
      const reader = new BinaryReader(new Uint8Array([0xc0, 0x00]));
      assert.strictEqual(reader.readSLEB128(), 64);
    });

    it('reads SLEB128 negative', () => {
      const reader = new BinaryReader(new Uint8Array([0x7f]));
      assert.strictEqual(reader.readSLEB128(), -1);
    });

    it('reads string', () => {
      const reader = new BinaryReader(new Uint8Array([5, 72, 101, 108, 108, 111]));
      assert.strictEqual(reader.readString(), 'Hello');
    });
  });

  describe('Round-trip: build → disassemble', () => {
    it('disassembles empty module', () => {
      const builder = new WasmModuleBuilder();
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('(module'));
      assert.ok(wat.includes(')'));
    });

    it('disassembles simple function', () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.i32Const(42);
      builder.addExport('answer', ExportKind.Func, index);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('i32.const 42'));
      assert.ok(wat.includes('export "answer"'));
    });

    it('disassembles function with params', () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([ValType.i32, ValType.i32], [ValType.i32]);
      body.localGet(0).localGet(1).emit(Op.i32_add);
      builder.addExport('add', ExportKind.Func, index);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('param i32 i32'));
      assert.ok(wat.includes('result i32'));
      assert.ok(wat.includes('i32.add'));
    });

    it('disassembles memory', () => {
      const builder = new WasmModuleBuilder();
      builder.addMemory(1, 10);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('memory'));
      assert.ok(wat.includes('1'));
    });

    it('disassembles globals', () => {
      const builder = new WasmModuleBuilder();
      builder.addGlobal(ValType.i32, true, 42);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('global'));
      assert.ok(wat.includes('mut'));
      assert.ok(wat.includes('42'));
    });

    it('disassembles if/else', () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
      body.localGet(0).if_(ValType.i32).i32Const(1).else_().i32Const(0).end();
      builder.addExport('test', ExportKind.Func, index);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('if'));
      assert.ok(wat.includes('else'));
    });

    it('disassembles loop', () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.block().loop().i32Const(0).brIf(1).br(0).end().end();
      body.i32Const(0);
      builder.addExport('test', ExportKind.Func, index);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('block'));
      assert.ok(wat.includes('loop'));
      assert.ok(wat.includes('br_if'));
    });

    it('disassembles imports', () => {
      const builder = new WasmModuleBuilder();
      const importIdx = builder.addImport('env', 'log', [ValType.i32], []);
      // Actually use the import so it doesn't get stripped
      const { body } = builder.addFunction([ValType.i32], []);
      body.i32Const(42);
      body.call(importIdx);
      body.i32Const(0);
      body.end();
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('import "env" "log"'));
    });

    it('disassembles data segment', () => {
      const builder = new WasmModuleBuilder();
      builder.addMemory(1);
      builder.addDataSegment(0, [72, 101, 108, 108, 111]);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('data'));
    });

    it('disassembles table and elements', () => {
      const builder = new WasmModuleBuilder();
      const { index: f0 } = builder.addFunction([ValType.i32], [ValType.i32]);
      builder.addTable(ValType.funcref, 1, 1);
      builder.addElement(0, 0, [f0]);
      builder.addExport('f', ExportKind.Func, f0);
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('table'));
      assert.ok(wat.includes('elem'));
    });
  });

  describe('Monkey WASM round-trip', () => {
    it('disassembles compiled monkey program', () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('42');
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('i32.const 42'));
      assert.ok(wat.includes('export "main"'));
    });

    it('disassembles fibonacci', () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('let fib = fn(n) { if (n < 2) { n } else { fib(n-1) + fib(n-2) } }; fib(10)');
      const binary = builder.build();
      const wat = disassemble(binary);
      // fib may be compiled as a direct function or a boxed closure depending on self-reference analysis
      assert.ok(wat.includes('export "fib"') || wat.includes('call_indirect'));
      assert.ok(wat.includes('i32.add'));
    });

    it('disassembles program with closures', () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('let makeAdder = fn(x) { fn(y) { x + y } }; let f = makeAdder(5); f(3)');
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('call_indirect'));
      assert.ok(wat.includes('table'));
    });

    it('disassembles program with strings', () => {
      const compiler = new WasmCompiler();
      const builder = compiler.compile('"hello"');
      const binary = builder.build();
      const wat = disassemble(binary);
      assert.ok(wat.includes('data'));
    });
  });
});
