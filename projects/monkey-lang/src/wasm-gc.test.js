// wasm-gc.test.js — Verify WASM GC type definitions, ref types, and GC instructions
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmModuleBuilder, ValType, GcOp, TypeKind, refType, refNullType } from './wasm.js';

describe('WASM GC Module Builder', () => {
  describe('Type definitions', () => {
    it('creates struct type with i32 field', () => {
      const builder = new WasmModuleBuilder();
      const idx = builder.addStructType([{ type: ValType.i32, mutable: true }]);
      assert.equal(idx, 0);
      assert.equal(builder.types[0].kind, 'struct');
      assert.equal(builder.types[0].fields.length, 1);
    });

    it('creates array type', () => {
      const builder = new WasmModuleBuilder();
      const idx = builder.addArrayType(ValType.i32, true);
      assert.equal(idx, 0);
      assert.equal(builder.types[0].kind, 'array');
      assert.equal(builder.types[0].elemType, ValType.i32);
      assert.equal(builder.types[0].mutable, true);
    });

    it('mixes struct, array, and func types', () => {
      const builder = new WasmModuleBuilder();
      const s = builder.addStructType([{ type: ValType.i32, mutable: true }]);
      const a = builder.addArrayType(ValType.i32, true);
      const f = builder.addType([], [ValType.i32]);
      assert.equal(s, 0);
      assert.equal(a, 1);
      assert.equal(f, 2);
    });

    it('struct type with ref field (cross-type reference)', () => {
      const builder = new WasmModuleBuilder();
      const arrayIdx = builder.addArrayType(ValType.i32, true);
      const structIdx = builder.addStructType([
        { type: ValType.i32, mutable: true },
        { type: refNullType(arrayIdx), mutable: true }
      ]);
      assert.equal(structIdx, 1);
      assert.deepEqual(builder.types[1].fields[1].type, { ref: 0, nullable: true });
    });
  });

  describe('GC struct operations', () => {
    it('struct.new + struct.get (single field)', async () => {
      const builder = new WasmModuleBuilder();
      const structIdx = builder.addStructType([{ type: ValType.i32, mutable: true }]);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(structIdx));
      body.i32Const(42);
      body.structNew(structIdx);
      body.localSet(0);
      body.localGet(0);
      body.structGet(structIdx, 0);
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 42);
    });

    it('struct.new + struct.set + struct.get (mutation)', async () => {
      const builder = new WasmModuleBuilder();
      const structIdx = builder.addStructType([{ type: ValType.i32, mutable: true }]);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(structIdx));
      body.i32Const(0);
      body.structNew(structIdx);
      body.localSet(0);
      // Set field to 99
      body.localGet(0);
      body.i32Const(99);
      body.structSet(structIdx, 0);
      // Read back
      body.localGet(0);
      body.structGet(structIdx, 0);
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 99);
    });

    it('struct with multiple fields', async () => {
      const builder = new WasmModuleBuilder();
      const structIdx = builder.addStructType([
        { type: ValType.i32, mutable: true },
        { type: ValType.i32, mutable: true },
        { type: ValType.i32, mutable: true }
      ]);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(structIdx));
      body.i32Const(10);  // field 0
      body.i32Const(20);  // field 1
      body.i32Const(30);  // field 2
      body.structNew(structIdx);
      body.localSet(0);
      // Sum all fields
      body.localGet(0);
      body.structGet(structIdx, 0);
      body.localGet(0);
      body.structGet(structIdx, 1);
      body.emit(0x6a); // i32.add
      body.localGet(0);
      body.structGet(structIdx, 2);
      body.emit(0x6a); // i32.add
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 60);
    });
  });

  describe('GC array operations', () => {
    it('array.new + array.get', async () => {
      const builder = new WasmModuleBuilder();
      const arrayIdx = builder.addArrayType(ValType.i32, true);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(arrayIdx));
      body.i32Const(7);    // fill value
      body.i32Const(10);   // length
      body.arrayNew(arrayIdx);
      body.localSet(0);
      // Get element [3] (should be 7)
      body.localGet(0);
      body.i32Const(3);
      body.arrayGet(arrayIdx);
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 7);
    });

    it('array.set + array.get', async () => {
      const builder = new WasmModuleBuilder();
      const arrayIdx = builder.addArrayType(ValType.i32, true);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(arrayIdx));
      body.i32Const(0);    // fill
      body.i32Const(5);    // length
      body.arrayNew(arrayIdx);
      body.localSet(0);
      // Set [2] = 42
      body.localGet(0);
      body.i32Const(2);
      body.i32Const(42);
      body.arraySet(arrayIdx);
      // Get [2]
      body.localGet(0);
      body.i32Const(2);
      body.arrayGet(arrayIdx);
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 42);
    });

    it('array.len', async () => {
      const builder = new WasmModuleBuilder();
      const arrayIdx = builder.addArrayType(ValType.i32, true);
      const { index, body } = builder.addFunction([], [ValType.i32]);
      body.addLocal(refNullType(arrayIdx));
      body.i32Const(0);    // fill
      body.i32Const(8);    // length
      body.arrayNew(arrayIdx);
      body.localSet(0);
      body.localGet(0);
      body.arrayLen();
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(), 8);
    });
  });

  describe('i31ref operations', () => {
    it('ref.i31 + i31.get_s roundtrip (positive)', async () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
      body.addLocal(ValType.eqref);
      body.localGet(0);
      body.refI31();
      body.localSet(1);
      body.localGet(1);
      body.refCast(0x6c); // i31 heaptype
      body.i31GetS();
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(42), 42);
      assert.equal(inst.exports.test(1000000), 1000000);
    });

    it('ref.i31 + i31.get_s (negative)', async () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
      body.addLocal(ValType.eqref);
      body.localGet(0);
      body.refI31();
      body.localSet(1);
      body.localGet(1);
      body.refCast(0x6c);
      body.i31GetS();
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(-1), -1);
      assert.equal(inst.exports.test(-1000000), -1000000);
    });

    it('i31.get_u for unsigned interpretation', async () => {
      const builder = new WasmModuleBuilder();
      const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
      body.addLocal(ValType.eqref);
      body.localGet(0);
      body.refI31();
      body.localSet(1);
      body.localGet(1);
      body.refCast(0x6c);
      body.i31GetU();
      builder.addMemory(1);
      builder.addExport('test', 0x00, index);
      const binary = builder.build();
      const mod = new WebAssembly.Module(binary);
      const inst = new WebAssembly.Instance(mod);
      assert.equal(inst.exports.test(42), 42);
    });
  });

  describe('Binary encoding verification', () => {
    it('type section encodes struct correctly (0x5f)', () => {
      const builder = new WasmModuleBuilder();
      builder.addStructType([{ type: ValType.i32, mutable: true }]);
      builder.addFunction([], []);
      builder.addMemory(1);
      const binary = builder.build();
      // Find type section (id=1)
      // After magic+version (8 bytes), section id 0x01, then size, then type count
      const bytes = Array.from(binary.slice(8, 20));
      assert.equal(bytes[0], 0x01); // section id = Type
      assert.equal(bytes[2], 0x02); // 2 types (struct + func)
      assert.equal(bytes[3], 0x5f); // first type = struct
    });

    it('type section encodes array correctly (0x5e)', () => {
      const builder = new WasmModuleBuilder();
      builder.addArrayType(ValType.i32, true);
      builder.addFunction([], []);
      builder.addMemory(1);
      const binary = builder.build();
      const bytes = Array.from(binary.slice(8, 20));
      assert.equal(bytes[0], 0x01); // Type section
      assert.equal(bytes[3], 0x5e); // first type = array
    });
  });
});

describe('GC Array Proof-of-Concept (loop fill + sum)', () => {
  it('fills array with loop and sums elements', async () => {
    const { WasmModuleBuilder, ValType, Op, refNullType } = await import('./wasm.js');
    const builder = new WasmModuleBuilder();
    const arrayIdx = builder.addArrayType(ValType.i32, true);
    const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
    body.addLocal(refNullType(arrayIdx)); // arr
    body.addLocal(ValType.i32);            // i
    body.addLocal(ValType.i32);            // sum

    // arr = array.new(0, n)
    body.i32Const(0);
    body.localGet(0);
    body.arrayNew(arrayIdx);
    body.localSet(1);

    // Fill: arr[i] = i
    body.i32Const(0); body.localSet(2);
    body.block(); body.loop();
      body.localGet(2); body.localGet(0); body.emit(Op.i32_ge_s); body.brIf(1);
      body.localGet(1); body.localGet(2); body.localGet(2); body.arraySet(arrayIdx);
      body.localGet(2); body.i32Const(1); body.emit(Op.i32_add); body.localSet(2);
      body.br(0);
    body.end(); body.end();

    // Sum: sum += arr[i]
    body.i32Const(0); body.localSet(2);
    body.i32Const(0); body.localSet(3);
    body.block(); body.loop();
      body.localGet(2); body.localGet(0); body.emit(Op.i32_ge_s); body.brIf(1);
      body.localGet(3); body.localGet(1); body.localGet(2); body.arrayGet(arrayIdx);
      body.emit(Op.i32_add); body.localSet(3);
      body.localGet(2); body.i32Const(1); body.emit(Op.i32_add); body.localSet(2);
      body.br(0);
    body.end(); body.end();

    body.localGet(3);
    builder.addMemory(1);
    builder.addExport('sum_array', 0x00, index);

    const binary = builder.build();
    const mod = new WebAssembly.Module(binary);
    const inst = new WebAssembly.Instance(mod);

    assert.equal(inst.exports.sum_array(10), 45);
    assert.equal(inst.exports.sum_array(100), 4950);
    assert.equal(inst.exports.sum_array(1000), 499500);
  });

  it('performs well (10K iterations under 100ms)', async () => {
    const { WasmModuleBuilder, ValType, Op, refNullType } = await import('./wasm.js');
    const builder = new WasmModuleBuilder();
    const arrayIdx = builder.addArrayType(ValType.i32, true);
    const { index, body } = builder.addFunction([ValType.i32], [ValType.i32]);
    body.addLocal(refNullType(arrayIdx));
    body.addLocal(ValType.i32);
    body.addLocal(ValType.i32);
    body.i32Const(0); body.localGet(0); body.arrayNew(arrayIdx); body.localSet(1);
    body.i32Const(0); body.localSet(2);
    body.block(); body.loop();
      body.localGet(2); body.localGet(0); body.emit(Op.i32_ge_s); body.brIf(1);
      body.localGet(1); body.localGet(2); body.localGet(2); body.arraySet(arrayIdx);
      body.localGet(2); body.i32Const(1); body.emit(Op.i32_add); body.localSet(2);
      body.br(0);
    body.end(); body.end();
    body.i32Const(0); body.localSet(2);
    body.i32Const(0); body.localSet(3);
    body.block(); body.loop();
      body.localGet(2); body.localGet(0); body.emit(Op.i32_ge_s); body.brIf(1);
      body.localGet(3); body.localGet(1); body.localGet(2); body.arrayGet(arrayIdx);
      body.emit(Op.i32_add); body.localSet(3);
      body.localGet(2); body.i32Const(1); body.emit(Op.i32_add); body.localSet(2);
      body.br(0);
    body.end(); body.end();
    body.localGet(3);
    builder.addMemory(1);
    builder.addExport('f', 0x00, index);
    const binary = builder.build();
    const mod = new WebAssembly.Module(binary);
    const inst = new WebAssembly.Instance(mod);
    const start = Date.now();
    for (let i = 0; i < 10000; i++) inst.exports.f(100);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 100, `GC array loop took ${elapsed}ms (expected < 100ms)`);
  });
});
