// WASM Binary Encoder for Monkey Language
// Constructs valid WebAssembly binary modules from scratch.
// Reference: https://webassembly.github.io/spec/core/binary/

// === LEB128 Encoding ===

function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function encodeSLEB128(value) {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 0x7f;
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

function encodeString(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  return [...encodeULEB128(bytes.length), ...bytes];
}

// === WASM Value Types ===
export const ValType = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
  funcref: 0x70,
  externref: 0x6f,
  // GC reference types
  anyref: 0x6e,
  eqref: 0x6d,
  i31ref: 0x6c,
  structref: 0x6b,
  arrayref: 0x6a,
  nullref: 0x71,
};

// GC type definition kinds (used in type section)
export const TypeKind = {
  func: 0x60,
  struct: 0x5f,
  array: 0x5e,
};

// === WASM Opcodes ===
export const Op = {
  // Control
  unreachable: 0x00,
  nop: 0x01,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  br_table: 0x0e,
  return: 0x0f,
  call: 0x10,
  call_indirect: 0x11,
  
  // Exception handling
  try_: 0x06,
  catch_: 0x07,
  throw_: 0x08,
  rethrow: 0x09,
  delegate: 0x18,
  catch_all: 0x19,

  // Parametric
  drop: 0x1a,
  select: 0x1b,

  // Variable
  local_get: 0x20,
  local_set: 0x21,
  local_tee: 0x22,
  global_get: 0x23,
  global_set: 0x24,

  // Memory
  i32_load: 0x28,
  i64_load: 0x29,
  f32_load: 0x2a,
  f64_load: 0x2b,
  i32_store: 0x36,
  i64_store: 0x37,
  f32_store: 0x38,
  f64_store: 0x39,
  i32_load8_s: 0x2c,
  i32_load8_u: 0x2d,
  i32_load16_s: 0x2e,
  i32_load16_u: 0x2f,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  memory_size: 0x3f,
  memory_grow: 0x40,

  // Constants
  i32_const: 0x41,
  i64_const: 0x42,
  f32_const: 0x43,
  f64_const: 0x44,

  // i32 comparison
  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_lt_u: 0x49,
  i32_gt_s: 0x4a,
  i32_gt_u: 0x4b,
  i32_le_s: 0x4c,
  i32_le_u: 0x4d,
  i32_ge_s: 0x4e,
  i32_ge_u: 0x4f,

  // i32 arithmetic
  i32_clz: 0x67,
  i32_ctz: 0x68,
  i32_popcnt: 0x69,
  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_div_u: 0x6e,
  i32_rem_s: 0x6f,
  i32_rem_u: 0x70,
  i32_and: 0x71,
  i32_or: 0x72,
  i32_xor: 0x73,
  i32_shl: 0x74,
  i32_shr_s: 0x75,
  i32_shr_u: 0x76,
  i32_rotl: 0x77,
  i32_rotr: 0x78,

  // f64 comparison
  f64_eq: 0x61,
  f64_ne: 0x62,
  f64_lt: 0x63,
  f64_gt: 0x64,
  f64_le: 0x65,
  f64_ge: 0x66,

  // f64 arithmetic
  f64_abs: 0x99,
  f64_neg: 0x9a,
  f64_ceil: 0x9b,
  f64_floor: 0x9c,
  f64_trunc: 0x9d,
  f64_sqrt: 0x9f,
  f64_add: 0xa0,
  f64_sub: 0xa1,
  f64_mul: 0xa2,
  f64_div: 0xa3,
  f64_min: 0xa4,
  f64_max: 0xa5,

  // Conversions
  i32_trunc_f64_s: 0xaa,
  f64_convert_i32_s: 0xb7,
  i32_wrap_i64: 0xa7,
  i64_extend_i32_s: 0xac,
};

// GC opcodes (all prefixed with 0xfb)
export const GcOp = {
  prefix: 0xfb,
  struct_new: 0x00,
  struct_new_default: 0x01,
  struct_get: 0x02,
  struct_get_s: 0x03,
  struct_get_u: 0x04,
  struct_set: 0x05,
  array_new: 0x06,
  array_new_default: 0x07,
  array_new_fixed: 0x08,
  array_new_data: 0x09,
  array_new_elem: 0x0a,
  array_get: 0x0b,
  array_get_s: 0x0c,
  array_get_u: 0x0d,
  array_set: 0x0e,
  array_len: 0x0f,
  array_fill: 0x10,
  array_copy: 0x11,
  ref_cast: 0x17,
  ref_cast_null: 0x18,
  ref_test: 0x14,
  ref_test_null: 0x15,
  ref_i31: 0x1c,
  i31_get_s: 0x1d,
  i31_get_u: 0x1e,
  extern_internalize: 0x1a,
  extern_externalize: 0x1b,
};

// === Section IDs ===
const Section = {
  Custom: 0,
  Type: 1,
  Import: 2,
  Function: 3,
  Table: 4,
  Memory: 5,
  Global: 6,
  Export: 7,
  Start: 8,
  Element: 9,
  Code: 10,
  Data: 11,
  DataCount: 12,
  Tag: 13,
};

// === Ref Type Helpers ===
/** Create a non-nullable ref type: (ref $typeIdx) */
export function refType(typeIdx) { return { ref: typeIdx, nullable: false }; }
/** Create a nullable ref type: (ref null $typeIdx) */
export function refNullType(typeIdx) { return { ref: typeIdx, nullable: true }; }

// === Export Kinds ===
export const ExportKind = {
  Func: 0x00,
  Table: 0x01,
  Memory: 0x02,
  Global: 0x03,
};

// === Function Body Builder ===

export class FuncBodyBuilder {
  constructor() {
    this.locals = [];    // [{type, count}]
    this.code = [];      // raw bytes
    this.sourceMap = [];  // [{offset, line}] — source line tracking
    this.callSites = [];  // [{offset, kind}] — tracks positions of call/call_indirect instructions
    this._currentLine = 0;
  }

  setSourceLine(line) {
    this._currentLine = line;
  }

  addLocal(type, count = 1) {
    this.locals.push({ type, count });
  }

  emit(opcode, ...operands) {
    if (this._currentLine > 0) {
      this.sourceMap.push({ offset: this.code.length, line: this._currentLine });
    }
    this.code.push(opcode);
    for (const op of operands) {
      if (Array.isArray(op)) {
        this.code.push(...op);
      } else {
        this.code.push(op);
      }
    }
    return this;
  }

  i32Const(value) {
    return this.emit(Op.i32_const, ...encodeSLEB128(value));
  }

  f64Const(value) {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    return this.emit(Op.f64_const, ...new Uint8Array(buf));
  }

  localGet(index) { return this.emit(Op.local_get, ...encodeULEB128(index)); }
  localSet(index) { return this.emit(Op.local_set, ...encodeULEB128(index)); }
  localTee(index) { return this.emit(Op.local_tee, ...encodeULEB128(index)); }
  globalGet(index) { return this.emit(Op.global_get, ...encodeULEB128(index)); }
  globalSet(index) { return this.emit(Op.global_set, ...encodeULEB128(index)); }

  call(funcIndex) {
    const offset = this.code.length;
    this.emit(Op.call, ...encodeULEB128(funcIndex));
    this.callSites.push({ offset, kind: 'call' });
    return this;
  }

  callIndirect(typeIndex, tableIndex = 0) {
    const offset = this.code.length;
    this.emit(Op.call_indirect, ...encodeULEB128(typeIndex), ...encodeULEB128(tableIndex));
    this.callSites.push({ offset, kind: 'call_indirect' });
    return this;
  }

  // Control flow helpers
  block(blockType = 0x40) { return this.emit(Op.block, blockType); }
  loop(blockType = 0x40) { return this.emit(Op.loop, blockType); }
  if_(blockType = 0x40) { return this.emit(Op.if, blockType); }
  
  // Exception handling
  try_(blockType = 0x40) { return this.emit(Op.try_, blockType); }
  catch_(tagIndex) { return this.emit(Op.catch_, ...encodeULEB128(tagIndex)); }
  catchAll() { return this.emit(Op.catch_all); }
  throw_(tagIndex) { return this.emit(Op.throw_, ...encodeULEB128(tagIndex)); }
  rethrow(depth) { return this.emit(Op.rethrow, ...encodeULEB128(depth)); }
  else_() { return this.emit(Op.else); }
  end() { return this.emit(Op.end); }
  br(labelIndex) { return this.emit(Op.br, ...encodeULEB128(labelIndex)); }
  brIf(labelIndex) { return this.emit(Op.br_if, ...encodeULEB128(labelIndex)); }
  return_() { return this.emit(Op.return); }
  drop() { return this.emit(Op.drop); }

  // Memory helpers (align=2 for i32, align=3 for f64)
  i32Load(offset = 0, align = 2) {
    return this.emit(Op.i32_load, ...encodeULEB128(align), ...encodeULEB128(offset));
  }
  i32Store(offset = 0, align = 2) {
    return this.emit(Op.i32_store, ...encodeULEB128(align), ...encodeULEB128(offset));
  }

  encode() {
    // Locals declaration
    const localBytes = [];
    localBytes.push(...encodeULEB128(this.locals.length));
    for (const { type, count } of this.locals) {
      localBytes.push(...encodeULEB128(count));
      if (typeof type === 'object' && type.ref !== undefined) {
        // GC ref type: (ref $typeIdx) = 0x64 typeIdx, (ref null $typeIdx) = 0x63 typeIdx
        localBytes.push(type.nullable ? 0x63 : 0x64);
        localBytes.push(...encodeULEB128(type.ref));
      } else {
        localBytes.push(type);
      }
    }
    // Body = locals + code + end
    const body = [...localBytes, ...this.code, Op.end];
    return [...encodeULEB128(body.length), ...body];
  }
}

// === WASM Module Builder ===

export class WasmModuleBuilder {
  constructor() {
    this.types = [];     // function signatures [{params: [ValType], results: [ValType]}]
    this.imports = [];   // [{module, name, kind, typeIndex}]
    this.functions = []; // [{typeIndex, body: FuncBodyBuilder}]
    this.memories = [];  // [{min, max?}]
    this.globals = [];   // [{type, mutable, initValue}]
    this.exports = [];   // [{name, kind, index}]
    this.tables = [];    // [{type, min, max?}]
    this.elements = [];  // [{tableIndex, offset, funcIndices}]
    this.dataSegments = []; // [{offset, bytes}]
    this.tags = [];        // [{attribute, typeIndex}] — exception handling
    this._typeCache = new Map();
  }

  // Get source maps for all functions
  getSourceMaps() {
    const maps = {};
    for (let i = 0; i < this.functions.length; i++) {
      const func = this.functions[i];
      if (func.body && func.body.sourceMap && func.body.sourceMap.length > 0) {
        const funcIdx = this.imports.length + i;
        maps[funcIdx] = func.body.sourceMap;
      }
    }
    return maps;
  }

  // Add or reuse a function type signature. Returns the type index.
  addType(params, results) {
    const key = `${params.join(',')}->${results.join(',')}`;
    if (this._typeCache.has(key)) return this._typeCache.get(key);
    const idx = this.types.length;
    this.types.push({ kind: 'func', params, results });
    this._typeCache.set(key, idx);
    return idx;
  }

  /**
   * Add a struct type definition.
   * @param {Array<{type: number, mutable: boolean}>} fields - struct fields
   * @returns {number} type index
   */
  addStructType(fields) {
    const idx = this.types.length;
    this.types.push({ kind: 'struct', fields });
    return idx;
  }

  /**
   * Add an array type definition.
   * @param {number} elemType - ValType of elements
   * @param {boolean} mutable - whether elements are mutable
   * @returns {number} type index
   */
  addArrayType(elemType, mutable = true) {
    const idx = this.types.length;
    this.types.push({ kind: 'array', elemType, mutable });
    return idx;
  }

  // Add a function import. Returns the function index.
  addImport(module, name, params, results) {
    const typeIndex = this.addType(params, results);
    const idx = this.imports.length; // imports come first in function index space
    this.imports.push({ module, name, kind: 0x00, typeIndex });
    return idx;
  }

  // Add a function. Returns the function index (imports.length + functions.length - 1).
  addFunction(params, results) {
    const typeIndex = this.addType(params, results);
    const body = new FuncBodyBuilder();
    const idx = this.imports.length + this.functions.length;
    this.functions.push({ typeIndex, body });
    return { index: idx, body };
  }

  // Add a memory (min pages, optional max pages). Returns memory index.
  addMemory(min, max) {
    const idx = this.memories.length;
    this.memories.push({ min, max });
    return idx;
  }

  // Add a mutable global. Returns global index.
  addGlobal(type, mutable, initValue = 0) {
    const idx = this.globals.length;
    this.globals.push({ type, mutable, initValue });
    return idx;
  }

  // Add a tag (for exception handling). Returns the tag index.
  addTag(typeIndex) {
    const idx = this.tags.length;
    this.tags.push({ attribute: 0, typeIndex }); // attribute 0 = exception
    return idx;
  }

  // Add an export.
  addExport(name, kind, index) {
    this.exports.push({ name, kind, index });
  }

  // Add a table (for funcref, call_indirect). Returns table index.
  addTable(type, min, max) {
    const idx = this.tables.length;
    this.tables.push({ type: type || ValType.funcref, min, max });
    return idx;
  }

  // Add an element segment (initializes table entries).
  addElement(tableIndex, offset, funcIndices) {
    this.elements.push({ tableIndex, offset, funcIndices });
  }

  // Add a data segment (at a fixed offset in memory).
  addDataSegment(offset, bytes) {
    this.dataSegments.push({ offset, bytes: Array.isArray(bytes) ? bytes : [...bytes] });
  }

  // Remove unused imports and renumber all function references.
  stripUnusedImports() {
    if (this.imports.length === 0) return;

    const numImports = this.imports.length;
    const usedImports = new Set();

    // Helper: decode ULEB128 at position in bytes array, return { value, bytesRead }
    function decodeULEB128(bytes, pos) {
      let result = 0, shift = 0, byte;
      let bytesRead = 0;
      do {
        byte = bytes[pos + bytesRead];
        result |= (byte & 0x7f) << shift;
        shift += 7;
        bytesRead++;
      } while (byte & 0x80);
      return { value: result, bytesRead };
    }

    // Scan all function bodies for call instructions using tracked callSites
    for (const func of this.functions) {
      const bytes = func.body.code;
      for (const site of func.body.callSites) {
        if (site.kind === 'call') {
          const { value: funcIdx } = decodeULEB128(bytes, site.offset + 1);
          if (funcIdx < numImports) {
            usedImports.add(funcIdx);
          }
        }
      }
    }

    // Check exports
    for (const exp of this.exports) {
      if (exp.kind === ExportKind.Func && exp.index < numImports) {
        usedImports.add(exp.index);
      }
    }

    // Check element segments
    for (const elem of this.elements) {
      for (const idx of elem.funcIndices) {
        if (idx < numImports) {
          usedImports.add(idx);
        }
      }
    }

    // Build remap table: old index → new index
    const remap = new Array(numImports + this.functions.length);
    const keptImports = [];
    let newImportIdx = 0;
    for (let i = 0; i < numImports; i++) {
      if (usedImports.has(i)) {
        remap[i] = newImportIdx;
        keptImports.push(this.imports[i]);
        newImportIdx++;
      } else {
        remap[i] = -1; // removed
      }
    }

    // Renumber local functions
    for (let i = 0; i < this.functions.length; i++) {
      remap[numImports + i] = newImportIdx + i;
    }

    if (keptImports.length === numImports) return; // nothing to strip

    // Update imports
    this.imports = keptImports;

    // Renumber call targets in all function bodies using tracked callSites
    // Process sites in reverse order so earlier offsets remain valid
    for (const func of this.functions) {
      const code = func.body.code;
      // Sort callSites by offset descending for safe in-place replacement
      const sites = [...func.body.callSites].sort((a, b) => b.offset - a.offset);
      for (const site of sites) {
        if (site.kind === 'call') {
          const { value: funcIdx, bytesRead } = decodeULEB128(code, site.offset + 1);
          const newIdx = remap[funcIdx];
          const newEncoded = encodeULEB128(newIdx !== undefined ? newIdx : funcIdx);
          code.splice(site.offset + 1, bytesRead, ...newEncoded);
        } else if (site.kind === 'call_indirect') {
          // call_indirect operands: typeIndex (unchanged), tableIndex (unchanged)
          // But function references in call_indirect are via table, not direct — no renumbering needed
        }
      }
      // Update callSite offsets (rebuild from scratch since splicing may have shifted them)
      // We don't need to update them since we won't scan again, but clear them to be safe
    }

    // Renumber exports
    for (const exp of this.exports) {
      if (exp.kind === ExportKind.Func) {
        const newIdx = remap[exp.index];
        if (newIdx !== undefined && newIdx >= 0) exp.index = newIdx;
      }
    }

    // Renumber element segments
    for (const elem of this.elements) {
      elem.funcIndices = elem.funcIndices.map(idx => {
        const newIdx = remap[idx];
        return (newIdx !== undefined && newIdx >= 0) ? newIdx : idx;
      });
    }
  }

  // Build the complete WASM binary.
  build() {
    // Strip unused imports to reduce binary size
    this.stripUnusedImports();

    const sections = [];

    // Type section
    if (this.types.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.types.length));
      for (const typeDef of this.types) {
        if (typeDef.kind === 'func' || !typeDef.kind) {
          // Function type: 0x60 [params] [results]
          bytes.push(0x60);
          bytes.push(...encodeULEB128(typeDef.params.length));
          bytes.push(...typeDef.params);
          bytes.push(...encodeULEB128(typeDef.results.length));
          bytes.push(...typeDef.results);
        } else if (typeDef.kind === 'struct') {
          // Struct type: 0x5f [field_count] [fields...]
          // Each field: [valtype] [mutability: 0x00=const, 0x01=var]
          bytes.push(0x5f);
          bytes.push(...encodeULEB128(typeDef.fields.length));
          for (const field of typeDef.fields) {
            // Encode field type (may be ref type which needs special encoding)
            if (typeof field.type === 'object' && field.type.ref !== undefined) {
              // (ref $typeIdx) = 0x64 typeIdx or (ref null $typeIdx) = 0x63 typeIdx
              bytes.push(field.type.nullable ? 0x63 : 0x64);
              bytes.push(...encodeULEB128(field.type.ref));
            } else {
              bytes.push(field.type);
            }
            bytes.push(field.mutable ? 0x01 : 0x00);
          }
        } else if (typeDef.kind === 'array') {
          // Array type: 0x5e [valtype] [mutability]
          bytes.push(0x5e);
          if (typeof typeDef.elemType === 'object' && typeDef.elemType.ref !== undefined) {
            bytes.push(typeDef.elemType.nullable ? 0x63 : 0x64);
            bytes.push(...encodeULEB128(typeDef.elemType.ref));
          } else {
            bytes.push(typeDef.elemType);
          }
          bytes.push(typeDef.mutable ? 0x01 : 0x00);
        }
      }
      sections.push(this._makeSection(Section.Type, bytes));
    }

    // Import section
    if (this.imports.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.imports.length));
      for (const { module, name, kind, typeIndex } of this.imports) {
        bytes.push(...encodeString(module));
        bytes.push(...encodeString(name));
        bytes.push(kind); // 0x00 = function
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Import, bytes));
    }

    // Function section (type indices for locally-defined functions)
    if (this.functions.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.functions.length));
      for (const { typeIndex } of this.functions) {
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Function, bytes));
    }

    // Table section (must come before Memory - section ID 4)
    if (this.tables.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.tables.length));
      for (const { type, min, max } of this.tables) {
        bytes.push(type); // element type (funcref = 0x70)
        if (max !== undefined) {
          bytes.push(0x01);
          bytes.push(...encodeULEB128(min));
          bytes.push(...encodeULEB128(max));
        } else {
          bytes.push(0x00);
          bytes.push(...encodeULEB128(min));
        }
      }
      sections.push(this._makeSection(Section.Table, bytes));
    }

    // Memory section (section ID 5)
    if (this.memories.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.memories.length));
      for (const { min, max } of this.memories) {
        if (max !== undefined) {
          bytes.push(0x01); // has max
          bytes.push(...encodeULEB128(min));
          bytes.push(...encodeULEB128(max));
        } else {
          bytes.push(0x00); // no max
          bytes.push(...encodeULEB128(min));
        }
      }
      sections.push(this._makeSection(Section.Memory, bytes));
    }

    // Tag section (exception handling, must come before Global)
    if (this.tags.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.tags.length));
      for (const { attribute, typeIndex } of this.tags) {
        bytes.push(attribute); // 0x00 = exception
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Tag, bytes));
    }

    // Global section
    if (this.globals.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.globals.length));
      for (const { type, mutable, initValue } of this.globals) {
        bytes.push(type);
        bytes.push(mutable ? 0x01 : 0x00);
        // init expression: i32.const value, end
        if (type === ValType.i32) {
          bytes.push(Op.i32_const, ...encodeSLEB128(initValue), Op.end);
        } else if (type === ValType.f64) {
          const buf = new ArrayBuffer(8);
          new Float64Array(buf)[0] = initValue;
          bytes.push(Op.f64_const, ...new Uint8Array(buf), Op.end);
        }
      }
      sections.push(this._makeSection(Section.Global, bytes));
    }

    // Export section
    if (this.exports.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.exports.length));
      for (const { name, kind, index } of this.exports) {
        bytes.push(...encodeString(name));
        bytes.push(kind);
        bytes.push(...encodeULEB128(index));
      }
      sections.push(this._makeSection(Section.Export, bytes));
    }

    // Element section (table initialization)
    if (this.elements.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.elements.length));
      for (const { tableIndex, offset, funcIndices } of this.elements) {
        bytes.push(0x00); // active element, table index 0 (implicit)
        bytes.push(Op.i32_const, ...encodeSLEB128(offset), Op.end); // offset expr
        bytes.push(...encodeULEB128(funcIndices.length));
        for (const fi of funcIndices) {
          bytes.push(...encodeULEB128(fi));
        }
      }
      sections.push(this._makeSection(Section.Element, bytes));
    }

    // Code section
    if (this.functions.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.functions.length));
      for (const { body } of this.functions) {
        bytes.push(...body.encode());
      }
      sections.push(this._makeSection(Section.Code, bytes));
    }

    // Data section
    if (this.dataSegments.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.dataSegments.length));
      for (const { offset, bytes: data } of this.dataSegments) {
        bytes.push(0x00); // active segment, memory index 0
        bytes.push(Op.i32_const, ...encodeSLEB128(offset), Op.end);
        bytes.push(...encodeULEB128(data.length));
        bytes.push(...data);
      }
      sections.push(this._makeSection(Section.Data, bytes));
    }

    // Assemble: magic + version + sections
    const module = [
      0x00, 0x61, 0x73, 0x6d, // magic: \0asm
      0x01, 0x00, 0x00, 0x00, // version: 1
    ];
    for (const section of sections) {
      module.push(...section);
    }

    return new Uint8Array(module);
  }

  _makeSection(id, bytes) {
    return [id, ...encodeULEB128(bytes.length), ...bytes];
  }
}

// === Utility: Compile and instantiate a module ===

export async function instantiateModule(builder, imports = {}) {
  const binary = builder.build();
  const module = await WebAssembly.compile(binary);
  return WebAssembly.instantiate(module, imports);
}

// Export encoding utils for tests
export { encodeULEB128, encodeSLEB128, encodeString };
