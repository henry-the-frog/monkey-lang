import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmModule, WasmOp, WASM_TYPE, encodeULEB128, encodeSLEB128 } from './wasm.js';

describe('WASM Memory and Data Segments', () => {
  it('should encode memory section', async () => {
    const mod = new WasmModule();
    mod.addMemory(1, 10);
    const typeIdx = mod.addType([], [WASM_TYPE.I32]);
    mod.addFunction(typeIdx, [], [WasmOp.i32_const, ...encodeSLEB128(42)]);
    mod.exportFunction('test', 0);
    mod.exportMemory();
    
    const inst = await WebAssembly.instantiate(mod.encode(), {});
    assert.ok(inst.instance.exports.memory instanceof WebAssembly.Memory);
    assert.equal(inst.instance.exports.test(), 42);
  });

  it('should store and read string constants from data segments', async () => {
    const mod = new WasmModule();
    const s1 = mod.addStringConstant('Hello');
    const s2 = mod.addStringConstant('World');
    
    assert.equal(s1.offset, 0);
    assert.equal(s1.length, 5);
    assert.equal(s2.length, 5);
    assert.ok(s2.offset >= 12); // aligned after s1
    
    // Function returns offset of s1
    const typeIdx = mod.addType([], [WASM_TYPE.I32]);
    mod.addFunction(typeIdx, [], [WasmOp.i32_const, ...encodeSLEB128(s1.offset)]);
    mod.exportFunction('getS1', 0);
    mod.exportMemory();
    
    const inst = await WebAssembly.instantiate(mod.encode(), {});
    const mem = new Uint8Array(inst.instance.exports.memory.buffer);
    const len = new DataView(inst.instance.exports.memory.buffer).getInt32(s1.offset, true);
    const str = new TextDecoder().decode(mem.slice(s1.offset + 4, s1.offset + 4 + len));
    assert.equal(str, 'Hello');
  });

  it('should load string length with i32.load', async () => {
    const mod = new WasmModule();
    const s = mod.addStringConstant('Hello, WASM!');
    
    const typeIdx = mod.addType([], [WASM_TYPE.I32]);
    const body = [
      WasmOp.i32_const, ...encodeSLEB128(s.offset),
      0x28, 0x02, 0x00, // i32.load align=4 offset=0
    ];
    mod.addFunction(typeIdx, [], body);
    mod.exportFunction('getLen', 0);
    mod.exportMemory();
    
    const inst = await WebAssembly.instantiate(mod.encode(), {});
    assert.equal(inst.instance.exports.getLen(), 12);
  });

  it('should handle raw data segments', async () => {
    const mod = new WasmModule();
    const data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const seg = mod.addDataSegment(data);
    
    assert.equal(seg.offset, 0);
    assert.equal(seg.length, 4);
    
    // Read it back
    const typeIdx = mod.addType([], [WASM_TYPE.I32]);
    mod.addFunction(typeIdx, [], [
      WasmOp.i32_const, ...encodeSLEB128(seg.offset),
      0x28, 0x02, 0x00,
    ]);
    mod.exportFunction('read', 0);
    mod.exportMemory();
    
    const inst = await WebAssembly.instantiate(mod.encode(), {});
    // i32.load returns signed, so interpret accordingly
    const result = inst.instance.exports.read();
    // 0xDEADBEEF in little-endian from offset 0
    assert.equal(result >>> 0, 0xEFBEADDE); // Unsigned view
  });

  it('should auto-declare memory when adding data segments', async () => {
    const mod = new WasmModule();
    assert.equal(mod.memory, null);
    mod.addStringConstant('auto');
    assert.ok(mod.memory !== null);
    assert.equal(mod.memory.min, 1);
  });

  it('should align data segments to 4-byte boundaries', () => {
    const mod = new WasmModule();
    const s1 = mod.addStringConstant('Hi'); // 4+2=6 bytes, aligned to 8
    const s2 = mod.addStringConstant('OK'); // starts at offset 8
    assert.equal(s1.offset, 0);
    assert.equal(s2.offset, 8);
  });

  it('should work with imports, memory, and data together', async () => {
    const mod = new WasmModule();
    const s = mod.addStringConstant('test');
    const addIdx = mod.addImport('env', 'add', [WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Return add(string_offset, string_length)
    const typeIdx = mod.addType([], [WASM_TYPE.I32]);
    const body = [
      WasmOp.i32_const, ...encodeSLEB128(s.offset),
      WasmOp.i32_const, ...encodeSLEB128(s.length),
      WasmOp.call, ...encodeULEB128(addIdx),
    ];
    mod.addFunction(typeIdx, [], body);
    mod.exportFunction('test', 1); // func index 1 (after 1 import)
    mod.exportMemory();
    
    const inst = await WebAssembly.instantiate(mod.encode(), {
      env: { add: (a, b) => a + b }
    });
    assert.equal(inst.instance.exports.test(), s.offset + s.length);
  });
});
