import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmModule, WasmOp, WASM_TYPE, encodeULEB128 } from './wasm.js';
import { compileToWasm } from './wasm-compiler.js';

describe('WASM Import Support', () => {
  it('should encode import section and link with JS function', async () => {
    const mod = new WasmModule();
    const importIdx = mod.addImport("math", "add", [WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    assert.equal(importIdx, 0);

    const body = [
      WasmOp.local_get, ...encodeULEB128(0),
      WasmOp.local_get, ...encodeULEB128(1),
      WasmOp.call, ...encodeULEB128(importIdx),
    ];
    const typeIdx = mod.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    const localIdx = mod.addFunction(typeIdx, [], body);
    assert.equal(localIdx, 1); // after 1 import
    mod.exportFunction("callAdd", localIdx);

    const binary = mod.encode();
    const inst = await WebAssembly.instantiate(binary, {
      math: { add: (a, b) => a + b }
    });
    assert.equal(inst.instance.exports.callAdd(3, 7), 10);
  });

  it('should handle multiple imports', async () => {
    const mod = new WasmModule();
    const mulIdx = mod.addImport("math", "multiply", [WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    const sqrtIdx = mod.addImport("math", "isqrt", [WASM_TYPE.I32], [WASM_TYPE.I32]);
    assert.equal(mulIdx, 0);
    assert.equal(sqrtIdx, 1);

    const body = [
      WasmOp.local_get, ...encodeULEB128(0),
      WasmOp.local_get, ...encodeULEB128(0),
      WasmOp.call, ...encodeULEB128(mulIdx),
      WasmOp.call, ...encodeULEB128(sqrtIdx),
    ];
    const typeIdx = mod.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    const localIdx = mod.addFunction(typeIdx, [], body);
    assert.equal(localIdx, 2);
    mod.exportFunction("squareRoot", localIdx);

    const bin = mod.encode();
    const inst = await WebAssembly.instantiate(bin, {
      math: {
        multiply: (a, b) => a * b,
        isqrt: (a) => Math.floor(Math.sqrt(a)),
      }
    });
    assert.equal(inst.instance.exports.squareRoot(5), 5);
  });

  it('should compile Monkey import statements to WASM imports', async () => {
    const source = 'import "math" { double };\ndouble(21);';
    const wasm = compileToWasm(source, {
      importSignatures: { "math.double": { params: [WASM_TYPE.I32], results: [WASM_TYPE.I32] } }
    });
    const inst = await WebAssembly.instantiate(wasm, {
      math: { double: (x) => x * 2 }
    });
    assert.equal(inst.instance.exports.main(), 42);
  });

  it('should link imported and local functions together', async () => {
    const source = `
import "env" { square };
let addSquares = fn(a, b) { square(a) + square(b) };
addSquares(3, 4);
`;
    const wasm = compileToWasm(source, {
      importSignatures: { "env.square": { params: [WASM_TYPE.I32], results: [WASM_TYPE.I32] } }
    });
    const inst = await WebAssembly.instantiate(wasm, {
      env: { square: (x) => x * x }
    });
    assert.equal(inst.instance.exports.main(), 25); // 9 + 16
  });

  it('should work with no imports (backward compat)', async () => {
    const source = 'let add = fn(a, b) { a + b }; add(10, 20);';
    const wasm = compileToWasm(source);
    const inst = await WebAssembly.instantiate(wasm, {});
    assert.equal(inst.instance.exports.main(), 30);
  });
});
