// wasm.js — WebAssembly Binary Encoder for Monkey-Lang
//
// Phase 1: Integer arithmetic + function compilation
// Produces valid WASM binary modules from monkey-lang AST.
//
// WASM binary format:
//   Magic: \0asm (4 bytes)
//   Version: 1 (4 bytes)
//   Sections: type(1), function(3), export(7), code(10)

// --- LEB128 Encoding ---

/**
 * Encode an unsigned integer as LEB128.
 */
function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7F;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

/**
 * Encode a signed integer as LEB128.
 */
function encodeSLEB128(value) {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 0x7F;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) ||
        (value === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    bytes.push(byte);
  }
  return bytes;
}

// --- WASM Type Constants ---
const WASM_TYPE = {
  I32: 0x7F,
  I64: 0x7E,
  F32: 0x7D,
  F64: 0x7C,
  FUNCREF: 0x70,
  EXTERNREF: 0x6F,
};

const WASM_SECTION = {
  TYPE: 1,
  IMPORT: 2,
  FUNCTION: 3,
  TABLE: 4,
  MEMORY: 5,
  GLOBAL: 6,
  EXPORT: 7,
  START: 8,
  ELEMENT: 9,
  CODE: 10,
  DATA: 11,
};

const WASM_EXPORT_KIND = {
  FUNCTION: 0x00,
  TABLE: 0x01,
  MEMORY: 0x02,
  GLOBAL: 0x03,
};

// --- WASM Opcodes ---
const WasmOp = {
  // Control flow
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if_: 0x04,
  else_: 0x05,
  end: 0x0B,
  br: 0x0C,
  br_if: 0x0D,
  return_: 0x0F,
  call: 0x10,
  
  // Variables
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,
  
  // i32 operations
  i32_const: 0x41,
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4A,
  i32_gt_u: 0x4B,
  i32_le_s: 0x4C,
  i32_ge_s: 0x4E,
  i32_add: 0x6A,
  i32_sub: 0x6B,
  i32_mul: 0x6C,
  i32_div_s: 0x6D,
  i32_rem_s: 0x6F,
  
  // Drop
  drop: 0x1A,
};

// --- WASM Module Builder ---

class WasmModule {
  constructor() {
    this.types = [];      // Function signatures: [{params: [type], results: [type]}]
    this.functions = [];  // Function type indices
    this.exports = [];    // {name, kind, index}
    this.codes = [];      // Function bodies: [{locals: [{count, type}], body: [byte]}]
  }
  
  /**
   * Add a function type (signature). Returns the type index.
   * Deduplicates: if same signature exists, returns existing index.
   */
  addType(params, results) {
    const sig = JSON.stringify({ params, results });
    for (let i = 0; i < this.types.length; i++) {
      if (JSON.stringify(this.types[i]) === sig) return i;
    }
    this.types.push({ params, results });
    return this.types.length - 1;
  }
  
  /**
   * Add a function. Returns the function index.
   */
  addFunction(typeIndex, locals, body) {
    const funcIndex = this.functions.length;
    this.functions.push(typeIndex);
    this.codes.push({ locals, body });
    return funcIndex;
  }
  
  /**
   * Export a function by name.
   */
  exportFunction(name, funcIndex) {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.FUNCTION, index: funcIndex });
  }
  
  /**
   * Encode the module to a Uint8Array (valid .wasm binary).
   */
  encode() {
    const sections = [];
    
    // Type section
    if (this.types.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.types.length));
      for (const type of this.types) {
        content.push(0x60); // functype
        content.push(...encodeULEB128(type.params.length));
        for (const p of type.params) content.push(p);
        content.push(...encodeULEB128(type.results.length));
        for (const r of type.results) content.push(r);
      }
      sections.push(this._encodeSection(WASM_SECTION.TYPE, content));
    }
    
    // Function section
    if (this.functions.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.functions.length));
      for (const typeIdx of this.functions) {
        content.push(...encodeULEB128(typeIdx));
      }
      sections.push(this._encodeSection(WASM_SECTION.FUNCTION, content));
    }
    
    // Export section
    if (this.exports.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.exports.length));
      for (const exp of this.exports) {
        const nameBytes = new TextEncoder().encode(exp.name);
        content.push(...encodeULEB128(nameBytes.length));
        content.push(...nameBytes);
        content.push(exp.kind);
        content.push(...encodeULEB128(exp.index));
      }
      sections.push(this._encodeSection(WASM_SECTION.EXPORT, content));
    }
    
    // Code section
    if (this.codes.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.codes.length));
      for (const code of this.codes) {
        const funcBody = [];
        // Local declarations
        funcBody.push(...encodeULEB128(code.locals.length));
        for (const local of code.locals) {
          funcBody.push(...encodeULEB128(local.count));
          funcBody.push(local.type);
        }
        // Body instructions
        funcBody.push(...code.body);
        funcBody.push(WasmOp.end); // function end
        
        // Encode function body with size prefix
        content.push(...encodeULEB128(funcBody.length));
        content.push(...funcBody);
      }
      sections.push(this._encodeSection(WASM_SECTION.CODE, content));
    }
    
    // Assemble final binary
    const header = [
      0x00, 0x61, 0x73, 0x6D, // magic: \0asm
      0x01, 0x00, 0x00, 0x00, // version: 1
    ];
    
    const totalSize = header.length + sections.reduce((sum, s) => sum + s.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const byte of header) result[offset++] = byte;
    for (const section of sections) {
      for (const byte of section) result[offset++] = byte;
    }
    
    return result;
  }
  
  _encodeSection(id, content) {
    return [id, ...encodeULEB128(content.length), ...content];
  }
}

export { WasmModule, WasmOp, WASM_TYPE, encodeULEB128, encodeSLEB128 };
