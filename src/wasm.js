// wasm.js - WebAssembly Binary Encoder for Monkey-Lang
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

/**
 * Encode a 64-bit float as 8 little-endian bytes.
 */
function encodeF64(value) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  return Array.from(new Uint8Array(buf));
}

/**
 * Encode a 32-bit float as 4 little-endian bytes.
 */
function encodeF32(value) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = value;
  return Array.from(new Uint8Array(buf));
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
  call_indirect: 0x11,

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
  i32_le_u: 0x4D,
  i32_ge_s: 0x4E,
  i32_ge_u: 0x4F,
  i32_add: 0x6A,
  i32_sub: 0x6B,
  i32_mul: 0x6C,
  i32_div_s: 0x6D,
  i32_div_u: 0x6E,
  i32_rem_s: 0x6F,
  i32_rem_u: 0x70,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_shl: 0x74,
  i32_shr_s: 0x75,

  // i64 operations
  i64_const: 0x42,
  i64_eqz: 0x50,
  i64_eq: 0x51,
  i64_ne: 0x52,
  i64_lt_s: 0x53,
  i64_gt_s: 0x55,
  i64_le_s: 0x57,
  i64_ge_s: 0x59,
  i64_add: 0x7C,
  i64_sub: 0x7D,
  i64_mul: 0x7E,
  i64_div_s: 0x7F,
  i64_rem_s: 0x81,

  // Conversion
  i64_extend_i32_s: 0xAC, // sign-extend i32 to i64
  i32_wrap_i64: 0xA7,     // truncate i64 to i32
  f64_convert_i32_s: 0xB7, // convert signed i32 to f64
  f64_convert_i64_s: 0xB9, // convert signed i64 to f64

  // f64 operations
  f64_const: 0x44,
  f64_eq: 0x61,
  f64_ne: 0x62,
  f64_lt: 0x63,
  f64_gt: 0x64,
  f64_le: 0x65,
  f64_ge: 0x66,
  f64_add: 0xA0,
  f64_sub: 0xA1,
  f64_mul: 0xA2,
  f64_div: 0xA3,
  f64_neg: 0x9A,

  // Drop
  drop: 0x1A,

  // Memory operations
  i32_load: 0x28,
  i64_load: 0x29,
  f64_load: 0x2B,
  i32_load8_u: 0x2D,
  i32_store: 0x36,
  i64_store: 0x37,
  i32_store8: 0x3A,
  f64_store: 0x39,
  memory_size: 0x3F,
  memory_grow: 0x40,
};

// --- WASM Module Builder ---

class WasmModule {
  constructor() {
    this.types = [];      // Function signatures: [{params: [type], results: [type]}]
    this.imports = [];    // [{module, name, typeIndex}] - function imports
    this.functions = [];  // Function type indices (local functions)
    this.exports = [];    // {name, kind, index}
    this.codes = [];      // Function bodies: [{locals: [{count, type}], body: [byte]}]
    this.memory = null;   // {min: pages, max?: pages} - null means no memory
    this.dataSegments = []; // [{offset: number, data: Uint8Array}] - data segments
    this.globals = [];    // [{type, mutable, initExpr: [byte]}] - global variables
    this.table = null;    // {min, max?, elemType} - indirect call table
    this.elements = [];   // Function indices to populate the table
    this._nextDataOffset = 0; // Next available byte offset in linear memory
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
   * Add a function import. Returns the function index.
   * Imports occupy indices 0..N-1, local functions start at N.
   */
  addImport(moduleName, name, params, results) {
    const typeIndex = this.addType(params, results);
    const funcIndex = this.imports.length; // imports come first
    this.imports.push({ module: moduleName, name, typeIndex });
    return funcIndex;
  }

  /**
   * Add a local function. Returns the function index (imports.length + local index).
   */
  addFunction(typeIndex, locals, body) {
    const funcIndex = this.imports.length + this.functions.length;
    this.functions.push(typeIndex);
    this.codes.push({ locals, body });
    return funcIndex;
  }

  /**
   * Declare linear memory. Must be called before addDataSegment.
   * @param {number} minPages - Minimum pages (64KB each)
   * @param {number} [maxPages] - Maximum pages (optional)
   */
  addMemory(minPages, maxPages) {
    this.memory = { min: minPages, max: maxPages };
  }

  /**
   * Add a data segment to linear memory. Returns the byte offset.
   * Automatically ensures memory is declared.
   * @param {Uint8Array|string} data - Raw bytes or UTF-8 string
   * @returns {{offset: number, length: number}} - Position in memory
   */
  addDataSegment(data) {
    if (!this.memory) {
      this.addMemory(1); // Default: 1 page (64KB)
    }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const offset = this._nextDataOffset;
    this.dataSegments.push({ offset, data: bytes });
    this._nextDataOffset += bytes.length;
    // Align to 4-byte boundary for performance
    this._nextDataOffset = (this._nextDataOffset + 3) & ~3;
    return { offset, length: bytes.length };
  }

  /**
   * Add a string constant to the data segment.
   * Stores as: [i32 length][utf8 bytes]
   * Returns the offset of the length prefix.
   */
  addStringConstant(str) {
    if (!this.memory) {
      this.addMemory(1);
    }
    const encoded = new TextEncoder().encode(str);
    const offset = this._nextDataOffset;

    // Build: [length as 4 LE bytes][string bytes]
    const totalLen = 4 + encoded.length;
    const buf = new Uint8Array(totalLen);
    // Store length as little-endian i32
    buf[0] = encoded.length & 0xFF;
    buf[1] = (encoded.length >> 8) & 0xFF;
    buf[2] = (encoded.length >> 16) & 0xFF;
    buf[3] = (encoded.length >> 24) & 0xFF;
    buf.set(encoded, 4);

    this.dataSegments.push({ offset, data: buf });
    this._nextDataOffset += totalLen;
    // Align to 4 bytes
    this._nextDataOffset = (this._nextDataOffset + 3) & ~3;
    return { offset, length: encoded.length };
  }

  /**
   * Get the current data offset (for runtime heap allocation start).
   */
  getDataEnd() {
    return this._nextDataOffset;
  }

  /**
   * Add a global variable. Returns the global index.
   * @param {number} type - WASM_TYPE (I32, I64, F32, F64)
   * @param {boolean} mutable - Whether the global can be set
   * @param {number} initValue - Initial value (compiled as const expr)
   * @returns {number} Global index
   */
  addGlobal(type, mutable, initValue = 0) {
    const idx = this.globals.length;
    // Build init expression: type.const value end
    let initExpr;
    switch (type) {
      case WASM_TYPE.I32:
        initExpr = [WasmOp.i32_const, ...encodeSLEB128(initValue), WasmOp.end];
        break;
      case WASM_TYPE.I64:
        initExpr = [WasmOp.i64_const, ...encodeSLEB128(initValue), WasmOp.end];
        break;
      case WASM_TYPE.F64:
        initExpr = [WasmOp.f64_const, ...encodeF64(initValue), WasmOp.end];
        break;
      case WASM_TYPE.F32:
        initExpr = [WasmOp.f32_const, ...encodeF32(initValue), WasmOp.end];
        break;
      default:
        initExpr = [WasmOp.i32_const, ...encodeSLEB128(initValue), WasmOp.end];
    }
    this.globals.push({ type, mutable, initExpr });
    return idx;
  }

  /**
   * Export a global variable.
   */
  exportGlobal(name, globalIndex) {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.GLOBAL, index: globalIndex });
  }

  /**
   * Add a function reference table for indirect calls.
   * @param {number} minSize - Minimum table size
   * @param {number} [maxSize] - Maximum table size
   */
  addTable(minSize, maxSize) {
    this.table = { min: minSize, max: maxSize };
  }

  /**
   * Add a function to the table (element section).
   * Returns the table index for the function.
   * @param {number} funcIndex - Function index to add to table
   * @returns {number} Table index
   */
  addTableElement(funcIndex) {
    if (!this.table) {
      this.addTable(0); // Will be sized based on elements
    }
    const idx = this.elements.length;
    this.elements.push(funcIndex);
    // Auto-grow table min to fit elements
    if (this.table.min < this.elements.length) {
      this.table.min = this.elements.length;
    }
    return idx;
  }

  /**
   * Export the function table.
   */
  exportTable(name = 'table') {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.TABLE, index: 0 });
  }

  /**
   * Export a function by name.
   */
  exportFunction(name, funcIndex) {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.FUNCTION, index: funcIndex });
  }

  /**
   * Export linear memory so the host can read/write it.
   */
  exportMemory(name = 'memory') {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.MEMORY, index: 0 });
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

    // Import section (must come after type, before function)
    if (this.imports.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.imports.length));
      for (const imp of this.imports) {
        // module name
        const modBytes = new TextEncoder().encode(imp.module);
        content.push(...encodeULEB128(modBytes.length));
        content.push(...modBytes);
        // field name
        const nameBytes = new TextEncoder().encode(imp.name);
        content.push(...encodeULEB128(nameBytes.length));
        content.push(...nameBytes);
        // import kind: 0x00 = function
        content.push(0x00);
        content.push(...encodeULEB128(imp.typeIndex));
      }
      sections.push(this._encodeSection(WASM_SECTION.IMPORT, content));
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

    // Table section (between function and memory)
    if (this.table) {
      const content = [];
      content.push(...encodeULEB128(1)); // 1 table
      content.push(0x70); // funcref element type
      if (this.table.max !== undefined) {
        content.push(0x01); // has max
        content.push(...encodeULEB128(this.table.min));
        content.push(...encodeULEB128(this.table.max));
      } else {
        content.push(0x00); // no max
        content.push(...encodeULEB128(this.table.min));
      }
      sections.push(this._encodeSection(WASM_SECTION.TABLE, content));
    }

    // Memory section (between function and export)
    if (this.memory) {
      const content = [];
      content.push(...encodeULEB128(1)); // 1 memory
      if (this.memory.max !== undefined) {
        content.push(0x01); // has max
        content.push(...encodeULEB128(this.memory.min));
        content.push(...encodeULEB128(this.memory.max));
      } else {
        content.push(0x00); // no max
        content.push(...encodeULEB128(this.memory.min));
      }
      sections.push(this._encodeSection(WASM_SECTION.MEMORY, content));
    }

    // Global section
    if (this.globals.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.globals.length));
      for (const g of this.globals) {
        content.push(g.type);        // value type
        content.push(g.mutable ? 0x01 : 0x00); // mutability
        content.push(...g.initExpr); // init expression
      }
      sections.push(this._encodeSection(WASM_SECTION.GLOBAL, content));
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

    // Element section (populates table with function references)
    if (this.elements.length > 0) {
      const content = [];
      content.push(...encodeULEB128(1)); // 1 element segment
      content.push(0x00); // table index 0
      // offset expression: i32.const 0 end
      content.push(WasmOp.i32_const, ...encodeSLEB128(0), WasmOp.end);
      // function indices
      content.push(...encodeULEB128(this.elements.length));
      for (const funcIdx of this.elements) {
        content.push(...encodeULEB128(funcIdx));
      }
      sections.push(this._encodeSection(WASM_SECTION.ELEMENT, content));
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

    // Data section
    if (this.dataSegments.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.dataSegments.length));
      for (const seg of this.dataSegments) {
        content.push(0x00); // active segment, memory 0
        // offset expression: i32.const <offset> end
        content.push(WasmOp.i32_const);
        content.push(...encodeSLEB128(seg.offset));
        content.push(WasmOp.end);
        // data bytes
        content.push(...encodeULEB128(seg.data.length));
        content.push(...seg.data);
      }
      sections.push(this._encodeSection(WASM_SECTION.DATA, content));
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

export { WasmModule, WasmOp, WASM_TYPE, encodeULEB128, encodeSLEB128, encodeF64, encodeF32 };
