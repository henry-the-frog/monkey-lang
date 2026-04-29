// projects/monkey-lang/src/wasm.js
function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value !== 0) byte |= 128;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}
function encodeSLEB128(value) {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 127;
    value >>= 7;
    if (value === 0 && (byte & 64) === 0 || value === -1 && (byte & 64) !== 0) {
      more = false;
    } else {
      byte |= 128;
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
var ValType = {
  i32: 127,
  i64: 126,
  f32: 125,
  f64: 124,
  funcref: 112,
  externref: 111,
  // GC reference types
  anyref: 110,
  eqref: 109,
  i31ref: 108,
  structref: 107,
  arrayref: 106,
  nullref: 113
};
var Op = {
  // Control
  unreachable: 0,
  nop: 1,
  block: 2,
  loop: 3,
  if: 4,
  else: 5,
  end: 11,
  br: 12,
  br_if: 13,
  br_table: 14,
  return: 15,
  call: 16,
  call_indirect: 17,
  // Exception handling
  try_: 6,
  catch_: 7,
  throw_: 8,
  rethrow: 9,
  delegate: 24,
  catch_all: 25,
  // Parametric
  drop: 26,
  select: 27,
  // Variable
  local_get: 32,
  local_set: 33,
  local_tee: 34,
  global_get: 35,
  global_set: 36,
  // Memory
  i32_load: 40,
  i64_load: 41,
  f32_load: 42,
  f64_load: 43,
  i32_store: 54,
  i64_store: 55,
  f32_store: 56,
  f64_store: 57,
  i32_load8_s: 44,
  i32_load8_u: 45,
  i32_load16_s: 46,
  i32_load16_u: 47,
  i32_store8: 58,
  i32_store16: 59,
  memory_size: 63,
  memory_grow: 64,
  // Constants
  i32_const: 65,
  i64_const: 66,
  f32_const: 67,
  f64_const: 68,
  // i32 comparison
  i32_eqz: 69,
  i32_eq: 70,
  i32_ne: 71,
  i32_lt_s: 72,
  i32_lt_u: 73,
  i32_gt_s: 74,
  i32_gt_u: 75,
  i32_le_s: 76,
  i32_le_u: 77,
  i32_ge_s: 78,
  i32_ge_u: 79,
  // i32 arithmetic
  i32_clz: 103,
  i32_ctz: 104,
  i32_popcnt: 105,
  i32_add: 106,
  i32_sub: 107,
  i32_mul: 108,
  i32_div_s: 109,
  i32_div_u: 110,
  i32_rem_s: 111,
  i32_rem_u: 112,
  i32_and: 113,
  i32_or: 114,
  i32_xor: 115,
  i32_shl: 116,
  i32_shr_s: 117,
  i32_shr_u: 118,
  i32_rotl: 119,
  i32_rotr: 120,
  // f64 comparison
  f64_eq: 97,
  f64_ne: 98,
  f64_lt: 99,
  f64_gt: 100,
  f64_le: 101,
  f64_ge: 102,
  // f64 arithmetic
  f64_abs: 153,
  f64_neg: 154,
  f64_ceil: 155,
  f64_floor: 156,
  f64_trunc: 157,
  f64_sqrt: 159,
  f64_add: 160,
  f64_sub: 161,
  f64_mul: 162,
  f64_div: 163,
  f64_min: 164,
  f64_max: 165,
  // Conversions
  i32_trunc_f64_s: 170,
  f64_convert_i32_s: 183,
  i32_wrap_i64: 167,
  i64_extend_i32_s: 172
};
var GcOp = {
  prefix: 251,
  struct_new: 0,
  struct_new_default: 1,
  struct_get: 2,
  struct_get_s: 3,
  struct_get_u: 4,
  struct_set: 5,
  array_new: 6,
  array_new_default: 7,
  array_new_fixed: 8,
  array_new_data: 9,
  array_new_elem: 10,
  array_get: 11,
  array_get_s: 12,
  array_get_u: 13,
  array_set: 14,
  array_len: 15,
  array_fill: 16,
  array_copy: 17,
  ref_cast: 23,
  ref_cast_null: 24,
  ref_test: 20,
  ref_test_null: 21,
  ref_i31: 28,
  i31_get_s: 29,
  i31_get_u: 30,
  extern_internalize: 26,
  extern_externalize: 27
};
var Section = {
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
  Tag: 13
};
var ExportKind = {
  Func: 0,
  Table: 1,
  Memory: 2,
  Global: 3
};
var FuncBodyBuilder = class {
  constructor() {
    this.locals = [];
    this.code = [];
    this.sourceMap = [];
    this.callSites = [];
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
  localGet(index) {
    return this.emit(Op.local_get, ...encodeULEB128(index));
  }
  localSet(index) {
    return this.emit(Op.local_set, ...encodeULEB128(index));
  }
  localTee(index) {
    return this.emit(Op.local_tee, ...encodeULEB128(index));
  }
  globalGet(index) {
    return this.emit(Op.global_get, ...encodeULEB128(index));
  }
  globalSet(index) {
    return this.emit(Op.global_set, ...encodeULEB128(index));
  }
  call(funcIndex) {
    const offset = this.code.length;
    this.emit(Op.call, ...encodeULEB128(funcIndex));
    this.callSites.push({ offset, kind: "call" });
    return this;
  }
  callIndirect(typeIndex, tableIndex = 0) {
    const offset = this.code.length;
    this.emit(Op.call_indirect, ...encodeULEB128(typeIndex), ...encodeULEB128(tableIndex));
    this.callSites.push({ offset, kind: "call_indirect" });
    return this;
  }
  // Control flow helpers
  block(blockType = 64) {
    return this.emit(Op.block, blockType);
  }
  loop(blockType = 64) {
    return this.emit(Op.loop, blockType);
  }
  if_(blockType = 64) {
    return this.emit(Op.if, blockType);
  }
  // Exception handling
  try_(blockType = 64) {
    return this.emit(Op.try_, blockType);
  }
  catch_(tagIndex) {
    return this.emit(Op.catch_, ...encodeULEB128(tagIndex));
  }
  catchAll() {
    return this.emit(Op.catch_all);
  }
  throw_(tagIndex) {
    return this.emit(Op.throw_, ...encodeULEB128(tagIndex));
  }
  rethrow(depth) {
    return this.emit(Op.rethrow, ...encodeULEB128(depth));
  }
  else_() {
    return this.emit(Op.else);
  }
  end() {
    return this.emit(Op.end);
  }
  br(labelIndex) {
    return this.emit(Op.br, ...encodeULEB128(labelIndex));
  }
  brIf(labelIndex) {
    return this.emit(Op.br_if, ...encodeULEB128(labelIndex));
  }
  return_() {
    return this.emit(Op.return);
  }
  drop() {
    return this.emit(Op.drop);
  }
  // === GC Instructions ===
  // Struct operations
  structNew(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.struct_new, ...encodeULEB128(typeIdx));
  }
  structNewDefault(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.struct_new_default, ...encodeULEB128(typeIdx));
  }
  structGet(typeIdx, fieldIdx) {
    return this.emit(GcOp.prefix, GcOp.struct_get, ...encodeULEB128(typeIdx), ...encodeULEB128(fieldIdx));
  }
  structSet(typeIdx, fieldIdx) {
    return this.emit(GcOp.prefix, GcOp.struct_set, ...encodeULEB128(typeIdx), ...encodeULEB128(fieldIdx));
  }
  // Array operations
  arrayNew(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.array_new, ...encodeULEB128(typeIdx));
  }
  arrayNewDefault(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.array_new_default, ...encodeULEB128(typeIdx));
  }
  arrayNewFixed(typeIdx, length) {
    return this.emit(GcOp.prefix, GcOp.array_new_fixed, ...encodeULEB128(typeIdx), ...encodeULEB128(length));
  }
  arrayGet(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.array_get, ...encodeULEB128(typeIdx));
  }
  arraySet(typeIdx) {
    return this.emit(GcOp.prefix, GcOp.array_set, ...encodeULEB128(typeIdx));
  }
  arrayLen() {
    return this.emit(GcOp.prefix, GcOp.array_len);
  }
  // i31ref operations
  refI31() {
    return this.emit(GcOp.prefix, GcOp.ref_i31);
  }
  i31GetS() {
    return this.emit(GcOp.prefix, GcOp.i31_get_s);
  }
  i31GetU() {
    return this.emit(GcOp.prefix, GcOp.i31_get_u);
  }
  // Ref cast/test
  refCast(heapType) {
    return this.emit(GcOp.prefix, GcOp.ref_cast, ...encodeULEB128(heapType));
  }
  refCastNull(heapType) {
    return this.emit(GcOp.prefix, GcOp.ref_cast_null, ...encodeULEB128(heapType));
  }
  refTest(heapType) {
    return this.emit(GcOp.prefix, GcOp.ref_test, ...encodeULEB128(heapType));
  }
  // Memory helpers (align=2 for i32, align=3 for f64)
  i32Load(offset = 0, align = 2) {
    return this.emit(Op.i32_load, ...encodeULEB128(align), ...encodeULEB128(offset));
  }
  i32Store(offset = 0, align = 2) {
    return this.emit(Op.i32_store, ...encodeULEB128(align), ...encodeULEB128(offset));
  }
  encode() {
    const localBytes = [];
    localBytes.push(...encodeULEB128(this.locals.length));
    for (const { type, count } of this.locals) {
      localBytes.push(...encodeULEB128(count));
      if (typeof type === "object" && type.ref !== void 0) {
        localBytes.push(type.nullable ? 99 : 100);
        localBytes.push(...encodeULEB128(type.ref));
      } else {
        localBytes.push(type);
      }
    }
    const body = [...localBytes, ...this.code, Op.end];
    return [...encodeULEB128(body.length), ...body];
  }
};
var WasmModuleBuilder = class {
  constructor() {
    this.types = [];
    this.imports = [];
    this.functions = [];
    this.memories = [];
    this.globals = [];
    this.exports = [];
    this.tables = [];
    this.elements = [];
    this.dataSegments = [];
    this.tags = [];
    this._typeCache = /* @__PURE__ */ new Map();
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
    const key = `${params.join(",")}->${results.join(",")}`;
    if (this._typeCache.has(key)) return this._typeCache.get(key);
    const idx = this.types.length;
    this.types.push({ kind: "func", params, results });
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
    this.types.push({ kind: "struct", fields });
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
    this.types.push({ kind: "array", elemType, mutable });
    return idx;
  }
  // Add a function import. Returns the function index.
  addImport(module, name, params, results) {
    const typeIndex = this.addType(params, results);
    const idx = this.imports.length;
    this.imports.push({ module, name, kind: 0, typeIndex });
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
    this.tags.push({ attribute: 0, typeIndex });
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
    const usedImports = /* @__PURE__ */ new Set();
    function decodeULEB128(bytes, pos) {
      let result = 0, shift = 0, byte;
      let bytesRead = 0;
      do {
        byte = bytes[pos + bytesRead];
        result |= (byte & 127) << shift;
        shift += 7;
        bytesRead++;
      } while (byte & 128);
      return { value: result, bytesRead };
    }
    for (const func of this.functions) {
      const bytes = func.body.code;
      for (const site of func.body.callSites) {
        if (site.kind === "call") {
          const { value: funcIdx } = decodeULEB128(bytes, site.offset + 1);
          if (funcIdx < numImports) {
            usedImports.add(funcIdx);
          }
        }
      }
    }
    for (const exp of this.exports) {
      if (exp.kind === ExportKind.Func && exp.index < numImports) {
        usedImports.add(exp.index);
      }
    }
    for (const elem of this.elements) {
      for (const idx of elem.funcIndices) {
        if (idx < numImports) {
          usedImports.add(idx);
        }
      }
    }
    const remap = new Array(numImports + this.functions.length);
    const keptImports = [];
    let newImportIdx = 0;
    for (let i = 0; i < numImports; i++) {
      if (usedImports.has(i)) {
        remap[i] = newImportIdx;
        keptImports.push(this.imports[i]);
        newImportIdx++;
      } else {
        remap[i] = -1;
      }
    }
    for (let i = 0; i < this.functions.length; i++) {
      remap[numImports + i] = newImportIdx + i;
    }
    if (keptImports.length === numImports) return;
    this.imports = keptImports;
    for (const func of this.functions) {
      const code = func.body.code;
      const sites = [...func.body.callSites].sort((a, b) => b.offset - a.offset);
      for (const site of sites) {
        if (site.kind === "call") {
          const { value: funcIdx, bytesRead } = decodeULEB128(code, site.offset + 1);
          const newIdx = remap[funcIdx];
          const newEncoded = encodeULEB128(newIdx !== void 0 ? newIdx : funcIdx);
          code.splice(site.offset + 1, bytesRead, ...newEncoded);
        } else if (site.kind === "call_indirect") {
        }
      }
    }
    for (const exp of this.exports) {
      if (exp.kind === ExportKind.Func) {
        const newIdx = remap[exp.index];
        if (newIdx !== void 0 && newIdx >= 0) exp.index = newIdx;
      }
    }
    for (const elem of this.elements) {
      elem.funcIndices = elem.funcIndices.map((idx) => {
        const newIdx = remap[idx];
        return newIdx !== void 0 && newIdx >= 0 ? newIdx : idx;
      });
    }
  }
  // Build the complete WASM binary.
  build() {
    this.stripUnusedImports();
    const sections = [];
    if (this.types.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.types.length));
      for (const typeDef of this.types) {
        if (typeDef.kind === "func" || !typeDef.kind) {
          bytes.push(96);
          bytes.push(...encodeULEB128(typeDef.params.length));
          bytes.push(...typeDef.params);
          bytes.push(...encodeULEB128(typeDef.results.length));
          bytes.push(...typeDef.results);
        } else if (typeDef.kind === "struct") {
          bytes.push(95);
          bytes.push(...encodeULEB128(typeDef.fields.length));
          for (const field of typeDef.fields) {
            if (typeof field.type === "object" && field.type.ref !== void 0) {
              bytes.push(field.type.nullable ? 99 : 100);
              bytes.push(...encodeULEB128(field.type.ref));
            } else {
              bytes.push(field.type);
            }
            bytes.push(field.mutable ? 1 : 0);
          }
        } else if (typeDef.kind === "array") {
          bytes.push(94);
          if (typeof typeDef.elemType === "object" && typeDef.elemType.ref !== void 0) {
            bytes.push(typeDef.elemType.nullable ? 99 : 100);
            bytes.push(...encodeULEB128(typeDef.elemType.ref));
          } else {
            bytes.push(typeDef.elemType);
          }
          bytes.push(typeDef.mutable ? 1 : 0);
        }
      }
      sections.push(this._makeSection(Section.Type, bytes));
    }
    if (this.imports.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.imports.length));
      for (const { module: module2, name, kind, typeIndex } of this.imports) {
        bytes.push(...encodeString(module2));
        bytes.push(...encodeString(name));
        bytes.push(kind);
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Import, bytes));
    }
    if (this.functions.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.functions.length));
      for (const { typeIndex } of this.functions) {
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Function, bytes));
    }
    if (this.tables.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.tables.length));
      for (const { type, min, max } of this.tables) {
        bytes.push(type);
        if (max !== void 0) {
          bytes.push(1);
          bytes.push(...encodeULEB128(min));
          bytes.push(...encodeULEB128(max));
        } else {
          bytes.push(0);
          bytes.push(...encodeULEB128(min));
        }
      }
      sections.push(this._makeSection(Section.Table, bytes));
    }
    if (this.memories.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.memories.length));
      for (const { min, max } of this.memories) {
        if (max !== void 0) {
          bytes.push(1);
          bytes.push(...encodeULEB128(min));
          bytes.push(...encodeULEB128(max));
        } else {
          bytes.push(0);
          bytes.push(...encodeULEB128(min));
        }
      }
      sections.push(this._makeSection(Section.Memory, bytes));
    }
    if (this.tags.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.tags.length));
      for (const { attribute, typeIndex } of this.tags) {
        bytes.push(attribute);
        bytes.push(...encodeULEB128(typeIndex));
      }
      sections.push(this._makeSection(Section.Tag, bytes));
    }
    if (this.globals.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.globals.length));
      for (const { type, mutable, initValue } of this.globals) {
        bytes.push(type);
        bytes.push(mutable ? 1 : 0);
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
    if (this.elements.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.elements.length));
      for (const { tableIndex, offset, funcIndices } of this.elements) {
        bytes.push(0);
        bytes.push(Op.i32_const, ...encodeSLEB128(offset), Op.end);
        bytes.push(...encodeULEB128(funcIndices.length));
        for (const fi of funcIndices) {
          bytes.push(...encodeULEB128(fi));
        }
      }
      sections.push(this._makeSection(Section.Element, bytes));
    }
    if (this.functions.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.functions.length));
      for (const { body } of this.functions) {
        bytes.push(...body.encode());
      }
      sections.push(this._makeSection(Section.Code, bytes));
    }
    if (this.dataSegments.length > 0) {
      const bytes = [];
      bytes.push(...encodeULEB128(this.dataSegments.length));
      for (const { offset, bytes: data } of this.dataSegments) {
        bytes.push(0);
        bytes.push(Op.i32_const, ...encodeSLEB128(offset), Op.end);
        bytes.push(...encodeULEB128(data.length));
        bytes.push(...data);
      }
      sections.push(this._makeSection(Section.Data, bytes));
    }
    const module = [
      0,
      97,
      115,
      109,
      // magic: \0asm
      1,
      0,
      0,
      0
      // version: 1
    ];
    for (const section of sections) {
      module.push(...section);
    }
    return new Uint8Array(module);
  }
  _makeSection(id, bytes) {
    return [id, ...encodeULEB128(bytes.length), ...bytes];
  }
};

// projects/monkey-lang/src/lexer.js
var TokenType = {
  // Literals
  INT: "INT",
  FLOAT: "FLOAT",
  STRING: "STRING",
  TEMPLATE_STRING: "TEMPLATE_STRING",
  // backtick string with ${} interpolation
  IDENT: "IDENT",
  // Operators
  ASSIGN: "=",
  PLUS: "+",
  MINUS: "-",
  BANG: "!",
  ASTERISK: "*",
  SLASH: "/",
  PERCENT: "%",
  LT: "<",
  GT: ">",
  LT_EQ: "<=",
  GT_EQ: ">=",
  AND: "&&",
  OR: "||",
  NULLISH: "??",
  OPTIONAL_CHAIN: "?.",
  DOT: ".",
  DOT_DOT: "..",
  ARROW: "=>",
  THIN_ARROW: "->",
  SPREAD: "...",
  PIPE: "|>",
  BAR: "|",
  EQ: "==",
  NOT_EQ: "!=",
  PLUS_ASSIGN: "+=",
  MINUS_ASSIGN: "-=",
  PLUS_PLUS: "++",
  MINUS_MINUS: "--",
  ASTERISK_ASSIGN: "*=",
  SLASH_ASSIGN: "/=",
  PERCENT_ASSIGN: "%=",
  // Delimiters
  COMMA: ",",
  SEMICOLON: ";",
  COLON: ":",
  QUESTION: "?",
  LPAREN: "(",
  RPAREN: ")",
  LBRACE: "{",
  RBRACE: "}",
  LBRACKET: "[",
  RBRACKET: "]",
  // Keywords
  FUNCTION: "FUNCTION",
  LET: "LET",
  CONST: "CONST",
  TRUE: "TRUE",
  FALSE: "FALSE",
  IF: "IF",
  ELSE: "ELSE",
  RETURN: "RETURN",
  WHILE: "WHILE",
  FOR: "FOR",
  BREAK: "BREAK",
  CONTINUE: "CONTINUE",
  NULL_LIT: "NULL_LIT",
  MATCH: "MATCH",
  DO: "DO",
  UNDERSCORE: "_",
  IMPORT: "IMPORT",
  ENUM: "ENUM",
  TRY: "TRY",
  CATCH: "CATCH",
  THROW: "THROW",
  FINALLY: "FINALLY",
  GEN: "GEN",
  YIELD: "YIELD",
  CLASS: "CLASS",
  SELF: "SELF",
  NEW: "NEW",
  EXTENDS: "EXTENDS",
  SUPER: "SUPER",
  // Special
  EOF: "EOF",
  ILLEGAL: "ILLEGAL"
};
var KEYWORDS = {
  fn: TokenType.FUNCTION,
  let: TokenType.LET,
  const: TokenType.CONST,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
  if: TokenType.IF,
  else: TokenType.ELSE,
  return: TokenType.RETURN,
  while: TokenType.WHILE,
  for: TokenType.FOR,
  break: TokenType.BREAK,
  continue: TokenType.CONTINUE,
  null: TokenType.NULL_LIT,
  match: TokenType.MATCH,
  do: TokenType.DO,
  import: TokenType.IMPORT,
  enum: TokenType.ENUM,
  try: TokenType.TRY,
  catch: TokenType.CATCH,
  throw: TokenType.THROW,
  finally: TokenType.FINALLY,
  gen: TokenType.GEN,
  yield: TokenType.YIELD,
  class: TokenType.CLASS,
  self: TokenType.SELF,
  new: TokenType.NEW,
  extends: TokenType.EXTENDS,
  super: TokenType.SUPER
};
var Token = class {
  constructor(type, literal, line) {
    this.type = type;
    this.literal = literal;
    if (line !== void 0) this.line = line;
  }
};
var Lexer = class {
  constructor(input) {
    this.input = input;
    this.position = 0;
    this.readPosition = 0;
    this.ch = null;
    this.line = 1;
    this.readChar();
  }
  makeToken(type, literal) {
    const t = new Token(type, literal);
    t.line = this.line;
    return t;
  }
  readChar() {
    this.ch = this.readPosition >= this.input.length ? null : this.input[this.readPosition];
    this.position = this.readPosition;
    this.readPosition++;
  }
  peekChar() {
    return this.readPosition >= this.input.length ? null : this.input[this.readPosition];
  }
  skipWhitespace() {
    while (this.ch === " " || this.ch === "	" || this.ch === "\n" || this.ch === "\r") {
      if (this.ch === "\n") this.line++;
      this.readChar();
    }
    if (this.ch === "/" && this.peekChar() === "/") {
      while (this.ch !== "\n" && this.ch !== "\0") {
        this.readChar();
      }
      this.skipWhitespace();
    }
    if (this.ch === "/" && this.peekChar() === "*") {
      this.readChar();
      this.readChar();
      while (!(this.ch === "*" && this.peekChar() === "/") && this.ch !== "\0") {
        if (this.ch === "\n") this.line++;
        this.readChar();
      }
      if (this.ch === "*") {
        this.readChar();
        this.readChar();
      }
      this.skipWhitespace();
    }
  }
  readIdentifier() {
    const start = this.position;
    while (this.ch && (isLetter(this.ch) || this.ch === "_" || isDigit(this.ch))) {
      this.readChar();
    }
    return this.input.slice(start, this.position);
  }
  readNumber() {
    const start = this.position;
    let isFloat = false;
    while (this.ch && isDigit(this.ch)) {
      this.readChar();
    }
    if (this.ch === "." && isDigit(this.peekChar())) {
      isFloat = true;
      this.readChar();
      while (this.ch && isDigit(this.ch)) {
        this.readChar();
      }
    }
    return { value: this.input.slice(start, this.position), isFloat };
  }
  readString() {
    this.readChar();
    let str = "";
    while (this.ch !== null && this.ch !== '"') {
      if (this.ch === "\\") {
        this.readChar();
        switch (this.ch) {
          case "n":
            str += "\n";
            break;
          case "t":
            str += "	";
            break;
          case "r":
            str += "\r";
            break;
          case "\\":
            str += "\\";
            break;
          case '"':
            str += '"';
            break;
          case "0":
            str += "\0";
            break;
          default:
            str += "\\" + this.ch;
            break;
        }
      } else {
        str += this.ch;
      }
      this.readChar();
    }
    this.readChar();
    return str;
  }
  readTemplateString() {
    this.readChar();
    let str = "";
    while (this.ch !== null && this.ch !== "`") {
      if (this.ch === "\\") {
        this.readChar();
        switch (this.ch) {
          case "n":
            str += "\n";
            break;
          case "t":
            str += "	";
            break;
          case "r":
            str += "\r";
            break;
          case "\\":
            str += "\\";
            break;
          case "`":
            str += "`";
            break;
          case "$":
            str += "$";
            break;
          default:
            str += "\\" + this.ch;
            break;
        }
      } else {
        str += this.ch;
      }
      this.readChar();
    }
    this.readChar();
    return str;
  }
  nextToken() {
    this.skipWhitespace();
    let tok;
    switch (this.ch) {
      case "=":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.EQ, "==");
        } else if (this.peekChar() === ">") {
          this.readChar();
          tok = this.makeToken(TokenType.ARROW, "=>");
        } else {
          tok = this.makeToken(TokenType.ASSIGN, "=");
        }
        break;
      case "+":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.PLUS_ASSIGN, "+=");
        } else if (this.peekChar() === "+") {
          this.readChar();
          tok = this.makeToken(TokenType.PLUS_PLUS, "++");
        } else {
          tok = this.makeToken(TokenType.PLUS, "+");
        }
        break;
      case "-":
        if (this.peekChar() === ">") {
          this.readChar();
          tok = this.makeToken(TokenType.THIN_ARROW, "->");
        } else if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.MINUS_ASSIGN, "-=");
        } else if (this.peekChar() === "-") {
          this.readChar();
          tok = this.makeToken(TokenType.MINUS_MINUS, "--");
        } else {
          tok = this.makeToken(TokenType.MINUS, "-");
        }
        break;
      case "!":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.NOT_EQ, "!=");
        } else {
          tok = this.makeToken(TokenType.BANG, "!");
        }
        break;
      case "*":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.ASTERISK_ASSIGN, "*=");
        } else {
          tok = this.makeToken(TokenType.ASTERISK, "*");
        }
        break;
      case "/":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.SLASH_ASSIGN, "/=");
        } else {
          tok = this.makeToken(TokenType.SLASH, "/");
        }
        break;
      case "%":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.PERCENT_ASSIGN, "%=");
        } else {
          tok = this.makeToken(TokenType.PERCENT, "%");
        }
        break;
      case "&":
        if (this.peekChar() === "&") {
          this.readChar();
          tok = this.makeToken(TokenType.AND, "&&");
        } else {
          tok = this.makeToken(TokenType.ILLEGAL, "&");
        }
        break;
      case "|":
        if (this.peekChar() === "|") {
          this.readChar();
          tok = this.makeToken(TokenType.OR, "||");
        } else if (this.peekChar() === ">") {
          this.readChar();
          tok = this.makeToken(TokenType.PIPE, "|>");
        } else {
          tok = this.makeToken(TokenType.BAR, "|");
        }
        break;
      case "<":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.LT_EQ, "<=");
        } else {
          tok = this.makeToken(TokenType.LT, "<");
        }
        break;
      case ">":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = this.makeToken(TokenType.GT_EQ, ">=");
        } else {
          tok = this.makeToken(TokenType.GT, ">");
        }
        break;
      case ",":
        tok = this.makeToken(TokenType.COMMA, ",");
        break;
      case ":":
        tok = this.makeToken(TokenType.COLON, ":");
        break;
      case "?":
        if (this.peekChar() === "?") {
          this.readChar();
          tok = this.makeToken(TokenType.NULLISH, "??");
        } else if (this.peekChar() === ".") {
          this.readChar();
          tok = this.makeToken(TokenType.OPTIONAL_CHAIN, "?.");
        } else {
          tok = this.makeToken(TokenType.QUESTION, "?");
        }
        break;
      case ";":
        tok = this.makeToken(TokenType.SEMICOLON, ";");
        break;
      case "(":
        tok = this.makeToken(TokenType.LPAREN, "(");
        break;
      case ")":
        tok = this.makeToken(TokenType.RPAREN, ")");
        break;
      case "{":
        tok = this.makeToken(TokenType.LBRACE, "{");
        break;
      case "}":
        tok = this.makeToken(TokenType.RBRACE, "}");
        break;
      case "[":
        tok = this.makeToken(TokenType.LBRACKET, "[");
        break;
      case "]":
        tok = this.makeToken(TokenType.RBRACKET, "]");
        break;
      case '"':
        {
          const t = this.makeToken(TokenType.STRING, this.readString());
          t.line = this.line;
          return t;
        }
        ;
      case "`":
        return this.makeToken(TokenType.TEMPLATE_STRING, this.readTemplateString());
      case ".":
        if (this.peekChar() === "." && this.input[this.readPosition + 1] === ".") {
          this.readChar();
          this.readChar();
          tok = this.makeToken(TokenType.SPREAD, "...");
        } else if (this.peekChar() === ".") {
          this.readChar();
          tok = this.makeToken(TokenType.DOT_DOT, "..");
        } else {
          tok = this.makeToken(TokenType.DOT, ".");
        }
        break;
      case null:
        return this.makeToken(TokenType.EOF, "");
      default:
        if (isLetter(this.ch)) {
          const ident = this.readIdentifier();
          const type = KEYWORDS[ident] || TokenType.IDENT;
          return this.makeToken(type, ident);
        } else if (isDigit(this.ch)) {
          const num = this.readNumber();
          return this.makeToken(num.isFloat ? TokenType.FLOAT : TokenType.INT, num.value);
        } else {
          tok = this.makeToken(TokenType.ILLEGAL, this.ch);
        }
    }
    this.readChar();
    return tok;
  }
  /** Tokenize all remaining input */
  tokenize() {
    const tokens = [];
    let tok;
    do {
      tok = this.nextToken();
      tokens.push(tok);
    } while (tok.type !== TokenType.EOF);
    return tokens;
  }
};
function isLetter(ch) {
  return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_";
}
function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

// projects/monkey-lang/src/ast.js
var Program = class {
  constructor() {
    this.statements = [];
  }
  tokenLiteral() {
    return this.statements.length > 0 ? this.statements[0].tokenLiteral() : "";
  }
  toString() {
    return this.statements.map((s) => s.toString()).join("");
  }
};
var LetStatement = class {
  constructor(token, name, value) {
    this.token = token;
    this.name = name;
    this.value = value;
    this.isConst = token.type === "CONST";
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.isConst ? "const" : "let"} ${this.name} = ${this.value};`;
  }
};
var ReturnStatement = class {
  constructor(token, returnValue) {
    this.token = token;
    this.returnValue = returnValue;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `return ${this.returnValue};`;
  }
};
var ImportStatement = class {
  constructor(token, moduleName, bindings = null, alias = null) {
    this.token = token;
    this.moduleName = moduleName;
    this.bindings = bindings;
    this.alias = alias;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    if (this.bindings) {
      return `import "${this.moduleName}" for ${this.bindings.join(", ")};`;
    }
    if (this.alias) {
      return `import "${this.moduleName}" as ${this.alias};`;
    }
    return `import "${this.moduleName}";`;
  }
};
var ExpressionStatement = class {
  constructor(token, expression) {
    this.token = token;
    this.expression = expression;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.expression ? this.expression.toString() : "";
  }
};
var BlockStatement = class {
  constructor(token, statements) {
    this.token = token;
    this.statements = statements;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.statements.map((s) => s.toString()).join("");
  }
};
var Identifier = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.value;
  }
};
var IntegerLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.token.literal;
  }
};
var FloatLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.token.literal;
  }
};
var StringLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `"${this.value}"`;
  }
};
var BooleanLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.token.literal;
  }
};
var PrefixExpression = class {
  constructor(token, operator, right) {
    this.token = token;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.operator}${this.right})`;
  }
};
var InfixExpression = class {
  constructor(token, left, operator, right) {
    this.token = token;
    this.left = left;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left} ${this.operator} ${this.right})`;
  }
};
var IfExpression = class {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;
    this.alternative = alternative;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    let s = `if${this.condition} ${this.consequence}`;
    if (this.alternative) s += `else ${this.alternative}`;
    return s;
  }
};
var FunctionLiteral = class {
  constructor(token, parameters, body) {
    this.token = token;
    this.parameters = parameters;
    this.body = body;
    this.restParam = null;
    this.paramTypes = null;
    this.returnType = null;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const params = this.parameters.map((p, i) => {
      const type = this.paramTypes && this.paramTypes[i] ? `: ${this.paramTypes[i]}` : "";
      return `${p}${type}`;
    });
    const ret = this.returnType ? ` -> ${this.returnType}` : "";
    return `fn(${params.join(", ")})${ret} ${this.body}`;
  }
};
var CallExpression = class {
  constructor(token, fn, args) {
    this.token = token;
    this.function = fn;
    this.arguments = args;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.function}(${this.arguments.join(", ")})`;
  }
};
var ArrayLiteral = class {
  constructor(token, elements) {
    this.token = token;
    this.elements = elements;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `[${this.elements.join(", ")}]`;
  }
};
var ArrayComprehension = class {
  constructor(token, body, variable, iterable, condition) {
    this.token = token;
    this.body = body;
    this.variable = variable;
    this.iterable = iterable;
    this.condition = condition;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const cond = this.condition ? ` if ${this.condition}` : "";
    return `[${this.body} for ${this.variable} in ${this.iterable}${cond}]`;
  }
};
var IndexExpression = class {
  constructor(token, left, index) {
    this.token = token;
    this.left = left;
    this.index = index;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left}[${this.index}])`;
  }
};
var OptionalChainExpression = class {
  constructor(token, left, index) {
    this.token = token;
    this.left = left;
    this.index = index;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left}?.[${this.index}])`;
  }
};
var SpreadElement = class {
  constructor(token, expression) {
    this.token = token;
    this.expression = expression;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `...${this.expression}`;
  }
};
var HashLiteral = class {
  constructor(token, pairs) {
    this.token = token;
    this.pairs = pairs;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const entries = [];
    for (const [k, v] of this.pairs) entries.push(`${k}:${v}`);
    return `{${entries.join(", ")}}`;
  }
};
var WhileExpression = class {
  constructor(token, condition, body) {
    this.token = token;
    this.condition = condition;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `while(${this.condition}) ${this.body}`;
  }
};
var AssignExpression = class {
  constructor(token, name, value) {
    this.token = token;
    this.name = name;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.name} = ${this.value}`;
  }
};
var ForExpression = class {
  constructor(token, init, condition, update, body) {
    this.token = token;
    this.init = init;
    this.condition = condition;
    this.update = update;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `for (...) { ... }`;
  }
};
var ForInExpression = class {
  constructor(token, variable, iterable, body) {
    this.token = token;
    this.variable = variable;
    this.iterable = iterable;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `for (${this.variable} in ...) { ... }`;
  }
};
var BreakStatement = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "break";
  }
};
var ContinueStatement = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "continue";
  }
};
var EnumStatement = class {
  constructor(token, name, variants) {
    this.token = token;
    this.name = name;
    this.variants = variants;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `enum ${this.name} { ${this.variants.join(", ")} }`;
  }
};
var TemplateLiteral = class {
  constructor(token, parts) {
    this.token = token;
    this.parts = parts;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "`...`";
  }
};
var IndexAssignExpression = class {
  constructor(token, left, index, value) {
    this.token = token;
    this.left = left;
    this.index = index;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.left}[${this.index}] = ${this.value}`;
  }
};
var NullLiteral = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "null";
  }
};
var SliceExpression = class {
  constructor(token, left, start, end) {
    this.token = token;
    this.left = left;
    this.start = start;
    this.end = end;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.left}[${this.start}:${this.end}]`;
  }
};
var TernaryExpression = class {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;
    this.alternative = alternative;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.condition} ? ${this.consequence} : ${this.alternative}`;
  }
};
var MatchExpression = class {
  constructor(token, subject, arms) {
    this.token = token;
    this.subject = subject;
    this.arms = arms;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "match { ... }";
  }
};
var TypePattern = class {
  constructor(typeName, binding) {
    this.typeName = typeName;
    this.binding = binding;
  }
  toString() {
    return `${this.typeName}(${this.binding.value})`;
  }
};
var OrPattern = class {
  constructor(patterns) {
    this.patterns = patterns;
  }
  toString() {
    return this.patterns.map((p) => p.toString()).join(" | ");
  }
};
var DestructuringLet = class {
  constructor(token, names, value) {
    this.token = token;
    this.names = names;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `let [${this.names.map((n) => n ? n.value : "_").join(", ")}] = ...`;
  }
};
var HashDestructuringLet = class {
  constructor(token, names, value) {
    this.token = token;
    this.names = names;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `let {${this.names.map((n) => n.value).join(", ")}} = ...`;
  }
};
var DoWhileExpression = class {
  constructor(token, body, condition) {
    this.token = token;
    this.body = body;
    this.condition = condition;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "do { ... } while (...)";
  }
};
var RangeExpression = class {
  constructor(token, start, end) {
    this.token = token;
    this.start = start;
    this.end = end;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.start}..${this.end}`;
  }
};
var TryExpression = class {
  constructor(token, tryBlock, catchParam, catchBlock, finallyBlock) {
    this.token = token;
    this.tryBlock = tryBlock;
    this.catchParam = catchParam;
    this.catchBlock = catchBlock;
    this.finallyBlock = finallyBlock;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    let s = `try { ... }`;
    if (this.catchBlock) s += ` catch(${this.catchParam}) { ... }`;
    if (this.finallyBlock) s += ` finally { ... }`;
    return s;
  }
};
var ThrowExpression = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `throw ${this.value}`;
  }
};
var GeneratorLiteral = class {
  constructor(token, parameters, body, name) {
    this.token = token;
    this.parameters = parameters;
    this.body = body;
    this.name = name;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `gen(${this.parameters.join(", ")}) { ... }`;
  }
};
var YieldExpression = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `yield ${this.value}`;
  }
};
var ClassStatement = class {
  constructor(token, name, superClass, methods, fields) {
    this.token = token;
    this.name = name;
    this.superClass = superClass;
    this.methods = methods;
    this.fields = fields;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `class ${this.name} { ... }`;
  }
};
var SelfExpression = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return "self";
  }
  toString() {
    return "self";
  }
};
var SuperExpression = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return "super";
  }
  toString() {
    return "super";
  }
};

// projects/monkey-lang/src/parser.js
var Precedence = {
  LOWEST: 1,
  ASSIGN: 2,
  // =
  PIPE: 3,
  // |>
  NULLISH: 4,
  // ??
  OR: 5,
  // ||
  AND: 6,
  // &&
  EQUALS: 7,
  // ==
  LESSGREATER: 8,
  // > or <
  SUM: 9,
  // +
  PRODUCT: 10,
  // *
  PREFIX: 11,
  // -X or !X
  CALL: 12,
  // myFunction(X)
  INDEX: 13
  // array[index]
};
var TOKEN_PRECEDENCE = {
  [TokenType.ASSIGN]: Precedence.ASSIGN,
  [TokenType.PLUS_ASSIGN]: Precedence.ASSIGN,
  [TokenType.MINUS_ASSIGN]: Precedence.ASSIGN,
  [TokenType.ASTERISK_ASSIGN]: Precedence.ASSIGN,
  [TokenType.SLASH_ASSIGN]: Precedence.ASSIGN,
  [TokenType.PERCENT_ASSIGN]: Precedence.ASSIGN,
  [TokenType.QUESTION]: Precedence.OR,
  [TokenType.NULLISH]: Precedence.NULLISH,
  [TokenType.PIPE]: Precedence.PIPE,
  [TokenType.DOT_DOT]: Precedence.PIPE,
  [TokenType.OPTIONAL_CHAIN]: Precedence.INDEX,
  [TokenType.DOT]: Precedence.INDEX,
  [TokenType.PLUS_PLUS]: Precedence.CALL,
  // postfix, high precedence
  [TokenType.MINUS_MINUS]: Precedence.CALL,
  // ternary has same precedence as OR
  [TokenType.EQ]: Precedence.EQUALS,
  [TokenType.NOT_EQ]: Precedence.EQUALS,
  [TokenType.AND]: Precedence.AND,
  [TokenType.OR]: Precedence.OR,
  [TokenType.LT]: Precedence.LESSGREATER,
  [TokenType.GT]: Precedence.LESSGREATER,
  [TokenType.LT_EQ]: Precedence.LESSGREATER,
  [TokenType.GT_EQ]: Precedence.LESSGREATER,
  [TokenType.PLUS]: Precedence.SUM,
  [TokenType.MINUS]: Precedence.SUM,
  [TokenType.SLASH]: Precedence.PRODUCT,
  [TokenType.ASTERISK]: Precedence.PRODUCT,
  [TokenType.PERCENT]: Precedence.PRODUCT,
  [TokenType.LPAREN]: Precedence.CALL,
  [TokenType.LBRACKET]: Precedence.INDEX
};
var Parser = class _Parser {
  constructor(lexer) {
    this.lexer = lexer;
    this.errors = [];
    this.curToken = null;
    this.peekToken = null;
    this.prefixParseFns = {};
    this.infixParseFns = {};
    this.registerPrefix(TokenType.IDENT, () => this.parseIdentifier());
    this.registerPrefix(TokenType.INT, () => this.parseIntegerLiteral());
    this.registerPrefix(TokenType.FLOAT, () => this.parseFloatLiteral());
    this.registerPrefix(TokenType.STRING, () => this.parseStringLiteral());
    this.registerPrefix(TokenType.TEMPLATE_STRING, () => this.parseTemplateLiteral());
    this.registerPrefix(TokenType.TRUE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.FALSE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.BANG, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.MINUS, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.LPAREN, () => this.parseGroupedExpression());
    this.registerPrefix(TokenType.IF, () => this.parseIfExpression());
    this.registerPrefix(TokenType.FUNCTION, () => this.parseFunctionLiteral());
    this.registerPrefix(TokenType.GEN, () => this.parseGeneratorLiteral());
    this.registerPrefix(TokenType.YIELD, () => this.parseYieldExpression());
    this.registerPrefix(TokenType.SELF, () => new SelfExpression(this.curToken));
    this.registerPrefix(TokenType.SUPER, () => new SuperExpression(this.curToken));
    this.registerPrefix(TokenType.LBRACKET, () => this.parseArrayLiteral());
    this.registerPrefix(TokenType.LBRACE, () => this.parseHashLiteral());
    this.registerPrefix(TokenType.WHILE, () => this.parseWhileExpression());
    this.registerPrefix(TokenType.FOR, () => this.parseForExpression());
    this.registerPrefix(TokenType.BREAK, () => new BreakStatement(this.curToken));
    this.registerPrefix(TokenType.CONTINUE, () => new ContinueStatement(this.curToken));
    this.registerPrefix(TokenType.NULL_LIT, () => new NullLiteral(this.curToken));
    this.registerPrefix(TokenType.MATCH, () => this.parseMatchExpression());
    this.registerPrefix(TokenType.DO, () => this.parseDoWhileExpression());
    this.registerPrefix(TokenType.TRY, () => this.parseTryExpression());
    for (const op of [
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.SLASH,
      TokenType.ASTERISK,
      TokenType.PERCENT,
      TokenType.EQ,
      TokenType.NOT_EQ,
      TokenType.LT,
      TokenType.GT,
      TokenType.LT_EQ,
      TokenType.GT_EQ,
      TokenType.AND,
      TokenType.OR,
      TokenType.NULLISH
    ]) {
      this.registerInfix(op, (left) => this.parseInfixExpression(left));
    }
    this.registerInfix(TokenType.PIPE, (left) => this.parsePipeExpression(left));
    this.registerInfix(TokenType.DOT_DOT, (left) => this.parseRangeExpression(left));
    this.registerInfix(TokenType.OPTIONAL_CHAIN, (left) => this.parseOptionalChainExpression(left));
    this.registerInfix(TokenType.DOT, (left) => this.parseDotExpression(left));
    this.registerInfix(TokenType.LPAREN, (left) => this.parseCallExpression(left));
    this.registerInfix(TokenType.LBRACKET, (left) => this.parseIndexExpression(left));
    this.registerInfix(TokenType.ASSIGN, (left) => this.parseAssignExpression(left));
    this.registerInfix(TokenType.QUESTION, (left) => this.parseTernaryExpression(left));
    this.registerInfix(TokenType.PLUS_PLUS, (left) => this.parsePostfixExpression(left, "+"));
    this.registerInfix(TokenType.MINUS_MINUS, (left) => this.parsePostfixExpression(left, "-"));
    for (const op of [
      TokenType.PLUS_ASSIGN,
      TokenType.MINUS_ASSIGN,
      TokenType.ASTERISK_ASSIGN,
      TokenType.SLASH_ASSIGN,
      TokenType.PERCENT_ASSIGN
    ]) {
      this.registerInfix(op, (left) => this.parseCompoundAssignExpression(left));
    }
    this.nextToken();
    this.nextToken();
  }
  registerPrefix(type, fn) {
    this.prefixParseFns[type] = fn;
  }
  registerInfix(type, fn) {
    this.infixParseFns[type] = fn;
  }
  nextToken() {
    this.curToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
  }
  curTokenIs(t) {
    return this.curToken.type === t;
  }
  peekTokenIs(t) {
    return this.peekToken.type === t;
  }
  expectPeek(t) {
    if (this.peekTokenIs(t)) {
      this.nextToken();
      return true;
    }
    this.peekError(t);
    return false;
  }
  peekError(t) {
    this.errors.push(`expected next token to be ${t}, got ${this.peekToken.type} instead`);
  }
  peekPrecedence() {
    return TOKEN_PRECEDENCE[this.peekToken.type] || Precedence.LOWEST;
  }
  curPrecedence() {
    return TOKEN_PRECEDENCE[this.curToken.type] || Precedence.LOWEST;
  }
  // --- Entry point ---
  parseProgram() {
    const program = new Program();
    while (!this.curTokenIs(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) program.statements.push(stmt);
      this.nextToken();
    }
    return program;
  }
  // --- Statements ---
  parseStatement() {
    switch (this.curToken.type) {
      case TokenType.LET:
        return this.parseLetStatement();
      case TokenType.CONST:
        return this.parseLetStatement();
      case TokenType.RETURN:
        return this.parseReturnStatement();
      case TokenType.IMPORT:
        return this.parseImportStatement();
      case TokenType.ENUM:
        return this.parseEnumStatement();
      case TokenType.CLASS:
        return this.parseClassStatement();
      case TokenType.THROW:
        return this.parseThrowStatement();
      default:
        return this.parseExpressionStatement();
    }
  }
  parseLetStatement() {
    const token = this.curToken;
    if (this.peekTokenIs(TokenType.LBRACKET)) {
      return this.parseDestructuringLet(token);
    }
    if (this.peekTokenIs(TokenType.LBRACE)) {
      return this.parseHashDestructuringLet(token);
    }
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new Identifier(this.curToken, this.curToken.literal);
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new LetStatement(token, name, value);
  }
  parseDestructuringLet(token) {
    this.nextToken();
    const names = [];
    if (!this.peekTokenIs(TokenType.RBRACKET)) {
      this.nextToken();
      names.push(new Identifier(this.curToken, this.curToken.literal));
      while (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken();
        this.nextToken();
        if (this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "_") {
          names.push(null);
        } else {
          names.push(new Identifier(this.curToken, this.curToken.literal));
        }
      }
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new DestructuringLet(token, names, value);
  }
  parseHashDestructuringLet(token) {
    this.nextToken();
    const names = [];
    if (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      names.push(new Identifier(this.curToken, this.curToken.literal));
      while (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken();
        this.nextToken();
        names.push(new Identifier(this.curToken, this.curToken.literal));
      }
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new HashDestructuringLet(token, names, value);
  }
  parseReturnStatement() {
    const token = this.curToken;
    this.nextToken();
    const returnValue = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ReturnStatement(token, returnValue);
  }
  parseImportStatement() {
    const token = this.curToken;
    this.nextToken();
    if (this.curToken.type !== TokenType.STRING) {
      this.errors.push(`expected module name as string, got ${this.curToken.type}`);
      return null;
    }
    const moduleName = this.curToken.literal;
    let bindings = null;
    let alias = null;
    if (this.peekToken.type === TokenType.FOR) {
      this.nextToken();
      bindings = [];
      do {
        this.nextToken();
        if (this.curToken.type !== TokenType.IDENT) {
          this.errors.push(`expected identifier in import binding, got ${this.curToken.type}`);
          return null;
        }
        bindings.push(this.curToken.literal);
        if (!this.peekTokenIs(TokenType.COMMA)) break;
        this.nextToken();
      } while (true);
    } else if (this.peekToken.type === TokenType.IDENT && this.peekToken.literal === "as") {
      this.nextToken();
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected identifier after 'as', got ${this.curToken.type}`);
        return null;
      }
      alias = this.curToken.literal;
    }
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ImportStatement(token, moduleName, bindings, alias);
  }
  parseExpressionStatement() {
    const token = this.curToken;
    const expression = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ExpressionStatement(token, expression);
  }
  parseEnumStatement() {
    const token = this.curToken;
    this.nextToken();
    if (this.curToken.type !== TokenType.IDENT) {
      this.errors.push(`expected enum name, got ${this.curToken.type}`);
      return null;
    }
    const name = this.curToken.literal;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const variants = [];
    while (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected variant name, got ${this.curToken.type}`);
        return null;
      }
      variants.push(this.curToken.literal);
      if (this.peekTokenIs(TokenType.COMMA)) this.nextToken();
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new EnumStatement(token, name, variants);
  }
  parseBlockStatement() {
    const token = this.curToken;
    const statements = [];
    this.nextToken();
    while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      this.nextToken();
    }
    return new BlockStatement(token, statements);
  }
  // --- Expressions (Pratt) ---
  parseExpression(precedence) {
    const prefix = this.prefixParseFns[this.curToken.type];
    if (!prefix) {
      this.errors.push(`no prefix parse function for ${this.curToken.type}`);
      return null;
    }
    let leftExp = prefix();
    while (!this.peekTokenIs(TokenType.SEMICOLON) && precedence < this.peekPrecedence()) {
      const infix = this.infixParseFns[this.peekToken.type];
      if (!infix) return leftExp;
      this.nextToken();
      leftExp = infix(leftExp);
    }
    return leftExp;
  }
  parseIdentifier() {
    return new Identifier(this.curToken, this.curToken.literal);
  }
  parseIntegerLiteral() {
    const value = parseInt(this.curToken.literal, 10);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as integer`);
      return null;
    }
    return new IntegerLiteral(this.curToken, value);
  }
  parseFloatLiteral() {
    const value = parseFloat(this.curToken.literal);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as float`);
      return null;
    }
    return new FloatLiteral(this.curToken, value);
  }
  parseStringLiteral() {
    return new StringLiteral(this.curToken, this.curToken.literal);
  }
  parseTemplateLiteral() {
    const token = this.curToken;
    const raw = token.literal;
    const parts = [];
    let i = 0;
    while (i < raw.length) {
      const dollarIdx = raw.indexOf("${", i);
      if (dollarIdx === -1) {
        parts.push(new StringLiteral(token, raw.slice(i)));
        break;
      }
      if (dollarIdx > i) {
        parts.push(new StringLiteral(token, raw.slice(i, dollarIdx)));
      }
      let braceCount = 1;
      let j = dollarIdx + 2;
      while (j < raw.length && braceCount > 0) {
        if (raw[j] === "{") braceCount++;
        else if (raw[j] === "}") braceCount--;
        j++;
      }
      const exprStr = raw.slice(dollarIdx + 2, j - 1);
      const exprLexer = new Lexer(exprStr);
      const exprParser = new _Parser(exprLexer);
      const expr = exprParser.parseExpression(Precedence.LOWEST);
      if (exprParser.errors.length > 0) {
        this.errors.push(...exprParser.errors);
      }
      parts.push(expr);
      i = j;
    }
    if (parts.length === 0) {
      return new StringLiteral(token, "");
    }
    if (parts.length === 1 && parts[0] instanceof StringLiteral) {
      return parts[0];
    }
    return new TemplateLiteral(token, parts);
  }
  parseBooleanLiteral() {
    return new BooleanLiteral(this.curToken, this.curTokenIs(TokenType.TRUE));
  }
  parsePrefixExpression() {
    const token = this.curToken;
    const operator = this.curToken.literal;
    this.nextToken();
    const right = this.parseExpression(Precedence.PREFIX);
    return new PrefixExpression(token, operator, right);
  }
  parseInfixExpression(left) {
    const token = this.curToken;
    const operator = this.curToken.literal;
    const precedence = this.curPrecedence();
    this.nextToken();
    const right = this.parseExpression(precedence);
    return new InfixExpression(token, left, operator, right);
  }
  parsePipeExpression(left) {
    const token = this.curToken;
    this.nextToken();
    const right = this.parseExpression(Precedence.PIPE);
    if (right instanceof CallExpression) {
      right.arguments.unshift(left);
      return right;
    } else {
      return new CallExpression(token, right, [left]);
    }
  }
  parseRangeExpression(left) {
    const token = this.curToken;
    this.nextToken();
    const end = this.parseExpression(Precedence.PIPE + 1);
    return new RangeExpression(token, left, end);
  }
  parseOptionalChainExpression(left) {
    const token = this.curToken;
    if (this.peekToken.type === TokenType.LBRACKET) {
      this.nextToken();
      this.nextToken();
      const index = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new OptionalChainExpression(token, left, index);
    } else if (this.peekToken.type === TokenType.IDENT) {
      this.nextToken();
      const key = new StringLiteral(this.curToken, this.curToken.literal);
      return new OptionalChainExpression(token, left, key);
    } else {
      this.errors.push(`expected [ or identifier after ?., got ${this.peekToken.type}`);
      return left;
    }
  }
  parseDotExpression(left) {
    const token = this.curToken;
    if (this.peekToken.type !== TokenType.IDENT) {
      this.errors.push(`expected identifier after '.', got ${this.peekToken.type}`);
      return left;
    }
    this.nextToken();
    const key = new StringLiteral(this.curToken, this.curToken.literal);
    return new IndexExpression(token, left, key);
  }
  parseArrowExpression(left) {
    if (!(left instanceof Identifier)) {
      this.errors.push(`expected identifier before '=>', got ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const params = [left];
    this.nextToken();
    let body;
    if (this.curToken.type === TokenType.LBRACE) {
      body = this.parseBlockStatement();
    } else {
      const expr = this.parseExpression(Precedence.LOWEST);
      body = new BlockStatement(this.curToken, [new ExpressionStatement(this.curToken, expr)]);
    }
    return new FunctionLiteral(token, params, body);
  }
  parseGroupedExpression() {
    const savedPos = this.lexer.position;
    const savedReadPos = this.lexer.readPosition;
    const savedCh = this.lexer.ch;
    const savedCurToken = this.curToken;
    const savedPeekToken = this.peekToken;
    this.nextToken();
    const params = [];
    let isArrow = false;
    if (this.curToken.type === TokenType.RPAREN) {
      if (this.peekToken.type === TokenType.ARROW) {
        isArrow = true;
      }
    } else if (this.curToken.type === TokenType.IDENT) {
      params.push(new Identifier(this.curToken, this.curToken.literal));
      while (this.peekToken.type === TokenType.COMMA) {
        this.nextToken();
        this.nextToken();
        if (this.curToken.type !== TokenType.IDENT) {
          break;
        }
        params.push(new Identifier(this.curToken, this.curToken.literal));
      }
      if (this.peekToken.type === TokenType.RPAREN) {
        this.nextToken();
        if (this.peekToken.type === TokenType.ARROW) {
          isArrow = true;
        }
      }
    }
    if (isArrow) {
      this.nextToken();
      this.nextToken();
      let body;
      if (this.curToken.type === TokenType.LBRACE) {
        body = this.parseBlockStatement();
      } else {
        const expr = this.parseExpression(Precedence.LOWEST);
        body = new BlockStatement(this.curToken, [new ExpressionStatement(this.curToken, expr)]);
      }
      return new FunctionLiteral(savedCurToken, params, body);
    }
    this.lexer.position = savedPos;
    this.lexer.readPosition = savedReadPos;
    this.lexer.ch = savedCh;
    this.curToken = savedCurToken;
    this.peekToken = savedPeekToken;
    this.nextToken();
    const exp = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return exp;
  }
  parseIfExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const consequence = this.parseBlockStatement();
    let alternative = null;
    if (this.peekTokenIs(TokenType.ELSE)) {
      this.nextToken();
      if (this.peekTokenIs(TokenType.IF)) {
        this.nextToken();
        const elseIf = this.parseIfExpression();
        alternative = new BlockStatement(this.curToken, [new ExpressionStatement(this.curToken, elseIf)]);
      } else {
        if (!this.expectPeek(TokenType.LBRACE)) return null;
        alternative = this.parseBlockStatement();
      }
    }
    return new IfExpression(token, condition, consequence, alternative);
  }
  parseWhileExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new WhileExpression(token, condition, body);
  }
  parseForExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    if (this.curTokenIs(TokenType.IDENT) && this.peekToken.type === TokenType.IDENT && this.peekToken.literal === "in") {
      const varName = this.curToken.literal;
      this.nextToken();
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      const body2 = this.parseBlockStatement();
      return new ForInExpression(token, varName, iterable, body2);
    }
    if (this.curTokenIs(TokenType.LBRACKET)) {
      const names = [];
      if (!this.peekTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        names.push(this.curToken.literal);
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(this.curToken.literal);
        }
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      this.nextToken();
      if (!(this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "in")) {
        this.errors.push('expected "in" after destructuring pattern');
        return null;
      }
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      const body2 = this.parseBlockStatement();
      const tempVar = "__forin_dest_" + token.literal;
      const destBody = new BlockStatement(token, [
        new DestructuringLet(token, names.map((n) => n === "_" ? null : new Identifier(token, n)), new Identifier(token, tempVar)),
        ...body2.statements
      ]);
      return new ForInExpression(token, tempVar, iterable, destBody);
    }
    let init;
    if (this.curTokenIs(TokenType.LET)) {
      init = this.parseLetStatement();
    } else {
      init = new ExpressionStatement(this.curToken, this.parseExpression(Precedence.LOWEST));
      if (!this.expectPeek(TokenType.SEMICOLON)) return null;
    }
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.SEMICOLON)) return null;
    this.nextToken();
    const update = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new ForExpression(token, init, condition, update, body);
  }
  parseFunctionLiteral() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    const { params: parameters, defaults, restParam, paramTypes } = this.parseFunctionParameters();
    let returnType = null;
    if (this.peekTokenIs(TokenType.THIN_ARROW)) {
      this.nextToken();
      this.nextToken();
      returnType = this.curToken.literal;
    }
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    const fn = new FunctionLiteral(token, parameters, body);
    fn.defaults = defaults;
    fn.restParam = restParam;
    fn.paramTypes = paramTypes.some((t) => t !== null) ? paramTypes : null;
    fn.returnType = returnType;
    return fn;
  }
  parseGeneratorLiteral() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    const { params: parameters } = this.parseFunctionParameters();
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new GeneratorLiteral(token, parameters, body);
  }
  parseClassStatement() {
    const token = this.curToken;
    this.nextToken();
    const name = this.curToken.literal;
    let superClass = null;
    if (this.peekTokenIs(TokenType.EXTENDS)) {
      this.nextToken();
      this.nextToken();
      superClass = this.curToken.literal;
    }
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const methods = [];
    const fields = [];
    this.nextToken();
    while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
      if (this.curTokenIs(TokenType.LET)) {
        this.nextToken();
        fields.push(this.curToken.literal);
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        this.nextToken();
      } else if (this.curTokenIs(TokenType.FUNCTION) || this.curToken.literal === "static" && this.peekTokenIs(TokenType.FUNCTION)) {
        let isStatic = false;
        if (this.curToken.literal === "static") {
          isStatic = true;
          this.nextToken();
        }
        const fnToken = this.curToken;
        this.nextToken();
        const methodName = this.curToken.literal;
        if (!this.expectPeek(TokenType.LPAREN)) return null;
        const { params: parameters } = this.parseFunctionParameters();
        if (!this.expectPeek(TokenType.LBRACE)) return null;
        const body = this.parseBlockStatement();
        methods.push({ name: methodName, params: parameters, body, token: fnToken, isStatic });
        if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
        this.nextToken();
      } else {
        this.nextToken();
      }
    }
    const classNode = new ClassStatement(token, name, superClass, methods, fields);
    const letToken = new Token(TokenType.LET, "let", token.line);
    const identifier = new Identifier(letToken, name);
    const letStmt = new LetStatement(letToken, identifier, classNode);
    return letStmt;
  }
  parseYieldExpression() {
    const token = this.curToken;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    return new YieldExpression(token, value);
  }
  parseFunctionParameters() {
    const params = [];
    const defaults = [];
    const paramTypes = [];
    let restParam = null;
    if (this.peekTokenIs(TokenType.RPAREN)) {
      this.nextToken();
      return { params, defaults, restParam, paramTypes };
    }
    this.nextToken();
    if (this.curToken.type === TokenType.SPREAD) {
      this.nextToken();
      restParam = new Identifier(this.curToken, this.curToken.literal);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
      return { params, defaults, restParam, paramTypes };
    }
    params.push(new Identifier(this.curToken, this.curToken.literal));
    if (this.peekTokenIs(TokenType.COLON)) {
      this.nextToken();
      this.nextToken();
      paramTypes.push(this.curToken.literal);
    } else {
      paramTypes.push(null);
    }
    if (this.peekTokenIs(TokenType.ASSIGN)) {
      this.nextToken();
      this.nextToken();
      defaults.push(this.parseExpression(Precedence.LOWEST));
    } else {
      defaults.push(null);
    }
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      if (this.curToken.type === TokenType.SPREAD) {
        this.nextToken();
        restParam = new Identifier(this.curToken, this.curToken.literal);
        break;
      }
      params.push(new Identifier(this.curToken, this.curToken.literal));
      if (this.peekTokenIs(TokenType.COLON)) {
        this.nextToken();
        this.nextToken();
        paramTypes.push(this.curToken.literal);
      } else {
        paramTypes.push(null);
      }
      if (this.peekTokenIs(TokenType.ASSIGN)) {
        this.nextToken();
        this.nextToken();
        defaults.push(this.parseExpression(Precedence.LOWEST));
      } else {
        defaults.push(null);
      }
    }
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return { params, defaults, restParam, paramTypes };
  }
  parseCallExpression(fn) {
    const token = this.curToken;
    const args = this.parseExpressionList(TokenType.RPAREN);
    return new CallExpression(token, fn, args);
  }
  parseArrayLiteral() {
    const token = this.curToken;
    if (this.peekTokenIs(TokenType.RBRACKET)) {
      this.nextToken();
      return new ArrayLiteral(token, []);
    }
    this.nextToken();
    const first = this._parseExprOrSpread();
    if (!(first instanceof SpreadElement) && this.peekToken.type === TokenType.FOR) {
      this.nextToken();
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected identifier after 'for' in comprehension, got ${this.curToken.type}`);
        return null;
      }
      const variable = this.curToken.literal;
      if (!this.peekToken || this.peekToken.literal !== "in") {
        this.errors.push(`expected 'in' in comprehension`);
        return null;
      }
      this.nextToken();
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      let condition = null;
      if (this.peekToken.type === TokenType.IF) {
        this.nextToken();
        this.nextToken();
        condition = this.parseExpression(Precedence.LOWEST);
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ArrayComprehension(token, first, variable, iterable, condition);
    }
    const elements = [first];
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      elements.push(this._parseExprOrSpread());
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new ArrayLiteral(token, elements);
  }
  parseIndexExpression(left) {
    const token = this.curToken;
    this.nextToken();
    if (this.curTokenIs(TokenType.COLON)) {
      let end = null;
      if (!this.peekTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        end = this.parseExpression(Precedence.LOWEST);
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new SliceExpression(token, left, null, end);
    }
    const index = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.COLON)) {
      this.nextToken();
      let end = null;
      if (!this.peekTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        end = this.parseExpression(Precedence.LOWEST);
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new SliceExpression(token, left, index, end);
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new IndexExpression(token, left, index);
  }
  parseMatchExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const subject = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const arms = [];
    const TYPE_NAMES = /* @__PURE__ */ new Set(["int", "string", "bool", "array", "hash", "fn", "null", "Ok", "Err"]);
    while (!this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF)) {
      this.nextToken();
      let pattern = null;
      if (this.curTokenIs(TokenType.IDENT) && this.curToken.literal === "_") {
        pattern = null;
      } else if ((this.curTokenIs(TokenType.IDENT) || this.curTokenIs(TokenType.FUNCTION)) && TYPE_NAMES.has(this.curToken.literal) && this.peekTokenIs(TokenType.LPAREN)) {
        const typeName = this.curToken.literal;
        this.nextToken();
        this.nextToken();
        const binding = new Identifier(this.curToken, this.curToken.literal);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
        pattern = new TypePattern(typeName, binding);
      } else {
        pattern = this.parseExpression(Precedence.LOWEST);
      }
      if (pattern && this.peekTokenIs(TokenType.BAR)) {
        const patterns = [pattern];
        while (this.peekTokenIs(TokenType.BAR)) {
          this.nextToken();
          this.nextToken();
          patterns.push(this.parseExpression(Precedence.LOWEST));
        }
        pattern = new OrPattern(patterns);
      }
      let guard = null;
      if (this.peekToken.type === TokenType.IDENT && this.peekToken.literal === "when") {
        this.nextToken();
        this.nextToken();
        guard = this.parseExpression(Precedence.LOWEST);
      }
      if (!this.expectPeek(TokenType.ARROW)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      arms.push({ pattern, value, guard });
      if (this.peekTokenIs(TokenType.COMMA)) this.nextToken();
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    return new MatchExpression(token, subject, arms);
  }
  parseDoWhileExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    if (!this.expectPeek(TokenType.WHILE)) return null;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return new DoWhileExpression(token, body, condition);
  }
  parseTryExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const tryBlock = this.parseBlockStatement();
    let catchParam = null;
    let catchBlock = null;
    let finallyBlock = null;
    if (this.peekTokenIs(TokenType.CATCH)) {
      this.nextToken();
      if (this.peekTokenIs(TokenType.LPAREN)) {
        this.nextToken();
        if (!this.expectPeek(TokenType.IDENT)) return null;
        catchParam = new Identifier(this.curToken, this.curToken.literal);
        if (!this.expectPeek(TokenType.RPAREN)) return null;
      }
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      catchBlock = this.parseBlockStatement();
    }
    if (this.peekTokenIs(TokenType.FINALLY)) {
      this.nextToken();
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      finallyBlock = this.parseBlockStatement();
    }
    if (!catchBlock && !finallyBlock) {
      this.errors.push("try must have either catch or finally");
      return null;
    }
    return new TryExpression(token, tryBlock, catchParam, catchBlock, finallyBlock);
  }
  parseThrowStatement() {
    const token = this.curToken;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ExpressionStatement(token, new ThrowExpression(token, value));
  }
  parsePostfixExpression(left, op) {
    if (!(left instanceof Identifier)) {
      this.errors.push(`cannot use ${op}${op} on ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const opType = op === "+" ? TokenType.PLUS : TokenType.MINUS;
    const one = new IntegerLiteral(token, 1);
    const binExpr = new InfixExpression(new Token(opType, op), left, op, one);
    return new AssignExpression(token, left, binExpr);
  }
  parseTernaryExpression(condition) {
    const token = this.curToken;
    this.nextToken();
    const consequence = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.COLON)) return null;
    this.nextToken();
    const alternative = this.parseExpression(Precedence.LOWEST);
    return new TernaryExpression(token, condition, consequence, alternative);
  }
  parseAssignExpression(left) {
    if (left instanceof IndexExpression) {
      const token2 = this.curToken;
      this.nextToken();
      const value2 = this.parseExpression(Precedence.LOWEST);
      return new IndexAssignExpression(token2, left.left, left.index, value2);
    }
    if (!(left instanceof Identifier)) {
      this.errors.push(`cannot assign to ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    return new AssignExpression(token, left, value);
  }
  parseCompoundAssignExpression(left) {
    const token = this.curToken;
    const opMap = {
      [TokenType.PLUS_ASSIGN]: TokenType.PLUS,
      [TokenType.MINUS_ASSIGN]: TokenType.MINUS,
      [TokenType.ASTERISK_ASSIGN]: TokenType.ASTERISK,
      [TokenType.SLASH_ASSIGN]: TokenType.SLASH,
      [TokenType.PERCENT_ASSIGN]: TokenType.PERCENT
    };
    const opToken = new Token(opMap[token.type], token.literal[0]);
    this.nextToken();
    const right = this.parseExpression(Precedence.LOWEST);
    if (left instanceof Identifier) {
      const binExpr = new InfixExpression(opToken, left, opToken.literal, right);
      return new AssignExpression(token, left, binExpr);
    }
    if (left instanceof IndexExpression) {
      const readExpr = new IndexExpression(left.token, left.left, left.index);
      const binExpr = new InfixExpression(opToken, readExpr, opToken.literal, right);
      return new IndexAssignExpression(token, left.left, left.index, binExpr);
    }
    this.errors.push(`cannot compound-assign to ${left.constructor.name}`);
    return null;
  }
  parseHashLiteral() {
    const token = this.curToken;
    const pairs = /* @__PURE__ */ new Map();
    while (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      const key = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.COLON)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      pairs.set(key, value);
      if (!this.peekTokenIs(TokenType.RBRACE) && !this.expectPeek(TokenType.COMMA)) return null;
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    return new HashLiteral(token, pairs);
  }
  parseExpressionList(end) {
    const list = [];
    if (this.peekTokenIs(end)) {
      this.nextToken();
      return list;
    }
    this.nextToken();
    list.push(this._parseExprOrSpread());
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      list.push(this._parseExprOrSpread());
    }
    if (!this.expectPeek(end)) return null;
    return list;
  }
  _parseExprOrSpread() {
    if (this.curToken.type === TokenType.SPREAD) {
      const token = this.curToken;
      this.nextToken();
      return new SpreadElement(token, this.parseExpression(Precedence.PREFIX));
    }
    return this.parseExpression(Precedence.LOWEST);
  }
};

// projects/monkey-lang/src/wasm-optimize.js
function peepholeOptimize(body) {
  return 0;
}

// projects/monkey-lang/src/wasm-gc.js
var TAG_STRING = 1;
var TAG_ARRAY = 2;
var ARRAY_HEADER = 12;
var TAG_CLOSURE = 3;
var MARK_BIT = 2147483648;
var TAG_MASK = 2147483647;
var WasmGC = class {
  constructor(memoryRef, options = {}) {
    this.memoryRef = memoryRef;
    this.heapStart = options.heapStart || 4096;
    this.roots = /* @__PURE__ */ new Set();
    this.allocations = /* @__PURE__ */ new Map();
    this.freeList = [];
    this.heapPtr = this.heapStart;
    this.stats = {
      collections: 0,
      totalAllocated: 0,
      totalFreed: 0,
      currentLive: 0,
      peakLive: 0
    };
    this.threshold = options.threshold || 64 * 1024;
    this.bytesAllocatedSinceGC = 0;
    this.enabled = options.enabled !== false;
  }
  get view() {
    const mem = this.memoryRef.memory;
    if (!mem) return null;
    return new DataView(mem.buffer);
  }
  // Register a pointer as a GC root (called when storing to globals/locals)
  addRoot(ptr) {
    if (ptr > 0 && this.allocations.has(ptr)) {
      this.roots.add(ptr);
    }
  }
  removeRoot(ptr) {
    this.roots.delete(ptr);
  }
  // Update roots from a set of "live" pointers (e.g., all WASM globals)
  updateRoots(livePointers) {
    this.roots.clear();
    for (const ptr of livePointers) {
      if (ptr > 0 && this.allocations.has(ptr)) {
        this.roots.add(ptr);
      }
    }
  }
  // Allocate memory, potentially triggering GC
  alloc(size) {
    size = size + 3 & ~3;
    if (this.enabled && this.bytesAllocatedSinceGC >= this.threshold) {
      this.collect();
    }
    for (let i = 0; i < this.freeList.length; i++) {
      const block = this.freeList[i];
      if (block.size >= size) {
        this.freeList.splice(i, 1);
        if (block.size >= size + 16) {
          const remainder = { ptr: block.ptr + size, size: block.size - size };
          this.freeList.push(remainder);
          this.freeList.sort((a, b) => a.ptr - b.ptr);
          this.allocations.set(block.ptr, size);
        } else {
          this.allocations.set(block.ptr, block.size);
          size = block.size;
        }
        this.stats.currentLive += size;
        if (this.stats.currentLive > this.stats.peakLive) {
          this.stats.peakLive = this.stats.currentLive;
        }
        return block.ptr;
      }
    }
    const ptr = this.heapPtr;
    this.heapPtr += size;
    this.allocations.set(ptr, size);
    this.bytesAllocatedSinceGC += size;
    this.stats.totalAllocated += size;
    this.stats.currentLive += size;
    if (this.stats.currentLive > this.stats.peakLive) {
      this.stats.peakLive = this.stats.currentLive;
    }
    return ptr;
  }
  // Mark phase: recursively mark all reachable objects from roots
  mark() {
    const view = this.view;
    if (!view) return;
    const worklist = [...this.roots];
    while (worklist.length > 0) {
      const ptr = worklist.pop();
      if (ptr <= 0 || !this.allocations.has(ptr)) continue;
      const tag = view.getInt32(ptr, true);
      if (tag & MARK_BIT) continue;
      const rawTag = tag & TAG_MASK;
      if (rawTag !== TAG_STRING && rawTag !== TAG_ARRAY && rawTag !== TAG_CLOSURE) continue;
      view.setInt32(ptr, tag | MARK_BIT, true);
      if (rawTag === TAG_ARRAY) {
        const len = view.getInt32(ptr + 4, true);
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(ptr + ARRAY_HEADER + i * 4, true);
          if (elem > 0 && this.allocations.has(elem)) {
            worklist.push(elem);
          }
        }
      } else if (rawTag === TAG_CLOSURE) {
        const envPtr = view.getInt32(ptr + 8, true);
        if (envPtr > 0 && this.allocations.has(envPtr)) {
          worklist.push(envPtr);
        }
        const allocSize = this.allocations.get(ptr);
        const numCaptures = (allocSize - 12) / 4;
        for (let i = 0; i < numCaptures; i++) {
          const capVal = view.getInt32(ptr + 12 + i * 4, true);
          if (capVal > 0 && this.allocations.has(capVal)) {
            worklist.push(capVal);
          }
        }
      }
    }
  }
  // Sweep phase: free unmarked objects, clear mark bits on survivors
  sweep() {
    const view = this.view;
    if (!view) return 0;
    let freed = 0;
    const toFree = [];
    for (const [ptr, size] of this.allocations) {
      const tag = view.getInt32(ptr, true);
      if (tag & MARK_BIT) {
        view.setInt32(ptr, tag & TAG_MASK, true);
      } else {
        toFree.push({ ptr, size });
        freed += size;
      }
    }
    for (const { ptr, size } of toFree) {
      this.allocations.delete(ptr);
      this.freeList.push({ ptr, size });
      this.stats.currentLive -= size;
    }
    this.freeList.sort((a, b) => a.ptr - b.ptr);
    const coalesced = [];
    for (const block of this.freeList) {
      if (coalesced.length > 0) {
        const last = coalesced[coalesced.length - 1];
        if (last.ptr + last.size === block.ptr) {
          last.size += block.size;
          continue;
        }
      }
      coalesced.push({ ...block });
    }
    this.freeList = coalesced;
    this.stats.totalFreed += freed;
    return freed;
  }
  // Full GC cycle
  collect() {
    this.mark();
    const freed = this.sweep();
    this.stats.collections++;
    this.bytesAllocatedSinceGC = 0;
    return freed;
  }
  // Get allocation size for an object
  objectSize(ptr) {
    return this.allocations.get(ptr) || 0;
  }
  // Get GC statistics
  getStats() {
    return {
      ...this.stats,
      freeListBlocks: this.freeList.length,
      freeListBytes: this.freeList.reduce((s, b) => s + b.size, 0),
      liveObjects: this.allocations.size
    };
  }
};
function createGCImports(gc, outputLines = [], memoryRef = { memory: null }) {
  function readString(ptr) {
    const mem = memoryRef.memory;
    if (!mem || ptr <= 0) return "";
    const view = new DataView(mem.buffer);
    const tag = view.getInt32(ptr, true) & TAG_MASK;
    if (tag !== TAG_STRING) return String(ptr);
    const len = view.getInt32(ptr + 4, true);
    const bytes = new Uint8Array(mem.buffer, ptr + 8, len);
    return new TextDecoder().decode(bytes);
  }
  function writeString(str) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const size = 8 + bytes.length + 3 & ~3;
    const ptr = gc.alloc(size);
    const view = new DataView(mem.buffer);
    view.setInt32(ptr, TAG_STRING, true);
    view.setInt32(ptr + 4, bytes.length, true);
    new Uint8Array(mem.buffer).set(bytes, ptr + 8);
    return ptr;
  }
  const hashMaps = /* @__PURE__ */ new Map();
  let nextHashId = 1;
  return {
    env: {
      puts(value) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const tag = value > 0 && value + 8 <= view.byteLength ? view.getInt32(value, true) & TAG_MASK : 0;
          if (tag === TAG_STRING) {
            outputLines.push(readString(value));
          } else if (tag === TAG_ARRAY) {
            const len = view.getInt32(value + 4, true);
            const elems = [];
            for (let i = 0; i < len; i++) {
              const elem = view.getInt32(value + ARRAY_HEADER + i * 4, true);
              elems.push(String(elem));
            }
            outputLines.push("[" + elems.join(", ") + "]");
          } else {
            outputLines.push(String(value));
          }
        } else {
          outputLines.push(String(value));
        }
      },
      str(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        let formatted;
        if (value > 0 && value + 8 <= view.byteLength) {
          const tag = view.getInt32(value, true) & TAG_MASK;
          if (tag === TAG_STRING) formatted = readString(value);
          else if (tag === TAG_ARRAY) formatted = "[array]";
          else formatted = String(value);
        } else {
          formatted = String(value);
        }
        return writeString(formatted);
      },
      __str_concat(ptr1, ptr2) {
        return writeString(readString(ptr1) + readString(ptr2));
      },
      __str_eq(ptr1, ptr2) {
        return readString(ptr1) === readString(ptr2) ? 1 : 0;
      },
      __str_cmp(ptr1, ptr2) {
        const s1 = readString(ptr1), s2 = readString(ptr2);
        return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
      },
      __str_char_at(ptr, index) {
        const s = readString(ptr);
        if (index < 0 || index >= s.length) return 0;
        return writeString(s[index]);
      },
      __add(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            const tagB = view.getInt32(b, true) & TAG_MASK;
            if (tagA === TAG_STRING || tagB === TAG_STRING) {
              const sA = tagA === TAG_STRING ? readString(a) : String(a);
              const sB = tagB === TAG_STRING ? readString(b) : String(b);
              return writeString(sA + sB);
            }
          } catch (e) {
          }
        }
        return a + b;
      },
      __eq(a, b) {
        if (a === b) return 1;
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            const tagB = view.getInt32(b, true) & TAG_MASK;
            if (tagA === TAG_STRING && tagB === TAG_STRING) {
              return readString(a) === readString(b) ? 1 : 0;
            }
          } catch (e) {
          }
        }
        return 0;
      },
      __lt(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            if (tagA === TAG_STRING) return readString(a) < readString(b) ? 1 : 0;
          } catch (e) {
          }
        }
        return a < b ? 1 : 0;
      },
      __gt(a, b) {
        const mem = memoryRef.memory;
        if (mem && a > 0 && b > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tagA = view.getInt32(a, true) & TAG_MASK;
            if (tagA === TAG_STRING) return readString(a) > readString(b) ? 1 : 0;
          } catch (e) {
          }
        }
        return a > b ? 1 : 0;
      },
      __sub(a, b) {
        return a - b;
      },
      __mul(a, b) {
        return a * b;
      },
      __div(a, b) {
        return b !== 0 ? Math.trunc(a / b) : 0;
      },
      __mod(a, b) {
        return b !== 0 ? a % b : 0;
      },
      __neg(a) {
        return -a;
      },
      __abs(a) {
        return Math.abs(a);
      },
      __max(a, b) {
        return a > b ? a : b;
      },
      __min(a, b) {
        return a < b ? a : b;
      },
      __range(start, end) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const len = Math.max(0, end - start);
        const size = ARRAY_HEADER + len * 4 + 3 & ~3;
        const ptr = gc.alloc(size);
        const view = new DataView(mem.buffer);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, len, true);
        view.setInt32(ptr + 8, len, true);
        for (let i = 0; i < len; i++) view.setInt32(ptr + ARRAY_HEADER + i * 4, start + i, true);
        return ptr;
      },
      __join(arrPtr, sepPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return writeString("");
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true) & TAG_MASK;
        if (tag !== TAG_ARRAY) return writeString("");
        const len = view.getInt32(arrPtr + 4, true);
        const sep = sepPtr > 0 ? readString(sepPtr) : ",";
        const parts = [];
        for (let i = 0; i < len; i++) parts.push(String(view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true)));
        return writeString(parts.join(sep));
      },
      __keys(hashId) {
        return 0;
      },
      // stub
      __values(hashId) {
        return 0;
      },
      // stub
      __contains(arrPtr, elem) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        for (let i = 0; i < len; i++) {
          if (view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true) === elem) return 1;
        }
        return 0;
      },
      __reverse(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const size = ARRAY_HEADER + len * 4 + 3 & ~3;
        const ptr = gc.alloc(size);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, len, true);
        view.setInt32(ptr + 8, len, true);
        for (let i = 0; i < len; i++) {
          view.setInt32(ptr + ARRAY_HEADER + i * 4, view.getInt32(arrPtr + ARRAY_HEADER + (len - 1 - i) * 4, true), true);
        }
        return ptr;
      },
      __float_new(hi, lo) {
        return 0;
      },
      // stub
      __to_float(v) {
        return v;
      },
      // stub
      __str_split(strPtr, sepPtr) {
        return 0;
      },
      // stub
      __str_trim(strPtr) {
        return writeString(readString(strPtr).trim());
      },
      __str_replace(strPtr, fromPtr, toPtr) {
        return writeString(readString(strPtr).replace(readString(fromPtr), readString(toPtr)));
      },
      __str_indexOf(strPtr, searchPtr) {
        return readString(strPtr).indexOf(readString(searchPtr));
      },
      __str_startsWith(strPtr, prefixPtr) {
        return readString(strPtr).startsWith(readString(prefixPtr)) ? 1 : 0;
      },
      __str_endsWith(strPtr, suffixPtr) {
        return readString(strPtr).endsWith(readString(suffixPtr)) ? 1 : 0;
      },
      __str_toUpper(strPtr) {
        return writeString(readString(strPtr).toUpperCase());
      },
      __str_toLower(strPtr) {
        return writeString(readString(strPtr).toLowerCase());
      },
      __str_substring(strPtr, start, end) {
        return writeString(readString(strPtr).substring(start, end));
      },
      // Higher-order function imports
      __map(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          results.push(fn(envPtr, elem));
        }
        const size = ARRAY_HEADER + results.length * 4 + 3 & ~3;
        const ptr = gc.alloc(size);
        view = new DataView(mem.buffer);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, results.length, true);
        view.setInt32(ptr + 8, results.length, true);
        for (let i = 0; i < results.length; i++) view.setInt32(ptr + ARRAY_HEADER + i * 4, results[i], true);
        return ptr;
      },
      __filter(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          if (fn(envPtr, elem)) results.push(elem);
        }
        const size = ARRAY_HEADER + results.length * 4 + 3 & ~3;
        const ptr = gc.alloc(size);
        view.setInt32(ptr, TAG_ARRAY, true);
        view.setInt32(ptr + 4, results.length, true);
        view.setInt32(ptr + 8, results.length, true);
        for (let i = 0; i < results.length; i++) view.setInt32(ptr + ARRAY_HEADER + i * 4, results[i], true);
        return ptr;
      },
      __reduce(arrPtr, closurePtr, initValue) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const sentinel = -2147483648;
        let acc = initValue !== sentinel ? initValue : len > 0 ? view.getInt32(arrPtr + ARRAY_HEADER, true) : 0;
        const startIdx = initValue !== sentinel ? 0 : 1;
        for (let i = startIdx; i < len; i++) {
          view = new DataView(mem.buffer);
          acc = fn(envPtr, acc, view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true));
        }
        return acc;
      },
      __find(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          if (fn(envPtr, elem)) return elem;
        }
        return 0;
      },
      __any(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          if (fn(envPtr, view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true))) return 1;
        }
        return 0;
      },
      __every(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || (view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          if (!fn(envPtr, view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true))) return 0;
        }
        return 1;
      },
      __array_concat(arrA, arrB) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        const lenA = arrA > 0 && (view.getInt32(arrA, true) & TAG_MASK) === TAG_ARRAY ? view.getInt32(arrA + 4, true) : 0;
        const lenB = arrB > 0 && (view.getInt32(arrB, true) & TAG_MASK) === TAG_ARRAY ? view.getInt32(arrB + 4, true) : 0;
        const newLen = lenA + lenB;
        const size = ARRAY_HEADER + newLen * 4 + 3 & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newLen, true);
        for (let i = 0; i < lenA; i++) {
          view.setInt32(newPtr + ARRAY_HEADER + i * 4, view.getInt32(arrA + ARRAY_HEADER + i * 4, true), true);
        }
        for (let i = 0; i < lenB; i++) {
          view.setInt32(newPtr + ARRAY_HEADER + (lenA + i) * 4, view.getInt32(arrB + ARRAY_HEADER + i * 4, true), true);
        }
        return newPtr;
      },
      __rest(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (len <= 0) return 0;
        const newLen = len - 1;
        const size = ARRAY_HEADER + newLen * 4 + 3 & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newLen, true);
        for (let i = 0; i < newLen; i++) {
          view.setInt32(newPtr + ARRAY_HEADER + i * 4, view.getInt32(arrPtr + ARRAY_HEADER + (i + 1) * 4, true), true);
        }
        return newPtr;
      },
      __type(value) {
        const mem = memoryRef.memory;
        if (!mem) return writeString("unknown");
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true) & TAG_MASK;
            if (tag === TAG_STRING) return writeString("STRING");
            if (tag === TAG_ARRAY) return writeString("ARRAY");
            if (tag === TAG_CLOSURE) return writeString("FUNCTION");
          } catch (e) {
          }
        }
        return writeString("INTEGER");
      },
      __int(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true) & TAG_MASK;
            if (tag === TAG_STRING) {
              return parseInt(readString(value), 10) || 0;
            }
          } catch (e) {
          }
        }
        return value;
      },
      __slice(arrPtr, start, end) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(arrPtr, true) & TAG_MASK) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (end <= 0) end = len;
        if (start < 0) start = 0;
        if (end > len) end = len;
        const newLen = Math.max(0, end - start);
        const size = ARRAY_HEADER + newLen * 4 + 3 & ~3;
        const newPtr = gc.alloc(size);
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newLen, true);
        for (let i = 0; i < newLen; i++) {
          view.setInt32(newPtr + ARRAY_HEADER + i * 4, view.getInt32(arrPtr + ARRAY_HEADER + (start + i) * 4, true), true);
        }
        return newPtr;
      },
      __hash_new() {
        const id = nextHashId++;
        hashMaps.set(id, /* @__PURE__ */ new Map());
        return id;
      },
      __hash_set(hashId, key, value) {
        const map = hashMaps.get(hashId);
        if (!map) return hashId;
        let resolvedKey = key;
        const mem = memoryRef.memory;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
              resolvedKey = "s:" + readString(key);
            }
          } catch (e) {
          }
        }
        map.set(resolvedKey, value);
        return hashId;
      },
      __hash_get(hashId, key) {
        const map = hashMaps.get(hashId);
        if (!map) return 0;
        let resolvedKey = key;
        const mem = memoryRef.memory;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            if ((view.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
              resolvedKey = "s:" + readString(key);
            }
          } catch (e) {
          }
        }
        return map.get(resolvedKey) || 0;
      },
      __index_get(obj, key) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          let resolvedKey = key;
          const mem2 = memoryRef.memory;
          if (mem2 && key > 0) {
            const view2 = new DataView(mem2.buffer);
            try {
              if ((view2.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
                resolvedKey = "s:" + readString(key);
              }
            } catch (e) {
            }
          }
          return map.get(resolvedKey) || 0;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true) & TAG_MASK;
        if (tag === TAG_STRING) {
          const str = readString(obj);
          if (key < 0 || key >= str.length) return 0;
          return writeString(str[key]);
        }
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return 0;
        return view.getInt32(obj + ARRAY_HEADER + key * 4, true);
      },
      __index_set(obj, key, value) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          let resolvedKey = key;
          const mem2 = memoryRef.memory;
          if (mem2 && key > 0) {
            const view2 = new DataView(mem2.buffer);
            try {
              if ((view2.getInt32(key, true) & TAG_MASK) === TAG_STRING) {
                resolvedKey = "s:" + readString(key);
              }
            } catch (e) {
            }
          }
          map.set(resolvedKey, value);
          return;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return;
        const view = new DataView(mem.buffer);
        if ((view.getInt32(obj, true) & TAG_MASK) !== TAG_ARRAY) return;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return;
        view.setInt32(obj + ARRAY_HEADER + key * 4, value, true);
      },
      // GC control
      __gc_collect() {
        return gc.collect();
      },
      __gc_stats() {
        const stats = gc.getStats();
        return stats.currentLive;
      },
      __gc_alloc(size) {
        return gc.alloc(size);
      },
      __gc_register(ptr, size) {
        gc.allocations.set(ptr, size);
        gc.stats.totalAllocated += size;
        gc.stats.currentLive += size;
        if (gc.stats.currentLive > gc.stats.peakLive) {
          gc.stats.peakLive = gc.stats.currentLive;
        }
        gc.bytesAllocatedSinceGC += size;
      },
      __gc_add_root(ptr) {
        gc.addRoot(ptr);
      },
      __gc_remove_root(ptr) {
        gc.removeRoot(ptr);
      }
    }
  };
}

// projects/monkey-lang/src/constant-fold.js
function constantFold(node) {
  if (!node) return node;
  if (node instanceof Program) {
    node.statements = node.statements.map((s) => constantFold(s));
    return node;
  }
  if (node instanceof ExpressionStatement) {
    node.expression = constantFold(node.expression);
    return node;
  }
  if (node instanceof LetStatement) {
    node.value = constantFold(node.value);
    return node;
  }
  if (node instanceof ReturnStatement) {
    node.returnValue = constantFold(node.returnValue);
    return node;
  }
  if (node instanceof BlockStatement) {
    node.statements = node.statements.map((s) => constantFold(s));
    return node;
  }
  if (node instanceof IfExpression) {
    node.condition = constantFold(node.condition);
    if (node.consequence) node.consequence = constantFold(node.consequence);
    if (node.alternative) node.alternative = constantFold(node.alternative);
    if (node.condition instanceof BooleanLiteral) {
      if (node.condition.value) {
        return node.consequence || node;
      } else {
        return node.alternative || new IntegerLiteral(null, 0);
      }
    }
    return node;
  }
  if (node instanceof ArrayLiteral) {
    if (node.elements) node.elements = node.elements.map((e) => constantFold(e));
    return node;
  }
  if (node instanceof HashLiteral) {
    if (node.pairs) {
      const newPairs = /* @__PURE__ */ new Map();
      for (const [k, v] of node.pairs) {
        newPairs.set(constantFold(k), constantFold(v));
      }
      node.pairs = newPairs;
    }
    return node;
  }
  if (node instanceof CallExpression) {
    if (node.arguments) node.arguments = node.arguments.map((a) => constantFold(a));
    return node;
  }
  if (node instanceof IndexExpression) {
    node.left = constantFold(node.left);
    node.index = constantFold(node.index);
    return node;
  }
  if (node instanceof FunctionLiteral) {
    if (node.body) node.body = constantFold(node.body);
    return node;
  }
  if (node instanceof PrefixExpression) {
    node.right = constantFold(node.right);
    if (node.operator === "-" && node.right instanceof IntegerLiteral) {
      return new IntegerLiteral(node.token, -node.right.value);
    }
    if (node.operator === "!" && node.right instanceof BooleanLiteral) {
      return new BooleanLiteral(node.token, !node.right.value);
    }
    if (node.operator === "!" && node.right instanceof IntegerLiteral) {
      return new BooleanLiteral(node.token, node.right.value === 0);
    }
    return node;
  }
  if (node instanceof InfixExpression) {
    node.left = constantFold(node.left);
    node.right = constantFold(node.right);
    const left = node.left;
    const right = node.right;
    if (left instanceof IntegerLiteral && right instanceof IntegerLiteral) {
      const a = left.value, b = right.value;
      switch (node.operator) {
        case "+":
          return new IntegerLiteral(node.token, a + b);
        case "-":
          return new IntegerLiteral(node.token, a - b);
        case "*":
          return new IntegerLiteral(node.token, a * b);
        case "/":
          return b !== 0 ? new IntegerLiteral(node.token, Math.trunc(a / b)) : node;
        case "%":
          return b !== 0 ? new IntegerLiteral(node.token, a % b) : node;
        case "<":
          return new BooleanLiteral(node.token, a < b);
        case ">":
          return new BooleanLiteral(node.token, a > b);
        case "<=":
          return new BooleanLiteral(node.token, a <= b);
        case ">=":
          return new BooleanLiteral(node.token, a >= b);
        case "==":
          return new BooleanLiteral(node.token, a === b);
        case "!=":
          return new BooleanLiteral(node.token, a !== b);
      }
    }
    if (left instanceof StringLiteral && right instanceof StringLiteral) {
      if (node.operator === "+") {
        return new StringLiteral(node.token, left.value + right.value);
      }
      if (node.operator === "==") {
        return new BooleanLiteral(node.token, left.value === right.value);
      }
      if (node.operator === "!=") {
        return new BooleanLiteral(node.token, left.value !== right.value);
      }
    }
    if (left instanceof BooleanLiteral && right instanceof BooleanLiteral) {
      if (node.operator === "==") return new BooleanLiteral(node.token, left.value === right.value);
      if (node.operator === "!=") return new BooleanLiteral(node.token, left.value !== right.value);
      if (node.operator === "&&") return new BooleanLiteral(node.token, left.value && right.value);
      if (node.operator === "||") return new BooleanLiteral(node.token, left.value || right.value);
    }
    if (right instanceof IntegerLiteral) {
      if (right.value === 0 && node.operator === "+") return left;
      if (right.value === 0 && node.operator === "-") return left;
      if (right.value === 1 && node.operator === "*") return left;
      if (right.value === 0 && node.operator === "*") return new IntegerLiteral(node.token, 0);
    }
    if (left instanceof IntegerLiteral) {
      if (left.value === 0 && node.operator === "+") return right;
      if (left.value === 1 && node.operator === "*") return right;
      if (left.value === 0 && node.operator === "*") return new IntegerLiteral(node.token, 0);
    }
    return node;
  }
  return node;
}

// projects/monkey-lang/src/dead-code.js
function eliminateDeadCode(node) {
  if (!node) return node;
  if (node instanceof Program) {
    node.statements = eliminateStatementList(node.statements);
    return node;
  }
  if (node instanceof BlockStatement) {
    node.statements = eliminateStatementList(node.statements);
    return node;
  }
  if (node instanceof IfExpression) {
    if (node.consequence) node.consequence = eliminateDeadCode(node.consequence);
    if (node.alternative) node.alternative = eliminateDeadCode(node.alternative);
    return node;
  }
  if (node instanceof FunctionLiteral) {
    if (node.body) node.body = eliminateDeadCode(node.body);
    return node;
  }
  if (node instanceof LetStatement) {
    if (node.value) node.value = eliminateDeadCodeExpr(node.value);
    return node;
  }
  if (node instanceof ExpressionStatement) {
    if (node.expression) node.expression = eliminateDeadCodeExpr(node.expression);
    return node;
  }
  return node;
}
function eliminateDeadCodeExpr(expr) {
  if (!expr) return expr;
  if (expr instanceof FunctionLiteral) {
    if (expr.body) expr.body = eliminateDeadCode(expr.body);
    return expr;
  }
  if (expr instanceof IfExpression) {
    if (expr.consequence) expr.consequence = eliminateDeadCode(expr.consequence);
    if (expr.alternative) expr.alternative = eliminateDeadCode(expr.alternative);
    return expr;
  }
  if (expr instanceof WhileExpression) {
    if (expr.body) expr.body = eliminateDeadCode(expr.body);
    return expr;
  }
  if (expr instanceof ForExpression) {
    if (expr.body) expr.body = eliminateDeadCode(expr.body);
    return expr;
  }
  if (expr instanceof CallExpression) {
    if (expr.arguments) expr.arguments = expr.arguments.map((a) => eliminateDeadCodeExpr(a));
    return expr;
  }
  return expr;
}
function eliminateStatementList(statements) {
  if (!statements) return statements;
  const result = [];
  for (const stmt of statements) {
    const processed = eliminateDeadCode(stmt);
    result.push(processed);
    if (isTerminating(stmt)) {
      break;
    }
  }
  return result;
}
function isTerminating(stmt) {
  if (stmt instanceof ReturnStatement) return true;
  if (stmt instanceof BreakStatement) return true;
  if (stmt instanceof ContinueStatement) return true;
  if (stmt instanceof ExpressionStatement) {
    return isTerminating(stmt.expression);
  }
  return false;
}

// projects/monkey-lang/src/type-inference.js
var Types = {
  INT: "int",
  BOOL: "bool",
  STRING: "string",
  ARRAY: "array",
  HASH: "hash",
  FUNCTION: "function",
  NULL: "null",
  UNKNOWN: "unknown"
};
var TypeEnv = class _TypeEnv {
  constructor(parent = null) {
    this.bindings = /* @__PURE__ */ new Map();
    this.parent = parent;
  }
  get(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    if (this.parent) return this.parent.get(name);
    return Types.UNKNOWN;
  }
  set(name, type) {
    this.bindings.set(name, type);
  }
  child() {
    return new _TypeEnv(this);
  }
};
var TypeInference = class {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  infer(program) {
    const env = new TypeEnv();
    env.set("puts", Types.FUNCTION);
    env.set("len", Types.FUNCTION);
    env.set("first", Types.FUNCTION);
    env.set("last", Types.FUNCTION);
    env.set("rest", Types.FUNCTION);
    env.set("push", Types.FUNCTION);
    env.set("str", Types.FUNCTION);
    env.set("type", Types.FUNCTION);
    env.set("int", Types.FUNCTION);
    this.inferStatements(program.statements, env);
    return { errors: this.errors, warnings: this.warnings };
  }
  inferStatements(statements, env) {
    let lastType = Types.NULL;
    for (const stmt of statements) {
      lastType = this.inferStatement(stmt, env);
    }
    return lastType;
  }
  inferStatement(stmt, env) {
    if (stmt instanceof LetStatement) {
      const type = this.inferExpression(stmt.value, env);
      env.set(stmt.name.value, type);
      stmt.inferredType = type;
      return type;
    }
    if (stmt instanceof ReturnStatement) {
      const type = this.inferExpression(stmt.returnValue, env);
      stmt.inferredType = type;
      return type;
    }
    if (stmt instanceof ExpressionStatement) {
      const type = this.inferExpression(stmt.expression, env);
      stmt.inferredType = type;
      return type;
    }
    if (stmt instanceof AssignExpression) {
      const type = this.inferExpression(stmt.value, env);
      if (stmt.name) env.set(stmt.name.value, type);
      stmt.inferredType = type;
      return type;
    }
    if (stmt instanceof BlockStatement) {
      return this.inferStatements(stmt.statements, env);
    }
    return Types.UNKNOWN;
  }
  inferExpression(expr, env) {
    if (!expr) return Types.NULL;
    if (expr instanceof IntegerLiteral) {
      expr.inferredType = Types.INT;
      return Types.INT;
    }
    if (expr instanceof BooleanLiteral) {
      expr.inferredType = Types.BOOL;
      return Types.BOOL;
    }
    if (expr instanceof StringLiteral) {
      expr.inferredType = Types.STRING;
      return Types.STRING;
    }
    if (expr instanceof NullLiteral) {
      expr.inferredType = Types.NULL;
      return Types.NULL;
    }
    if (expr instanceof ArrayLiteral) {
      expr.inferredType = Types.ARRAY;
      if (expr.elements) {
        for (const el of expr.elements) {
          this.inferExpression(el, env);
        }
      }
      return Types.ARRAY;
    }
    if (expr instanceof HashLiteral) {
      expr.inferredType = Types.HASH;
      if (expr.pairs) {
        for (const [k, v] of expr.pairs) {
          this.inferExpression(k, env);
          this.inferExpression(v, env);
        }
      }
      return Types.HASH;
    }
    if (expr instanceof Identifier) {
      const type = env.get(expr.value);
      expr.inferredType = type;
      return type;
    }
    if (expr instanceof PrefixExpression) {
      const rightType = this.inferExpression(expr.right, env);
      if (expr.operator === "!") {
        expr.inferredType = Types.BOOL;
        return Types.BOOL;
      }
      if (expr.operator === "-") {
        expr.inferredType = Types.INT;
        if (rightType !== Types.INT && rightType !== Types.UNKNOWN) {
          this.warnings.push(`Negation of non-integer type '${rightType}'`);
        }
        return Types.INT;
      }
      expr.inferredType = rightType;
      return rightType;
    }
    if (expr instanceof InfixExpression) {
      const leftType = this.inferExpression(expr.left, env);
      const rightType = this.inferExpression(expr.right, env);
      if (["<", ">", "<=", ">=", "==", "!="].includes(expr.operator)) {
        expr.inferredType = Types.BOOL;
        return Types.BOOL;
      }
      if (expr.operator === "+") {
        if (leftType === Types.STRING || rightType === Types.STRING) {
          if (leftType !== Types.STRING && leftType !== Types.UNKNOWN) {
            this.warnings.push(`Implicit string conversion: '${leftType}' + '${rightType}'`);
          }
          if (rightType !== Types.STRING && rightType !== Types.UNKNOWN) {
            this.warnings.push(`Implicit string conversion: '${leftType}' + '${rightType}'`);
          }
          expr.inferredType = Types.STRING;
          return Types.STRING;
        }
        if (leftType !== Types.INT && leftType !== Types.UNKNOWN) {
          this.warnings.push(`Addition of non-integer type '${leftType}'`);
        }
        if (rightType !== Types.INT && rightType !== Types.UNKNOWN) {
          this.warnings.push(`Addition of non-integer type '${rightType}'`);
        }
        expr.inferredType = Types.INT;
        return Types.INT;
      }
      if (["-", "*", "/", "%"].includes(expr.operator)) {
        expr.inferredType = Types.INT;
        if (leftType !== Types.INT && leftType !== Types.UNKNOWN) {
          this.warnings.push(`Arithmetic operator '${expr.operator}' on non-integer type '${leftType}'`);
        }
        if (rightType !== Types.INT && rightType !== Types.UNKNOWN) {
          this.warnings.push(`Arithmetic operator '${expr.operator}' on non-integer type '${rightType}'`);
        }
        return Types.INT;
      }
      if (["&&", "||"].includes(expr.operator)) {
        expr.inferredType = Types.BOOL;
        return Types.BOOL;
      }
      expr.inferredType = Types.UNKNOWN;
      return Types.UNKNOWN;
    }
    if (expr instanceof IfExpression) {
      this.inferExpression(expr.condition, env);
      const consType = expr.consequence ? this.inferStatement(expr.consequence, env) : Types.NULL;
      const altType = expr.alternative ? this.inferStatement(expr.alternative, env) : Types.NULL;
      const type = consType === altType ? consType : Types.UNKNOWN;
      expr.inferredType = type;
      return type;
    }
    if (expr instanceof FunctionLiteral) {
      expr.inferredType = Types.FUNCTION;
      const fnEnv = env.child();
      if (expr.parameters) {
        for (const param of expr.parameters) {
          fnEnv.set(param.value, Types.UNKNOWN);
        }
      }
      if (expr.body) {
        this.inferStatement(expr.body, fnEnv);
      }
      return Types.FUNCTION;
    }
    if (expr instanceof CallExpression) {
      const fnType = this.inferExpression(expr.function, env);
      if (expr.arguments) {
        for (const arg of expr.arguments) {
          this.inferExpression(arg, env);
        }
      }
      const fnName = expr.function instanceof Identifier ? expr.function.value : null;
      if (fnName === "len") {
        expr.inferredType = Types.INT;
        return Types.INT;
      }
      if (fnName === "str") {
        expr.inferredType = Types.STRING;
        return Types.STRING;
      }
      if (fnName === "int") {
        expr.inferredType = Types.INT;
        return Types.INT;
      }
      if (fnName === "type") {
        expr.inferredType = Types.STRING;
        return Types.STRING;
      }
      if (fnName === "push") {
        expr.inferredType = Types.ARRAY;
        return Types.ARRAY;
      }
      if (fnName === "first" || fnName === "last") {
        expr.inferredType = Types.UNKNOWN;
        return Types.UNKNOWN;
      }
      if (fnName === "rest") {
        expr.inferredType = Types.ARRAY;
        return Types.ARRAY;
      }
      expr.inferredType = Types.UNKNOWN;
      return Types.UNKNOWN;
    }
    if (expr instanceof IndexExpression) {
      const leftType = this.inferExpression(expr.left, env);
      this.inferExpression(expr.index, env);
      if (leftType === Types.STRING) {
        expr.inferredType = Types.STRING;
        return Types.STRING;
      }
      expr.inferredType = Types.UNKNOWN;
      return Types.UNKNOWN;
    }
    if (expr instanceof WhileExpression || expr instanceof ForExpression) {
      if (expr.condition) this.inferExpression(expr.condition, env);
      if (expr.body) this.inferStatement(expr.body, env);
      expr.inferredType = Types.NULL;
      return Types.NULL;
    }
    if (expr.inferredType === void 0) expr.inferredType = Types.UNKNOWN;
    return Types.UNKNOWN;
  }
};

// projects/monkey-lang/src/wasm-compiler.js
var TAG_STRING2 = 1;
var TAG_ARRAY2 = 2;
var ARRAY_HEADER2 = 12;
var TAG_CLOSURE2 = 3;
var TAG_HASH = 4;
var TAG_FLOAT = 5;
var Scope = class {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = /* @__PURE__ */ new Map();
    this.nextLocal = parent ? 0 : 0;
  }
  define(name, index, type = ValType.i32, knownInt = false) {
    this.vars.set(name, { index, type, knownInt });
  }
  // Note: markCaptured was used for the pre-box env write-back approach.
  // It's been replaced by the box/cell pattern. Kept for compatibility but unused.
  markCaptured(name, envPtrLocal, envOffset) {
    const v = this.vars.get(name);
    if (v) {
      v.captured = true;
      v.envPtrLocal = envPtrLocal;
      v.envOffset = envOffset;
    }
  }
  resolve(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.resolve(name);
    return null;
  }
};
var WasmCompiler = class {
  constructor() {
    this.builder = new WasmModuleBuilder();
    this.functions = [];
    this.globalScope = new Scope();
    this.currentFunc = null;
    this.currentBody = null;
    this.currentScope = null;
    this.nextParamIndex = 0;
    this.nextLocalIndex = 0;
    this.loopStack = [];
    this.blockDepth = 0;
    this.errors = [];
    this.warnings = [];
    this.stringConstants = [];
    this.nextDataOffset = 65536;
    this.closureFuncs = [];
    this.nextTableSlot = 0;
    this._classRegistry = /* @__PURE__ */ new Map();
    this._currentClassName = null;
    this._boxedVars = /* @__PURE__ */ new Map();
    this._scopeIdStack = ["top"];
    this._boxedLocals = /* @__PURE__ */ new Map();
    this.stats = {
      constantsFolded: 0,
      functionsCompiled: 0,
      closuresCreated: 0,
      stringsAllocated: 0,
      arraysAllocated: 0,
      directArith: 0,
      // direct i32 arithmetic (fast path)
      hostArith: 0,
      // host import arithmetic (slow path)
      directCalls: 0,
      // direct function calls
      indirectCalls: 0,
      // call_indirect via table
      knownIntVars: 0
      // variables with knownInt flag
    };
    this.builder.addMemory(64, 256);
    const exTagType = this.builder.addType([ValType.i32], []);
    this._exceptionTagIdx = this.builder.addTag(exTagType);
    this.builder.addExport("memory", ExportKind.Memory, 0);
    this.heapPtr = this.builder.addGlobal(ValType.i32, true, 131072);
    this._runtimeFuncs = {};
  }
  compile(input) {
    if (typeof input !== "string") {
      throw new TypeError(`WasmCompiler.compile() expects a string, got ${typeof input}. Use compileProgram() for AST objects.`);
    }
    const lexer = new Lexer(input);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    if (parser.errors.length > 0) {
      this.errors = parser.errors;
      return null;
    }
    return this.compileProgram(program);
  }
  compileProgram(program) {
    this._addRuntimeFunctions();
    this._boxedVars = this._analyzeBoxedVariables(program);
    const topLevelFuncNames = /* @__PURE__ */ new Set();
    for (const stmt of program.statements) {
      if (stmt instanceof LetStatement && stmt.value instanceof FunctionLiteral) {
        topLevelFuncNames.add(stmt.name.value);
      }
    }
    for (const stmt of program.statements) {
      if (stmt instanceof LetStatement && stmt.value instanceof FunctionLiteral) {
        const topBoxed = this._boxedVars.get("top");
        if (topBoxed && topBoxed.has(stmt.name.value)) {
          continue;
        }
        const params = new Set(stmt.value.parameters.map((p) => p.value || p.token?.literal));
        const hasFreeVars = this._hasFreeVariables(stmt.value, params, topLevelFuncNames, stmt.name.value);
        if (!hasFreeVars) {
          this._declareFunction(stmt.name.value, stmt.value);
        }
      }
    }
    const mainType = this.builder.addType([], [ValType.i32]);
    const { index: mainIdx, body: mainBody } = this.builder.addFunction([], [ValType.i32]);
    this.builder.addExport("main", ExportKind.Func, mainIdx);
    this.currentFunc = { name: "main", index: mainIdx };
    this.currentBody = mainBody;
    this.currentScope = new Scope(this.globalScope);
    this.nextParamIndex = 0;
    this.nextLocalIndex = 0;
    this._inferReturnTypes();
    let lastIsExpr = false;
    for (let i = 0; i < program.statements.length; i++) {
      const stmt = program.statements[i];
      lastIsExpr = false;
      if (stmt instanceof LetStatement && stmt.value instanceof FunctionLiteral) {
        const binding = this.currentScope.resolve(stmt.name.value);
        if (binding && binding.type === "func") {
          continue;
        }
      }
      if (stmt instanceof LetStatement && stmt.value instanceof ClassStatement) {
        this.compileClassStatement(stmt.value, stmt.name.value);
        continue;
      }
      if (stmt instanceof ExpressionStatement) {
        this.compileNode(stmt.expression);
        if (i < program.statements.length - 1) {
          mainBody.drop();
        } else {
          lastIsExpr = true;
        }
      } else if (stmt instanceof ReturnStatement) {
        this.compileNode(stmt.returnValue);
        mainBody.return_();
        lastIsExpr = true;
      } else {
        this.compileStatement(stmt);
      }
    }
    if (!lastIsExpr) {
      mainBody.i32Const(0);
    }
    this._compileFunctions();
    for (const sc of this.stringConstants) {
      const encoder = new TextEncoder();
      const strBytes = encoder.encode(sc.value);
      const data = new Uint8Array(8 + strBytes.length);
      const view = new DataView(data.buffer);
      view.setInt32(0, TAG_STRING2, true);
      view.setInt32(4, strBytes.length, true);
      data.set(strBytes, 8);
      this.builder.addDataSegment(sc.offset, [...data]);
    }
    if (this.closureFuncs.length > 0) {
      const tableSize = this.closureFuncs.length;
      const tableIdx = this.builder.addTable(ValType.funcref, tableSize, tableSize);
      const funcIndices = new Array(tableSize);
      for (const cf of this.closureFuncs) {
        funcIndices[cf.tableIndex] = cf.wasmFuncIndex;
      }
      this.builder.addElement(0, 0, funcIndices);
      this.builder.addExport("__indirect_function_table", ExportKind.Table, tableIdx);
    }
    for (const func of this.builder.functions) {
      peepholeOptimize(func.body);
    }
    return this.builder;
  }
  _addRuntimeFunctions() {
    const putsIdx = this.builder.addImport("env", "puts", [ValType.i32], []);
    this._runtimeFuncs.puts = putsIdx;
    this.globalScope.define("puts", putsIdx, "func");
    const strIdx = this.builder.addImport("env", "str", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.str = strIdx;
    this.globalScope.define("str", strIdx, "func");
    const strConcatIdx = this.builder.addImport("env", "__str_concat", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strConcat = strConcatIdx;
    const strEqIdx = this.builder.addImport("env", "__str_eq", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strEq = strEqIdx;
    const strCmpIdx = this.builder.addImport("env", "__str_cmp", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strCmp = strCmpIdx;
    const strCharAtIdx = this.builder.addImport("env", "__str_char_at", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strCharAt = strCharAtIdx;
    const strSplitIdx = this.builder.addImport("env", "__str_split", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strSplit = strSplitIdx;
    const strTrimIdx = this.builder.addImport("env", "__str_trim", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strTrim = strTrimIdx;
    const strReplaceIdx = this.builder.addImport("env", "__str_replace", [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strReplace = strReplaceIdx;
    const strIndexOfIdx = this.builder.addImport("env", "__str_indexOf", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strIndexOf = strIndexOfIdx;
    const strStartsWithIdx = this.builder.addImport("env", "__str_startsWith", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strStartsWith = strStartsWithIdx;
    const strEndsWithIdx = this.builder.addImport("env", "__str_endsWith", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strEndsWith = strEndsWithIdx;
    const strUpperIdx = this.builder.addImport("env", "__str_toUpper", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strUpper = strUpperIdx;
    const strLowerIdx = this.builder.addImport("env", "__str_toLower", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strLower = strLowerIdx;
    const strSubstringIdx = this.builder.addImport("env", "__str_substring", [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strSubstring = strSubstringIdx;
    const addIdx = this.builder.addImport("env", "__add", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.add = addIdx;
    const eqIdx = this.builder.addImport("env", "__eq", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.eq = eqIdx;
    const ltIdx = this.builder.addImport("env", "__lt", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.lt = ltIdx;
    const gtIdx = this.builder.addImport("env", "__gt", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.gt = gtIdx;
    const arrayConcatIdx = this.builder.addImport("env", "__array_concat", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.arrayConcat = arrayConcatIdx;
    const restIdx = this.builder.addImport("env", "__rest", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.rest = restIdx;
    const typeIdx = this.builder.addImport("env", "__type", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.type = typeIdx;
    this.globalScope.define("type", typeIdx, "func");
    const intIdx = this.builder.addImport("env", "__int", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.int = intIdx;
    this.globalScope.define("int", intIdx, "func");
    const absIdx = this.builder.addImport("env", "__abs", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.abs = absIdx;
    this.globalScope.define("abs", absIdx, "func");
    const maxIdx = this.builder.addImport("env", "__max", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.max = maxIdx;
    const minIdx = this.builder.addImport("env", "__min", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.min = minIdx;
    const rangeIdx = this.builder.addImport("env", "__range", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.range = rangeIdx;
    const joinIdx = this.builder.addImport("env", "__join", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.join = joinIdx;
    const keysIdx = this.builder.addImport("env", "__keys", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.keys = keysIdx;
    const valuesIdx = this.builder.addImport("env", "__values", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.values = valuesIdx;
    const iterPrepIdx = this.builder.addImport("env", "__iter_prepare", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.iterPrepare = iterPrepIdx;
    const hashDeleteIdx = this.builder.addImport("env", "__hash_delete", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashDelete = hashDeleteIdx;
    const hashHasIdx = this.builder.addImport("env", "__hash_has", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashHas = hashHasIdx;
    const hashMergeIdx = this.builder.addImport("env", "__hash_merge", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashMerge = hashMergeIdx;
    const containsIdx = this.builder.addImport("env", "__contains", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.contains = containsIdx;
    const reverseIdx = this.builder.addImport("env", "__reverse", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.reverse = reverseIdx;
    const mapIdx = this.builder.addImport("env", "__map", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.map = mapIdx;
    const filterIdx = this.builder.addImport("env", "__filter", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.filter = filterIdx;
    const reduceIdx = this.builder.addImport("env", "__reduce", [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.reduce = reduceIdx;
    const findIdx = this.builder.addImport("env", "__find", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.find = findIdx;
    const anyIdx = this.builder.addImport("env", "__any", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.any = anyIdx;
    const everyIdx = this.builder.addImport("env", "__every", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.every = everyIdx;
    const sortIdx = this.builder.addImport("env", "__sort", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.sort = sortIdx;
    const forEachIdx = this.builder.addImport("env", "__forEach", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.forEach = forEachIdx;
    const flatMapIdx = this.builder.addImport("env", "__flatMap", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.flatMap = flatMapIdx;
    const zipIdx = this.builder.addImport("env", "__zip", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.zip = zipIdx;
    const enumerateIdx = this.builder.addImport("env", "__enumerate", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.enumerate = enumerateIdx;
    const sliceIdx = this.builder.addImport("env", "__slice", [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.slice = sliceIdx;
    const hashNewIdx = this.builder.addImport("env", "__hash_new", [], [ValType.i32]);
    this._runtimeFuncs.hashNew = hashNewIdx;
    const hashSetIdx = this.builder.addImport("env", "__hash_set", [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashSet = hashSetIdx;
    const hashGetIdx = this.builder.addImport("env", "__hash_get", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashGet = hashGetIdx;
    const indexGetIdx = this.builder.addImport("env", "__index_get", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.indexGet = indexGetIdx;
    const indexSetIdx = this.builder.addImport("env", "__index_set", [ValType.i32, ValType.i32, ValType.i32], []);
    this._runtimeFuncs.indexSet = indexSetIdx;
    const gcAllocIdx = this.builder.addImport("env", "__gc_alloc", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.gcAlloc = gcAllocIdx;
    const gcCollectIdx = this.builder.addImport("env", "__gc_collect", [], [ValType.i32]);
    this._runtimeFuncs.gcCollect = gcCollectIdx;
    const gcRegisterIdx = this.builder.addImport("env", "__gc_register", [ValType.i32, ValType.i32], []);
    this._runtimeFuncs.gcRegister = gcRegisterIdx;
    const gcAddRootIdx = this.builder.addImport("env", "__gc_add_root", [ValType.i32], []);
    this._runtimeFuncs.gcAddRoot = gcAddRootIdx;
    const gcRemoveRootIdx = this.builder.addImport("env", "__gc_remove_root", [ValType.i32], []);
    this._runtimeFuncs.gcRemoveRoot = gcRemoveRootIdx;
    const floatNewIdx = this.builder.addImport("env", "__float_new", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.floatNew = floatNewIdx;
    const subIdx = this.builder.addImport("env", "__sub", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.sub = subIdx;
    const mulIdx = this.builder.addImport("env", "__mul", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.mul = mulIdx;
    const divIdx = this.builder.addImport("env", "__div", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.div = divIdx;
    const modIdx = this.builder.addImport("env", "__mod", [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.mod = modIdx;
    const negIdx = this.builder.addImport("env", "__neg", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.neg = negIdx;
    const toFloatIdx = this.builder.addImport("env", "__to_float", [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.toFloat = toFloatIdx;
    const { index: allocIdx, body: allocBody } = this.builder.addFunction(
      [ValType.i32],
      [ValType.i32]
    );
    allocBody.addLocal(ValType.i32);
    allocBody.addLocal(ValType.i32);
    allocBody.globalGet(this.heapPtr).localTee(1).localGet(0).emit(Op.i32_add).localTee(2);
    allocBody.emit(Op.memory_size, 0).i32Const(16).emit(Op.i32_shl).emit(Op.i32_gt_u);
    allocBody.if_();
    allocBody.localGet(2).emit(Op.memory_size, 0).i32Const(16).emit(Op.i32_shl).emit(Op.i32_sub).i32Const(16).emit(Op.i32_shr_u).i32Const(17).emit(Op.i32_add).emit(Op.memory_grow, 0).emit(Op.drop);
    allocBody.end();
    allocBody.localGet(2).globalSet(this.heapPtr).localGet(1).localGet(0).call(gcRegisterIdx);
    allocBody.localGet(1);
    this._runtimeFuncs.alloc = allocIdx;
    this.builder.addExport("__alloc", ExportKind.Func, allocIdx);
    const { index: lenIdx, body: lenBody } = this.builder.addFunction(
      [ValType.i32],
      [ValType.i32]
    );
    lenBody.addLocal(ValType.i32);
    lenBody.localGet(0).i32Load().localSet(1).localGet(1).i32Const(TAG_HASH).emit(Op.i32_eq).if_(ValType.i32).localGet(0).i32Const(8).emit(Op.i32_add).i32Load().else_().localGet(0).i32Const(4).emit(Op.i32_add).i32Load().end();
    this._runtimeFuncs.len = lenIdx;
    const { index: arrGetIdx, body: arrGetBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32],
      [ValType.i32]
    );
    arrGetBody.localGet(0).i32Const(ARRAY_HEADER2).emit(Op.i32_add).localGet(1).i32Const(4).emit(Op.i32_mul).emit(Op.i32_add).i32Load();
    this._runtimeFuncs.arrayGet = arrGetIdx;
    const { index: arrSetIdx, body: arrSetBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32],
      []
    );
    arrSetBody.localGet(0).i32Const(ARRAY_HEADER2).emit(Op.i32_add).localGet(1).i32Const(4).emit(Op.i32_mul).emit(Op.i32_add).localGet(2).i32Store();
    this._runtimeFuncs.arraySet = arrSetIdx;
    const { index: makeArrIdx, body: makeArrBody } = this.builder.addFunction(
      [ValType.i32],
      [ValType.i32]
    );
    makeArrBody.addLocal(ValType.i32);
    makeArrBody.addLocal(ValType.i32);
    makeArrBody.localGet(0).localSet(2).localGet(2).i32Const(4).emit(Op.i32_lt_s).if_(ValType.void).i32Const(4).localSet(2).end().localGet(2).i32Const(4).emit(Op.i32_mul).i32Const(ARRAY_HEADER2).emit(Op.i32_add).call(allocIdx).localTee(1).i32Const(TAG_ARRAY2).i32Store().localGet(1).i32Const(4).emit(Op.i32_add).localGet(0).i32Store().localGet(1).i32Const(8).emit(Op.i32_add).localGet(2).i32Store();
    makeArrBody.localGet(1);
    this._runtimeFuncs.makeArray = makeArrIdx;
    const { index: pushIdx, body: pushBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32],
      [ValType.i32]
    );
    pushBody.addLocal(ValType.i32);
    pushBody.addLocal(ValType.i32);
    pushBody.addLocal(ValType.i32);
    pushBody.addLocal(ValType.i32);
    pushBody.localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(2).localGet(0).i32Const(8).emit(Op.i32_add).i32Load().localSet(3).localGet(2).localGet(3).emit(Op.i32_lt_s).if_(ValType.void).localGet(0).localGet(2).localGet(1).call(arrSetIdx).localGet(0).i32Const(4).emit(Op.i32_add).localGet(2).i32Const(1).emit(Op.i32_add).i32Store().localGet(0).localSet(4).else_().localGet(3).i32Const(2).emit(Op.i32_mul).call(makeArrIdx).localSet(4).localGet(4).i32Const(4).emit(Op.i32_add).localGet(2).i32Const(1).emit(Op.i32_add).i32Store().i32Const(0).localSet(5).block().loop().localGet(5).localGet(2).emit(Op.i32_ge_s).brIf(1).localGet(4).localGet(5).localGet(0).localGet(5).call(arrGetIdx).call(arrSetIdx).localGet(5).i32Const(1).emit(Op.i32_add).localSet(5).br(0).end().end().localGet(4).localGet(2).localGet(1).call(arrSetIdx).end();
    pushBody.localGet(4);
    this._runtimeFuncs.push = pushIdx;
    const INITIAL_CAPACITY = 8;
    const ENTRY_SIZE = 12;
    const { index: hashFnvIdx, body: hashFnvBody } = this.builder.addFunction(
      [ValType.i32],
      [ValType.i32]
    );
    hashFnvBody.localGet(0).i32Const(2654435769).emit(Op.i32_mul).localGet(0).i32Const(16).emit(Op.i32_shr_u).emit(Op.i32_xor);
    this._runtimeFuncs.hashFnv = hashFnvIdx;
    const { index: hashFnvStrIdx, body: hashFnvStrBody } = this.builder.addFunction(
      [ValType.i32],
      [ValType.i32]
    );
    hashFnvStrBody.addLocal(ValType.i32);
    hashFnvStrBody.addLocal(ValType.i32);
    hashFnvStrBody.addLocal(ValType.i32);
    hashFnvStrBody.addLocal(ValType.i32);
    hashFnvStrBody.localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(1).localGet(0).i32Const(8).emit(Op.i32_add).localSet(2).i32Const(2166136261 | 0).localSet(4).i32Const(0).localSet(3).block().loop().localGet(3).localGet(1).emit(Op.i32_ge_u).brIf(1).localGet(4).localGet(2).localGet(3).emit(Op.i32_add).emit(Op.i32_load8_u, 0, 0).emit(Op.i32_xor).i32Const(16777619).emit(Op.i32_mul).localSet(4).localGet(3).i32Const(1).emit(Op.i32_add).localSet(3).br(0).end().end().localGet(4);
    this._runtimeFuncs.hashFnvStr = hashFnvStrIdx;
    const { index: hashNewNativeIdx, body: hashNewNativeBody } = this.builder.addFunction(
      [],
      [ValType.i32]
    );
    hashNewNativeBody.addLocal(ValType.i32);
    hashNewNativeBody.addLocal(ValType.i32);
    hashNewNativeBody.i32Const(16).call(allocIdx).localTee(0).i32Const(TAG_HASH).i32Store().localGet(0).i32Const(4).emit(Op.i32_add).i32Const(INITIAL_CAPACITY).i32Store().localGet(0).i32Const(8).emit(Op.i32_add).i32Const(0).i32Store().i32Const(INITIAL_CAPACITY * ENTRY_SIZE).call(allocIdx).localSet(1).localGet(0).i32Const(12).emit(Op.i32_add).localGet(1).i32Store();
    hashNewNativeBody.localGet(0);
    this._runtimeFuncs.hashNewNative = hashNewNativeIdx;
    const { index: hashFindSlotIdx, body: hashFindSlotBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashFindSlotBody.addLocal(ValType.i32);
    hashFindSlotBody.addLocal(ValType.i32);
    hashFindSlotBody.addLocal(ValType.i32);
    hashFindSlotBody.addLocal(ValType.i32);
    hashFindSlotBody.addLocal(ValType.i32);
    hashFindSlotBody.localGet(2).call(hashFnvIdx).localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and).localSet(3).i32Const(0).localSet(7).block().loop().localGet(7).brIf(1).localGet(0).localGet(3).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(4).localGet(4).i32Load().localSet(5).localGet(5).emit(Op.i32_eqz).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().localGet(5).i32Const(1).emit(Op.i32_eq).if_().localGet(4).i32Const(4).emit(Op.i32_add).i32Load().localGet(2).emit(Op.i32_eq).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().end().localGet(5).i32Const(2).emit(Op.i32_eq).if_().localGet(7).emit(Op.i32_eqz).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().end().localGet(3).i32Const(1).emit(Op.i32_add).localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and).localSet(3).br(0).end().end();
    hashFindSlotBody.localGet(6);
    this._runtimeFuncs.hashFindSlot = hashFindSlotIdx;
    const { index: hashFindSlotStrIdx, body: hashFindSlotStrBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashFindSlotStrBody.addLocal(ValType.i32);
    hashFindSlotStrBody.addLocal(ValType.i32);
    hashFindSlotStrBody.addLocal(ValType.i32);
    hashFindSlotStrBody.addLocal(ValType.i32);
    hashFindSlotStrBody.addLocal(ValType.i32);
    hashFindSlotStrBody.localGet(2).call(hashFnvStrIdx).localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and).localSet(3).i32Const(0).localSet(7).block().loop().localGet(7).brIf(1).localGet(0).localGet(3).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(4).localGet(4).i32Load().localSet(5).localGet(5).emit(Op.i32_eqz).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().localGet(5).i32Const(1).emit(Op.i32_eq).if_().localGet(4).i32Const(4).emit(Op.i32_add).i32Load().localGet(2).call(strEqIdx).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().end().localGet(5).i32Const(2).emit(Op.i32_eq).if_().localGet(7).emit(Op.i32_eqz).if_().localGet(3).localSet(6).i32Const(1).localSet(7).end().end().localGet(3).i32Const(1).emit(Op.i32_add).localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and).localSet(3).br(0).end().end();
    hashFindSlotStrBody.localGet(6);
    this._runtimeFuncs.hashFindSlotStr = hashFindSlotStrIdx;
    const { index: hashResizeIdx, body: hashResizeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32],
      []
    );
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.addLocal(ValType.i32);
    hashResizeBody.localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(2).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(3).localGet(1).i32Const(ENTRY_SIZE).emit(Op.i32_mul).call(allocIdx).localSet(4).localGet(0).i32Const(4).emit(Op.i32_add).localGet(1).i32Store().localGet(0).i32Const(8).emit(Op.i32_add).i32Const(0).i32Store().localGet(0).i32Const(12).emit(Op.i32_add).localGet(4).i32Store().i32Const(0).localSet(5).block().loop().localGet(5).localGet(3).emit(Op.i32_ge_u).brIf(1).localGet(2).localGet(5).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(6).localGet(6).i32Load().i32Const(1).emit(Op.i32_eq).if_().localGet(6).i32Const(4).emit(Op.i32_add).i32Load().localSet(7).localGet(6).i32Const(8).emit(Op.i32_add).i32Load().localSet(8).localGet(4).localGet(1).localGet(7).call(hashFindSlotIdx).localSet(9).localGet(4).localGet(9).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(10).localGet(10).i32Const(1).i32Store().localGet(10).i32Const(4).emit(Op.i32_add).localGet(7).i32Store().localGet(10).i32Const(8).emit(Op.i32_add).localGet(8).i32Store().localGet(0).i32Const(8).emit(Op.i32_add).localGet(0).i32Const(8).emit(Op.i32_add).i32Load().i32Const(1).emit(Op.i32_add).i32Store().end().localGet(5).i32Const(1).emit(Op.i32_add).localSet(5).br(0).end().end();
    this._runtimeFuncs.hashResize = hashResizeIdx;
    const { index: hashSetNativeIdx, body: hashSetNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.addLocal(ValType.i32);
    hashSetNativeBody.localGet(0).i32Const(8).emit(Op.i32_add).i32Load().localSet(8).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(4).localGet(8).i32Const(4).emit(Op.i32_mul).localGet(4).i32Const(3).emit(Op.i32_mul).emit(Op.i32_ge_u).if_().localGet(0).localGet(4).i32Const(1).emit(Op.i32_shl).call(hashResizeIdx).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(4).end().localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(3).localGet(3).localGet(4).localGet(1).call(hashFindSlotIdx).localSet(5).localGet(3).localGet(5).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(6).localGet(6).i32Load().localSet(7).localGet(6).i32Const(1).i32Store().localGet(6).i32Const(4).emit(Op.i32_add).localGet(1).i32Store().localGet(6).i32Const(8).emit(Op.i32_add).localGet(2).i32Store().localGet(7).i32Const(1).emit(Op.i32_ne).if_().localGet(0).i32Const(8).emit(Op.i32_add).localGet(0).i32Const(8).emit(Op.i32_add).i32Load().i32Const(1).emit(Op.i32_add).i32Store().end();
    hashSetNativeBody.localGet(0);
    this._runtimeFuncs.hashSetNative = hashSetNativeIdx;
    const { index: hashGetNativeIdx, body: hashGetNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashGetNativeBody.addLocal(ValType.i32);
    hashGetNativeBody.addLocal(ValType.i32);
    hashGetNativeBody.addLocal(ValType.i32);
    hashGetNativeBody.addLocal(ValType.i32);
    hashGetNativeBody.localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(2).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(3).localGet(2).localGet(3).localGet(1).call(hashFindSlotIdx).localSet(4).localGet(2).localGet(4).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(5).localGet(5).i32Load().i32Const(1).emit(Op.i32_eq).if_(ValType.i32).localGet(5).i32Const(8).emit(Op.i32_add).i32Load().else_().i32Const(0).end();
    this._runtimeFuncs.hashGetNative = hashGetNativeIdx;
    const { index: hashSetStrNativeIdx, body: hashSetStrNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.addLocal(ValType.i32);
    hashSetStrNativeBody.localGet(0).i32Const(8).emit(Op.i32_add).i32Load().localSet(8).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(4).localGet(8).i32Const(4).emit(Op.i32_mul).localGet(4).i32Const(3).emit(Op.i32_mul).emit(Op.i32_ge_u).if_().localGet(0).localGet(4).i32Const(1).emit(Op.i32_shl).call(hashResizeIdx).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(4).end().localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(3).localGet(3).localGet(4).localGet(1).call(hashFindSlotStrIdx).localSet(5).localGet(3).localGet(5).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(6).localGet(6).i32Load().localSet(7).localGet(6).i32Const(1).i32Store().localGet(6).i32Const(4).emit(Op.i32_add).localGet(1).i32Store().localGet(6).i32Const(8).emit(Op.i32_add).localGet(2).i32Store().localGet(7).i32Const(1).emit(Op.i32_ne).if_().localGet(0).i32Const(8).emit(Op.i32_add).localGet(0).i32Const(8).emit(Op.i32_add).i32Load().i32Const(1).emit(Op.i32_add).i32Store().end();
    hashSetStrNativeBody.localGet(0);
    this._runtimeFuncs.hashSetStrNative = hashSetStrNativeIdx;
    const { index: hashGetStrNativeIdx, body: hashGetStrNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32],
      [ValType.i32]
    );
    hashGetStrNativeBody.addLocal(ValType.i32);
    hashGetStrNativeBody.addLocal(ValType.i32);
    hashGetStrNativeBody.addLocal(ValType.i32);
    hashGetStrNativeBody.addLocal(ValType.i32);
    hashGetStrNativeBody.localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(2).localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(3).localGet(2).localGet(3).localGet(1).call(hashFindSlotStrIdx).localSet(4).localGet(2).localGet(4).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(5).localGet(5).i32Load().i32Const(1).emit(Op.i32_eq).if_(ValType.i32).localGet(5).i32Const(8).emit(Op.i32_add).i32Load().else_().i32Const(0).end();
    this._runtimeFuncs.hashGetStrNative = hashGetStrNativeIdx;
    this.globalScope.define("__alloc", allocIdx, "func");
    this.globalScope.define("__len", lenIdx, "func");
    this.globalScope.define("__array_get", arrGetIdx, "func");
    this.globalScope.define("__array_set", arrSetIdx, "func");
    this.globalScope.define("__make_array", makeArrIdx, "func");
    this.globalScope.define("__push", pushIdx, "func");
  }
  // Infer return types: if all return paths of a function return integers, mark it
  // Also detect functions that return integer-returning closures
  _inferReturnTypes() {
    const funcNames = new Set(this.functions.map((f) => f.name));
    for (const func of this.functions) {
      func.returnsInt = true;
    }
    for (let iteration = 0; iteration < 3; iteration++) {
      const returnIntFuncs = new Set(
        this.functions.filter((f) => f.returnsInt).map((f) => f.name)
      );
      for (const func of this.functions) {
        func.returnsInt = this._allReturnPathsInt(func.funcLit.body, func.funcLit.parameters, returnIntFuncs);
      }
    }
    for (const func of this.functions) {
      if (!func.returnsInt) {
        const returnedClosure = this._getReturnedClosure(func.funcLit.body);
        if (returnedClosure) {
          const outerParams = func.funcLit.parameters || [];
          const closureParams = returnedClosure.parameters || [];
          const allParams = [...closureParams, ...outerParams];
          const closureReturnsInt = this._allReturnPathsInt(
            returnedClosure.body,
            allParams,
            new Set(this.functions.filter((f) => f.returnsInt).map((f) => f.name))
          );
          func.returnsIntClosure = closureReturnsInt;
        }
      }
    }
  }
  // Check if all return paths in a block produce integer values
  _allReturnPathsInt(body, params, returnIntFuncs) {
    if (!body || !body.statements || body.statements.length === 0) return false;
    const paramNames = new Set((params || []).map((p) => p.value || p.token?.literal));
    const isIntExpr = (node) => {
      if (!node) return false;
      if (node instanceof IntegerLiteral) return true;
      if (node instanceof BooleanLiteral) return true;
      if (node instanceof Identifier) return paramNames.has(node.value);
      if (node instanceof InfixExpression) {
        if (["<", ">", "<=", ">=", "==", "!="].includes(node.operator)) return true;
        if (["-", "*", "/", "%"].includes(node.operator)) {
          return isIntExpr(node.left) && isIntExpr(node.right);
        }
        if (node.operator === "+") return isIntExpr(node.left) && isIntExpr(node.right);
        return false;
      }
      if (node instanceof PrefixExpression) return true;
      if (node instanceof IfExpression) {
        const consInt = node.consequence ? isIntBlock(node.consequence) : false;
        const altInt = node.alternative ? isIntBlock(node.alternative) : false;
        return consInt && altInt;
      }
      if (node instanceof CallExpression) {
        if (node.function instanceof Identifier && returnIntFuncs.has(node.function.value)) {
          return true;
        }
        return false;
      }
      if (node instanceof BlockStatement) return isIntBlock(node);
      return false;
    };
    const isIntBlock = (block) => {
      if (!block || !block.statements || block.statements.length === 0) return false;
      const last = block.statements[block.statements.length - 1];
      if (last instanceof ExpressionStatement) return isIntExpr(last.expression);
      if (last instanceof ReturnStatement) return isIntExpr(last.returnValue);
      return false;
    };
    return isIntBlock(body);
  }
  _declareFunction(name, funcLit) {
    const params = funcLit.parameters.map(() => ValType.i32);
    const results = [ValType.i32];
    const { index, body } = this.builder.addFunction(params, results);
    this.builder.addExport(name, ExportKind.Func, index);
    this.functions.push({
      name,
      index,
      body,
      funcLit,
      params,
      returnsInt: false
    });
    this.globalScope.define(name, index, "func");
  }
  _compileFunctions() {
    for (const func of this.functions) {
      const prevBody = this.currentBody;
      const prevScope = this.currentScope;
      const prevFunc = this.currentFunc;
      const prevLocalIdx = this.nextLocalIndex;
      const prevParamIdx = this.nextParamIndex;
      const prevBlockDepth = this.blockDepth;
      const parentScopeId = this._scopeIdStack[this._scopeIdStack.length - 1];
      const paramNames = func.funcLit.parameters.map((p) => p.value || p.token?.literal).join(",") || "anon";
      this._scopeIdStack.push(parentScopeId + "/" + paramNames);
      this.currentBody = func.body;
      this.blockDepth = 0;
      this.currentFunc = func;
      this.currentScope = new Scope(this.globalScope);
      this.nextParamIndex = 0;
      this.nextLocalIndex = func.params.length;
      const intParams = this._inferIntParams(func.funcLit);
      for (const param of func.funcLit.parameters) {
        const name = param.value || param.token?.literal;
        this.currentScope.define(name, this.nextParamIndex, ValType.i32, intParams.has(name));
        this.nextParamIndex++;
      }
      const body = func.funcLit.body;
      const tailCallInfo = this._detectTailRecursion(func.name, func.funcLit);
      if (tailCallInfo) {
        this.currentFunc._tailCallEnabled = true;
        this.currentFunc._tailCallDepth = this.blockDepth;
        this.currentBody.loop(ValType.i32);
        this.blockDepth++;
        this._compileBlockReturning(body);
        this.blockDepth--;
        this.currentBody.end();
      } else {
        this._compileBlockReturning(body);
      }
      this._scopeIdStack.pop();
      this.currentBody = prevBody;
      this.blockDepth = prevBlockDepth;
      this.currentScope = prevScope;
      this.currentFunc = prevFunc;
      this.nextLocalIndex = prevLocalIdx;
      this.nextParamIndex = prevParamIdx;
    }
  }
  _compileBlockReturning(block) {
    const stmts = block.statements;
    if (stmts.length === 0) {
      this.currentBody.i32Const(0);
      return;
    }
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      const isLast = i === stmts.length - 1;
      if (stmt instanceof ReturnStatement) {
        this.compileNode(stmt.returnValue);
        this.currentBody.return_();
        if (!isLast) continue;
        return;
      }
      if (stmt instanceof ExpressionStatement) {
        this.compileNode(stmt.expression);
        if (!isLast) {
          this.currentBody.drop();
        }
      } else {
        this.compileStatement(stmt);
        if (isLast) {
          this.currentBody.i32Const(0);
        }
      }
    }
  }
  compileStatement(stmt) {
    if (stmt instanceof LetStatement) {
      this.compileLetStatement(stmt);
    } else if (stmt instanceof EnumStatement) {
      if (!this._enumValues) this._enumValues = {};
      for (let i = 0; i < stmt.variants.length; i++) {
        this._enumValues[`${stmt.name}.${stmt.variants[i]}`] = i;
        this._enumValues[stmt.variants[i]] = i;
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.i32Const(i);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(stmt.variants[i], localIdx, "local");
      }
    } else if (stmt instanceof ClassStatement) {
      this.compileClassStatement(stmt);
    } else if (stmt instanceof ImportStatement) {
      this.warnings.push(`import "${stmt.moduleName}" is limited in WASM mode`);
      const bindName = stmt.alias || stmt.moduleName;
      if (stmt.bindings) {
        for (const name of stmt.bindings) {
          const localIdx = this.nextLocalIndex++;
          this.currentBody.addLocal(ValType.i32);
          this.currentBody.i32Const(0);
          this.currentBody.localSet(localIdx);
          this.currentScope.define(name, localIdx, "local");
        }
      } else {
        this.currentBody.call(this._runtimeFuncs.hashNew);
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(bindName, localIdx, "local");
      }
    } else if (stmt instanceof DestructuringLet) {
      this.compileNode(stmt.value);
      const arrLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(arrLocal);
      for (let i = 0; i < stmt.names.length; i++) {
        const name = stmt.names[i];
        if (!name || name.value === "_") continue;
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localGet(arrLocal);
        this.currentBody.i32Const(i);
        this.currentBody.call(this._runtimeFuncs.indexGet);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(name.value, localIdx, "local");
      }
    } else if (stmt instanceof HashDestructuringLet) {
      this.compileNode(stmt.value);
      const hashLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(hashLocal);
      for (const name of stmt.names) {
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localGet(hashLocal);
        this.compileStringLiteral({ value: name.value });
        this.currentBody.call(this._runtimeFuncs.indexGet);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(name.value, localIdx, "local");
      }
    } else if (stmt instanceof ReturnStatement) {
      this.compileNode(stmt.returnValue);
      this.currentBody.return_();
    } else if (stmt instanceof ExpressionStatement) {
      this.compileNode(stmt.expression);
      this.currentBody.drop();
    } else if (stmt instanceof BreakStatement) {
      if (this.loopStack.length > 0) {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.currentBody.br(this.blockDepth - loop.breakDepth);
      }
    } else if (stmt instanceof ContinueStatement) {
      if (this.loopStack.length > 0) {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.currentBody.br(this.blockDepth - loop.continueDepth);
      }
    }
  }
  compileLetStatement(stmt) {
    const name = stmt.name.value;
    const localIdx = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const isInt = stmt.value ? this._isDefinitelyInteger(stmt.value) : false;
    if (this._isBoxedVar(name)) {
      this.currentBody.i32Const(4);
      this.currentBody.call(this._runtimeFuncs.alloc);
      this.currentBody.localSet(localIdx);
      this.currentScope.define(name, localIdx, ValType.i32, isInt);
      this.currentScope.vars.get(name).boxed = true;
      if (stmt.value) {
        this.currentBody.localGet(localIdx);
        this.compileNode(stmt.value);
        this.currentBody.i32Store();
      }
    } else {
      this.currentScope.define(name, localIdx, ValType.i32, isInt);
      if (stmt.isConst) {
        if (!this._constVars) this._constVars = /* @__PURE__ */ new Set();
        this._constVars.add(name);
      }
      if (stmt.value instanceof CallExpression && stmt.value.function instanceof Identifier) {
        const binding = this.currentScope.resolve(name);
        if (binding) {
          binding._initCall = stmt.value.function.value;
          const calledFunc = this.functions.find((f) => f.name === stmt.value.function.value);
          if (calledFunc?.returnsIntClosure) {
            binding.callReturnsInt = true;
          }
        }
      }
      if (stmt.value) {
        this.compileNode(stmt.value);
        this.currentBody.localSet(localIdx);
      }
    }
  }
  compileNode(node) {
    if (node?.token?.line && this.currentBody) {
      this.currentBody.setSourceLine(node.token.line);
    }
    if (node instanceof IntegerLiteral) {
      this.currentBody.i32Const(node.value);
    } else if (node instanceof FloatLiteral) {
      const buf = new ArrayBuffer(8);
      const f64 = new Float64Array(buf);
      const i32 = new Int32Array(buf);
      f64[0] = node.value;
      this.currentBody.i32Const(i32[0]);
      this.currentBody.i32Const(i32[1]);
      this.currentBody.call(this._runtimeFuncs.floatNew);
    } else if (node instanceof BooleanLiteral) {
      this.currentBody.i32Const(node.value ? 1 : 0);
    } else if (node instanceof NullLiteral) {
      this.currentBody.i32Const(0);
    } else if (node instanceof Identifier) {
      this.compileIdentifier(node);
    } else if (node instanceof PrefixExpression) {
      this.compilePrefixExpression(node);
    } else if (node instanceof InfixExpression) {
      this.compileInfixExpression(node);
    } else if (node instanceof IfExpression) {
      this.compileIfExpression(node);
    } else if (node instanceof CallExpression) {
      this.compileCallExpression(node);
    } else if (node instanceof FunctionLiteral) {
      this.compileFunctionLiteral(node);
    } else if (node instanceof WhileExpression) {
      this.compileWhileExpression(node);
    } else if (node instanceof ForExpression) {
      this.compileForExpression(node);
    } else if (node instanceof ForInExpression) {
      this.compileForInExpression(node);
    } else if (node instanceof RangeExpression) {
      this.compileRangeExpression(node);
    } else if (node instanceof DoWhileExpression) {
      this.compileDoWhileExpression(node);
    } else if (node instanceof AssignExpression) {
      this.compileAssignExpression(node);
    } else if (node instanceof BlockStatement) {
      this._compileBlockReturning(node);
    } else if (node instanceof TernaryExpression) {
      this.compileNode(node.condition);
      this.currentBody.if_(ValType.i32);
      this.compileNode(node.consequence);
      this.currentBody.else_();
      this.compileNode(node.alternative);
      this.currentBody.end();
    } else if (node instanceof StringLiteral) {
      this.compileStringLiteral(node);
    } else if (node instanceof TemplateLiteral) {
      this.compileTemplateLiteral(node);
    } else if (node instanceof ArrayLiteral) {
      this.compileArrayLiteral(node);
    } else if (node instanceof IndexExpression) {
      if (node.left instanceof Identifier && node.index instanceof StringLiteral && this._enumValues) {
        const key = `${node.left.value}.${node.index.value}`;
        if (key in this._enumValues) {
          this.currentBody.i32Const(this._enumValues[key]);
          return;
        }
      }
      this.compileIndexExpression(node);
    } else if (node instanceof SliceExpression) {
      this.compileNode(node.left);
      this.compileNode(node.start || { value: 0, constructor: IntegerLiteral });
      if (node.end) {
        this.compileNode(node.end);
      } else {
        this.currentBody.i32Const(-1);
      }
      this.currentBody.call(this._runtimeFuncs.slice);
    } else if (node instanceof HashLiteral) {
      this.compileHashLiteral(node);
    } else if (node instanceof MatchExpression) {
      this.compileMatchExpression(node);
    } else if (node instanceof ArrayComprehension) {
      this.compileArrayComprehension(node);
    } else if (node instanceof TryExpression) {
      this.compileTryExpression(node);
    } else if (node instanceof ThrowExpression) {
      this.compileThrowExpression(node);
    } else if (node instanceof SelfExpression) {
      const binding = this.currentScope.resolve("self");
      if (binding && binding.index !== 0) {
        this.currentBody.localGet(binding.index);
      } else if (binding) {
        this.currentBody.localGet(binding.index);
      } else {
        this.currentBody.i32Const(0);
      }
    } else if (node instanceof ClassStatement) {
      this.compileClassStatement(node);
      this.currentBody.i32Const(0);
    } else if (node instanceof GeneratorLiteral) {
      this.warnings.push(`Generators are not supported in WASM mode (line ${node.token?.line || "?"})`);
      this.currentBody.i32Const(0);
    } else if (node instanceof YieldExpression) {
      this.warnings.push(`yield is not supported in WASM mode (line ${node.token?.line || "?"})`);
      if (node.value) {
        this.compileNode(node.value);
      } else {
        this.currentBody.i32Const(0);
      }
    } else if (node instanceof OptionalChainExpression) {
      this.compileNode(node.left);
      const tmpLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localTee(tmpLocal);
      this.currentBody.if_(ValType.i32);
      this.currentBody.localGet(tmpLocal);
      this.compileNode(node.index);
      this.currentBody.call(this._runtimeFuncs.indexGet);
      this.currentBody.else_();
      this.currentBody.i32Const(0);
      this.currentBody.end();
    } else if (node instanceof IndexAssignExpression) {
      this.compileNode(node.left);
      this.compileNode(node.index);
      this.compileNode(node.value);
      const tmpLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpLocal);
      const tmpIdx = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpIdx);
      const tmpArr = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpArr);
      this.currentBody.localGet(tmpArr);
      this.currentBody.localGet(tmpIdx);
      this.currentBody.localGet(tmpLocal);
      this.currentBody.call(this._runtimeFuncs.indexSet);
      this.currentBody.localGet(tmpLocal);
    } else {
      const nodeName = node?.constructor?.name || "unknown";
      if (node instanceof BreakStatement) {
        if (this.loopStack.length > 0) {
          const loop = this.loopStack[this.loopStack.length - 1];
          this.currentBody.br(this.blockDepth - loop.breakDepth);
        }
        this.currentBody.i32Const(0);
        return;
      }
      if (node instanceof ContinueStatement) {
        if (this.loopStack.length > 0) {
          const loop = this.loopStack[this.loopStack.length - 1];
          this.currentBody.br(this.blockDepth - loop.continueDepth);
        }
        this.currentBody.i32Const(0);
        return;
      }
      const token = node?.token;
      const loc = token?.line ? ` at line ${token.line}` : "";
      this.warnings.push(`Unsupported: ${nodeName}${loc} (compiled as 0)`);
      this.currentBody.i32Const(0);
    }
  }
  compileIdentifier(node) {
    const name = node.value;
    const binding = this.currentScope.resolve(name);
    if (binding) {
      if (binding.type === "func") {
        this._wrapFunctionAsClosure(name, binding.index);
      } else if (binding.boxed) {
        this.currentBody.localGet(binding.index);
        this.currentBody.i32Load();
      } else {
        this.currentBody.localGet(binding.index);
      }
    } else {
      const _l = node?.token?.line ? ` (line ${node.token.line})` : "";
      this.errors.push(`undefined variable: ${name}${_l}`);
      this.currentBody.i32Const(0);
    }
  }
  // Create a closure wrapper for a named WASM function so it can be used as a value
  _wrapFunctionAsClosure(name, funcIndex) {
    const funcEntry = this.functions.find((f) => f.name === name);
    if (!funcEntry) {
      this.currentBody.i32Const(0);
      return;
    }
    const origParams = funcEntry.funcLit.parameters;
    const wrapperParams = [ValType.i32, ...origParams.map(() => ValType.i32)];
    const { index: wrapperIdx, body: wrapperBody } = this.builder.addFunction(wrapperParams, [ValType.i32]);
    for (let i = 0; i < origParams.length; i++) {
      wrapperBody.localGet(i + 1);
    }
    wrapperBody.call(funcIndex);
    const tableSlot = this.nextTableSlot++;
    this.closureFuncs.push({
      funcLit: funcEntry.funcLit,
      captures: [],
      tableIndex: tableSlot,
      wasmFuncIndex: wrapperIdx
    });
    this.currentBody.i32Const(12);
    this.currentBody.call(this._runtimeFuncs.alloc);
    const closureLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closureLocal);
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(TAG_CLOSURE2);
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(tableSlot);
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(0);
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
  }
  compilePrefixExpression(node) {
    switch (node.operator) {
      case "-":
        if (this._isDefinitelyInteger(node.right)) {
          this.currentBody.i32Const(0);
          this.compileNode(node.right);
          this.currentBody.emit(Op.i32_sub);
        } else {
          this.compileNode(node.right);
          this.currentBody.call(this._runtimeFuncs.neg);
        }
        break;
      case "!":
        this.compileNode(node.right);
        this.currentBody.emit(Op.i32_eqz);
        break;
      default:
        this.compileNode(node.right);
        break;
    }
  }
  compileInfixExpression(node) {
    const folded = this._tryConstantFold(node);
    if (folded !== null) {
      this.currentBody.i32Const(folded);
      this.stats.constantsFolded++;
      return;
    }
    if (node.operator === "&&") {
      this.compileNode(node.left);
      this.currentBody.if_(ValType.i32);
      this.compileNode(node.right);
      this.currentBody.else_();
      this.currentBody.i32Const(0);
      this.currentBody.end();
      return;
    }
    if (node.operator === "||") {
      this.compileNode(node.left);
      this.currentBody.localTee(this._getTempLocal());
      this.currentBody.if_(ValType.i32);
      this.currentBody.localGet(this._getTempLocal());
      this.currentBody.else_();
      this.compileNode(node.right);
      this.currentBody.end();
      return;
    }
    if (node.operator === "??") {
      this.compileNode(node.left);
      const tmpLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localTee(tmpLocal);
      this.currentBody.if_(ValType.i32);
      this.currentBody.localGet(tmpLocal);
      this.currentBody.else_();
      this.compileNode(node.right);
      this.currentBody.end();
      return;
    }
    if (node.operator === "+" && this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strConcat);
      return;
    }
    if ((node.operator === "==" || node.operator === "!=") && this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strEq);
      if (node.operator === "!=") {
        this.currentBody.emit(Op.i32_eqz);
      }
      return;
    }
    if ((node.operator === "<" || node.operator === ">" || node.operator === "<=" || node.operator === ">=") && this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strCmp);
      switch (node.operator) {
        case "<":
          this.currentBody.i32Const(0);
          this.currentBody.emit(Op.i32_lt_s);
          break;
        case ">":
          this.currentBody.i32Const(0);
          this.currentBody.emit(Op.i32_gt_s);
          break;
        case "<=":
          this.currentBody.i32Const(1);
          this.currentBody.emit(Op.i32_lt_s);
          break;
        case ">=":
          this.currentBody.i32Const(-1);
          this.currentBody.emit(Op.i32_gt_s);
          break;
      }
      return;
    }
    this.compileNode(node.left);
    this.compileNode(node.right);
    switch (node.operator) {
      case "+":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_add);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.add);
          this.stats.hostArith++;
        }
        break;
      case "-":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_sub);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.sub);
          this.stats.hostArith++;
        }
        break;
      case "*":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_mul);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.mul);
          this.stats.hostArith++;
        }
        break;
      case "/":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_div_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.div);
          this.stats.hostArith++;
        }
        break;
      case "%":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_rem_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.mod);
          this.stats.hostArith++;
        }
        break;
      case "==":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_eq);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
          this.stats.hostArith++;
        }
        break;
      case "!=":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_ne);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
          this.currentBody.emit(Op.i32_eqz);
          this.stats.hostArith++;
        }
        break;
      case "<":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_lt_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.lt);
          this.stats.hostArith++;
        }
        break;
      case ">":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_gt_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.gt);
          this.stats.hostArith++;
        }
        break;
      case "<=":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_le_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.gt);
          this.stats.hostArith++;
          this.currentBody.emit(Op.i32_eqz);
        }
        break;
      case ">=":
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_ge_s);
        } else {
          this.currentBody.call(this._runtimeFuncs.lt);
          this.currentBody.emit(Op.i32_eqz);
        }
        break;
      case "&":
        this.currentBody.emit(Op.i32_and);
        break;
      case "|":
        this.currentBody.emit(Op.i32_or);
        break;
      case "^":
        this.currentBody.emit(Op.i32_xor);
        break;
      case "<<":
        this.currentBody.emit(Op.i32_shl);
        break;
      case ">>":
        this.currentBody.emit(Op.i32_shr_s);
        break;
      default:
        const _l2 = node?.token?.line ? ` (line ${node.token.line})` : "";
        this.errors.push(`unsupported operator: ${node.operator}${_l2}`);
        break;
    }
  }
  compileIfExpression(node) {
    this.compileNode(node.condition);
    if (node.alternative) {
      this.currentBody.if_(ValType.i32);
      this.blockDepth++;
      this._compileBlockReturning(node.consequence);
      this.currentBody.else_();
      this._compileBlockReturning(node.alternative);
      this.blockDepth--;
      this.currentBody.end();
    } else {
      this.currentBody.if_(ValType.i32);
      this.blockDepth++;
      this._compileBlockReturning(node.consequence);
      this.currentBody.else_();
      this.currentBody.i32Const(0);
      this.blockDepth--;
      this.currentBody.end();
    }
  }
  compileCallExpression(node) {
    if (node.function instanceof IndexExpression && node.function.left instanceof SuperExpression) {
      return this._compileSuperCall(node);
    }
    if (node.function instanceof Identifier) {
      const name = node.function.value;
      const isLocallyDefined = this.currentScope && this.currentScope.vars.has(name) || this.functions.some((f) => f.name === name);
      if (!isLocallyDefined && name === "len" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.len);
        return;
      }
      if (name === "push" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.push);
        return;
      }
      if (name === "puts" && node.arguments.length >= 1) {
        for (const arg of node.arguments) {
          this.compileNode(arg);
          this.currentBody.call(this._runtimeFuncs.puts);
        }
        this.currentBody.i32Const(0);
        return;
      }
      if (name === "str" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.str);
        return;
      }
      if (name === "first" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.i32Const(0);
        this.currentBody.call(this._runtimeFuncs.arrayGet);
        return;
      }
      if (name === "last" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        const arrTmp = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localTee(arrTmp);
        this.currentBody.call(this._runtimeFuncs.len);
        this.currentBody.i32Const(1);
        this.currentBody.emit(Op.i32_sub);
        const idxTmp = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(idxTmp);
        this.currentBody.localGet(arrTmp);
        this.currentBody.localGet(idxTmp);
        this.currentBody.call(this._runtimeFuncs.arrayGet);
        return;
      }
      if (name === "rest" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.rest);
        return;
      }
      if (!isLocallyDefined && ["map", "filter", "find", "any", "every"].includes(name) && node.arguments.length === 2) {
        if (name === "map" && node.arguments[1] instanceof FunctionLiteral) {
          const callback = node.arguments[1];
          const captures = this._findCaptures(callback);
          if (captures.length === 0 && callback.parameters.length === 1) {
            this._compileInlineMap(node.arguments[0], callback);
            return;
          }
        }
        if (name === "filter" && node.arguments[1] instanceof FunctionLiteral) {
          const callback = node.arguments[1];
          const captures = this._findCaptures(callback);
          if (captures.length === 0 && callback.parameters.length === 1) {
            this._compileInlineFilter(node.arguments[0], callback);
            return;
          }
        }
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs[name]);
        return;
      }
      if (!isLocallyDefined && name === "reduce" && (node.arguments.length === 2 || node.arguments.length === 3)) {
        if (node.arguments[1] instanceof FunctionLiteral) {
          const callback = node.arguments[1];
          const captures = this._findCaptures(callback);
          if (captures.length === 0 && callback.parameters.length === 2) {
            const initExpr = node.arguments.length === 3 ? node.arguments[2] : null;
            this._compileInlineReduce(node.arguments[0], callback, initExpr);
            return;
          }
        }
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        if (node.arguments.length === 3) {
          this.compileNode(node.arguments[2]);
        } else {
          this.currentBody.i32Const(-2147483648);
        }
        this.currentBody.call(this._runtimeFuncs.reduce);
        return;
      }
      if (!isLocallyDefined && name === "sort" && (node.arguments.length === 1 || node.arguments.length === 2)) {
        this.compileNode(node.arguments[0]);
        if (node.arguments.length === 2) {
          this.compileNode(node.arguments[1]);
        } else {
          this.currentBody.i32Const(0);
        }
        this.currentBody.call(this._runtimeFuncs.sort);
        return;
      }
      if (!isLocallyDefined && name === "forEach" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.forEach);
        return;
      }
      if (!isLocallyDefined && name === "flatMap" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.flatMap);
        return;
      }
      if (!isLocallyDefined && name === "zip" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.zip);
        return;
      }
      if (!isLocallyDefined && name === "enumerate" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.enumerate);
        return;
      }
      if (name === "split" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strSplit);
        return;
      }
      if (name === "trim" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strTrim);
        return;
      }
      if (name === "replace" && node.arguments.length === 3) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.compileNode(node.arguments[2]);
        this.currentBody.call(this._runtimeFuncs.strReplace);
        return;
      }
      if (name === "indexOf" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strIndexOf);
        return;
      }
      if (name === "startsWith" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strStartsWith);
        return;
      }
      if (name === "endsWith" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strEndsWith);
        return;
      }
      if (name === "toUpper" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strUpper);
        return;
      }
      if (name === "toLower" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strLower);
        return;
      }
      if (name === "substring" && (node.arguments.length === 2 || node.arguments.length === 3)) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        if (node.arguments.length === 3) {
          this.compileNode(node.arguments[2]);
        } else {
          this.currentBody.i32Const(-1);
        }
        this.currentBody.call(this._runtimeFuncs.strSubstring);
        return;
      }
      if (name === "max" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.max);
        return;
      }
      if (name === "min" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.min);
        return;
      }
      if (name === "range" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.range);
        return;
      }
      if (name === "join" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.join);
        return;
      }
      if (name === "keys" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.keys);
        return;
      }
      if (name === "values" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.values);
        return;
      }
      if (name === "delete" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.hashDelete);
        return;
      }
      if (name === "has" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.hashHas);
        return;
      }
      if (name === "merge" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.hashMerge);
        return;
      }
      if (name === "contains" && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.contains);
        return;
      }
      if (name === "reverse" && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.reverse);
        return;
      }
    }
    if (node.function instanceof Identifier) {
      const name = node.function.value;
      const binding = this.currentScope.resolve(name);
      if (binding && binding.type === "func") {
        if (this.currentFunc?._tailCallEnabled && name === this.currentFunc.name) {
          const paramCount = node.arguments.length;
          for (const arg of node.arguments) {
            this.compileNode(arg);
          }
          for (let i = paramCount - 1; i >= 0; i--) {
            this.currentBody.localSet(i);
          }
          const loopDepth = this.blockDepth - this.currentFunc._tailCallDepth - 1;
          this.currentBody.br(loopDepth);
          this.currentBody.i32Const(0);
          return;
        }
        for (const arg of node.arguments) {
          this.compileNode(arg);
        }
        this.currentBody.call(binding.index);
      } else if (binding) {
        if (binding.boxed) {
          this._emitClosureCall(node, () => {
            this.currentBody.localGet(binding.index);
            this.currentBody.i32Load();
          });
        } else {
          this._emitClosureCall(node, () => this.currentBody.localGet(binding.index));
        }
      } else {
        const _l3 = node?.token?.line ? ` (line ${node.token.line})` : "";
        this.errors.push(`unknown function: ${name}${_l3}`);
        this.currentBody.i32Const(0);
      }
    } else {
      this._emitClosureCall(node, () => this.compileNode(node.function));
    }
  }
  // Emit a closure call via call_indirect
  _emitClosureCall(node, emitClosure) {
    emitClosure();
    const closurePtrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closurePtrLocal);
    this.currentBody.localGet(closurePtrLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load();
    for (const arg of node.arguments) {
      this.compileNode(arg);
    }
    this.currentBody.localGet(closurePtrLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load();
    const numParams = node.arguments.length + 1;
    const paramTypes = Array(numParams).fill(ValType.i32);
    const typeIdx = this.builder.addType(paramTypes, [ValType.i32]);
    this.currentBody.callIndirect(typeIdx);
  }
  compileWhileExpression(node) {
    this.currentBody.block();
    this.blockDepth++;
    const breakDepth = this.blockDepth;
    this.currentBody.loop();
    this.blockDepth++;
    const continueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth, continueDepth });
    this.compileNode(node.condition);
    this.currentBody.emit(Op.i32_eqz);
    this.currentBody.brIf(this.blockDepth - breakDepth);
    this._compileBlockStatements(node.body);
    this.currentBody.br(this.blockDepth - continueDepth);
    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.i32Const(0);
  }
  compileForExpression(node) {
    if (node.init) {
      if (node.init instanceof LetStatement) {
        this.compileLetStatement(node.init);
      } else {
        this.compileNode(node.init);
        this.currentBody.drop();
      }
    }
    this.currentBody.block();
    this.blockDepth++;
    const breakDepth = this.blockDepth;
    this.currentBody.loop();
    this.blockDepth++;
    const loopStartDepth = this.blockDepth;
    if (node.condition) {
      this.compileNode(node.condition);
      this.currentBody.emit(Op.i32_eqz);
      this.currentBody.brIf(this.blockDepth - breakDepth);
    }
    this.currentBody.block();
    this.blockDepth++;
    const continueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth, continueDepth });
    this._compileBlockStatements(node.body);
    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end();
    if (node.update) {
      this.compileNode(node.update);
      this.currentBody.drop();
    }
    this.currentBody.br(this.blockDepth - loopStartDepth);
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.i32Const(0);
  }
  compileForInExpression(node) {
    this.compileNode(node.iterable);
    this.currentBody.call(this._runtimeFuncs.iterPrepare);
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(arrLocal);
    this.currentBody.localGet(arrLocal);
    this.currentBody.call(this._runtimeFuncs.len);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(lenLocal);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);
    const varLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const isNumericRange = node.iterable instanceof RangeExpression;
    this.currentScope.define(node.variable, varLocal, ValType.i32, isNumericRange);
    this.currentBody.block();
    this.blockDepth++;
    const breakDepth = this.blockDepth;
    this.currentBody.loop();
    this.blockDepth++;
    const loopStartDepth = this.blockDepth;
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(this.blockDepth - breakDepth);
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.indexGet);
    this.currentBody.localSet(varLocal);
    this.currentBody.block();
    this.blockDepth++;
    const continueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth, continueDepth });
    this._compileBlockStatements(node.body);
    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(this.blockDepth - loopStartDepth);
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.i32Const(0);
  }
  compileRangeExpression(node) {
    this.compileNode(node.start);
    const startLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(startLocal);
    this.compileNode(node.end);
    const endLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(endLocal);
    this.currentBody.localGet(endLocal);
    this.currentBody.localGet(startLocal);
    this.currentBody.emit(Op.i32_sub);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localTee(lenLocal);
    this.currentBody.call(this._runtimeFuncs.makeArray);
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(arrLocal);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);
    this.currentBody.block();
    this.blockDepth++;
    this.currentBody.loop();
    this.blockDepth++;
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1);
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(startLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.call(this._runtimeFuncs.arraySet);
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(0);
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.localGet(arrLocal);
  }
  compileDoWhileExpression(node) {
    this.currentBody.block();
    this.blockDepth++;
    const breakDepth = this.blockDepth;
    this.currentBody.loop();
    this.blockDepth++;
    const continueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth, continueDepth });
    this._compileBlockStatements(node.body);
    this.compileNode(node.condition);
    this.currentBody.brIf(this.blockDepth - continueDepth);
    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.i32Const(0);
  }
  compileAssignExpression(node) {
    const name = node.name.value || node.name;
    if (this._constVars?.has(name)) {
      const line = node?.token?.line ? ` (line ${node.token.line})` : "";
      this.errors.push(`cannot assign to const variable: ${name}${line}`);
      this.currentBody.i32Const(0);
      return;
    }
    const binding = this.currentScope.resolve(name);
    if (binding) {
      if (binding.boxed) {
        this.currentBody.localGet(binding.index);
        this.compileNode(node.value);
        const tmpLocal = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localTee(tmpLocal);
        this.currentBody.i32Store();
        this.currentBody.localGet(tmpLocal);
      } else {
        this.compileNode(node.value);
        this.currentBody.localTee(binding.index);
      }
    } else {
      const _l4 = node?.token?.line ? ` (line ${node.token.line})` : "";
      this.errors.push(`undefined variable for assignment: ${name}${_l4}`);
      this.currentBody.i32Const(0);
    }
  }
  _compileBlockStatements(block) {
    for (const stmt of block.statements) {
      if (stmt instanceof ExpressionStatement) {
        this.compileNode(stmt.expression);
        this.currentBody.drop();
      } else if (stmt instanceof ReturnStatement) {
        this.compileNode(stmt.returnValue);
        this.currentBody.return_();
      } else {
        this.compileStatement(stmt);
      }
    }
  }
  // String literal → data segment constant
  compileStringLiteral(node) {
    const str = node.value;
    if (this._stringInternPool && this._stringInternPool.has(str)) {
      const offset2 = this._stringInternPool.get(str);
      this.currentBody.i32Const(offset2);
      return;
    }
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const offset = this.nextDataOffset;
    this.nextDataOffset += 8 + bytes.length;
    this.nextDataOffset = this.nextDataOffset + 3 & ~3;
    this.stringConstants.push({ offset, length: bytes.length, value: str });
    if (!this._stringInternPool) this._stringInternPool = /* @__PURE__ */ new Map();
    this._stringInternPool.set(str, offset);
    this.currentBody.i32Const(offset);
  }
  // Template literal → concatenation of parts
  compileTemplateLiteral(node) {
    if (node.parts.length === 0) {
      this.compileStringLiteral({ value: "" });
      return;
    }
    const firstPart = node.parts[0];
    if (firstPart instanceof StringLiteral) {
      this.compileStringLiteral(firstPart);
    } else {
      this.compileNode(firstPart);
      this.currentBody.call(this._runtimeFuncs.str);
    }
    for (let i = 1; i < node.parts.length; i++) {
      const part = node.parts[i];
      if (part instanceof StringLiteral) {
        this.compileStringLiteral(part);
      } else {
        this.compileNode(part);
        this.currentBody.call(this._runtimeFuncs.str);
      }
      this.currentBody.call(this._runtimeFuncs.strConcat);
    }
  }
  // Function literal → closure object on heap
  compileFunctionLiteral(node) {
    const captures = this._findCaptures(node);
    const captureKnownInt = captures.map((name) => {
      const binding = this.currentScope.resolve(name);
      return binding ? !!binding.knownInt : false;
    });
    const captureBoxed = captures.map((name) => {
      const binding = this.currentScope.resolve(name);
      return binding ? !!binding.boxed : false;
    });
    const params = [ValType.i32, ...node.parameters.map(() => ValType.i32)];
    const results = [ValType.i32];
    const { index: wasmFuncIdx, body: funcBody } = this.builder.addFunction(params, results);
    const tableSlot = this.nextTableSlot++;
    const prevBody = this.currentBody;
    const prevScope = this.currentScope;
    const prevFunc = this.currentFunc;
    const prevLocalIdx = this.nextLocalIndex;
    const prevParamIdx = this.nextParamIndex;
    const prevTempLocal = this._tempLocal;
    const prevBlockDepth = this.blockDepth;
    const parentScopeId = this._scopeIdStack[this._scopeIdStack.length - 1];
    const paramNames = node.parameters.map((p) => p.value || p.token?.literal).join(",") || "anon";
    this._scopeIdStack.push(parentScopeId + "/" + paramNames);
    this.currentBody = funcBody;
    this.blockDepth = 0;
    this.currentFunc = { name: `closure_${tableSlot}`, index: wasmFuncIdx };
    this.currentScope = new Scope(this.globalScope);
    this.nextParamIndex = 0;
    this.nextLocalIndex = params.length;
    this._tempLocal = null;
    const envPtrLocal = 0;
    const intParams = this._inferIntParams(node);
    for (let i = 0; i < node.parameters.length; i++) {
      const name = node.parameters[i].value || node.parameters[i].token?.literal;
      const isInt = intParams.has(name);
      this.currentScope.define(name, i + 1, ValType.i32, isInt);
    }
    for (let i = 0; i < captures.length; i++) {
      const localIdx = this.nextLocalIndex++;
      funcBody.addLocal(ValType.i32);
      funcBody.localGet(envPtrLocal).i32Const(4 + i * 4).emit(Op.i32_add).i32Load().localSet(localIdx);
      this.currentScope.define(captures[i], localIdx, ValType.i32, captureKnownInt[i]);
      if (captureBoxed[i]) {
        this.currentScope.vars.get(captures[i]).boxed = true;
      }
    }
    this._compileBlockReturning(node.body);
    this._scopeIdStack.pop();
    this.currentBody = prevBody;
    this.blockDepth = prevBlockDepth;
    this.currentScope = prevScope;
    this.currentFunc = prevFunc;
    this.nextLocalIndex = prevLocalIdx;
    this.nextParamIndex = prevParamIdx;
    this._tempLocal = prevTempLocal;
    this.closureFuncs.push({
      funcLit: node,
      captures,
      tableIndex: tableSlot,
      wasmFuncIndex: wasmFuncIdx
    });
    let envLocal;
    if (captures.length > 0) {
      const envSize = 4 + captures.length * 4;
      this.currentBody.i32Const(envSize);
      this.currentBody.call(this._runtimeFuncs.alloc);
      envLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(envLocal);
      this.currentBody.localGet(envLocal);
      this.currentBody.i32Const(captures.length);
      this.currentBody.i32Store();
      for (let i = 0; i < captures.length; i++) {
        const binding = this.currentScope.resolve(captures[i]);
        this.currentBody.localGet(envLocal);
        this.currentBody.i32Const(4 + i * 4);
        this.currentBody.emit(Op.i32_add);
        if (binding) {
          this.currentBody.localGet(binding.index);
        } else {
          this.currentBody.i32Const(0);
        }
        this.currentBody.i32Store();
      }
    }
    this.currentBody.i32Const(12);
    this.currentBody.call(this._runtimeFuncs.alloc);
    const closureLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closureLocal);
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(TAG_CLOSURE2);
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(tableSlot);
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    if (captures.length > 0) {
      this.currentBody.localGet(envLocal);
    } else {
      this.currentBody.i32Const(0);
    }
    this.currentBody.i32Store();
    this.currentBody.localGet(closureLocal);
  }
  // Check if a function literal has free variables (references to non-param, non-global names)
  _hasFreeVariables(funcLit, params, topLevelFuncNames = /* @__PURE__ */ new Set(), selfName = null) {
    let hasFree = false;
    const locals = new Set(params);
    if (selfName) locals.add(selfName);
    const walk = (node) => {
      if (!node || hasFree) return;
      if (node instanceof FunctionLiteral) return;
      if (node instanceof LetStatement && node.name) {
        locals.add(node.name.value);
      }
      if (node instanceof Identifier) {
        const name = node.value;
        if (!locals.has(name) && !topLevelFuncNames.has(name)) {
          const binding = this.globalScope.resolve(name);
          if (!binding) hasFree = true;
        }
      }
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
      if (node.condition) walk(node.condition);
      if (node.consequence) walk(node.consequence);
      if (node.alternative) walk(node.alternative);
      if (node.expression) walk(node.expression);
      if (node.value && !(node instanceof LetStatement)) walk(node.value);
      if (node instanceof LetStatement && node.value) walk(node.value);
      if (node.returnValue) walk(node.returnValue);
      if (node.index) walk(node.index);
      if (node.function) walk(node.function);
      if (node.body && node.body.statements) {
        for (const stmt of node.body.statements) walk(stmt);
      }
      if (node.statements) {
        for (const stmt of node.statements) walk(stmt);
      }
      if (node.arguments) {
        for (const arg of node.arguments) walk(arg);
      }
      if (node.elements) {
        for (const elem of node.elements) walk(elem);
      }
    };
    if (funcLit.body && funcLit.body.statements) {
      for (const stmt of funcLit.body.statements) walk(stmt);
    }
    return hasFree;
  }
  // Check if a variable needs boxing in the current scope
  _isBoxedVar(name) {
    const scopeId = this._scopeIdStack[this._scopeIdStack.length - 1];
    const boxed = this._boxedVars.get(scopeId);
    return boxed ? boxed.has(name) : false;
  }
  // Analyze AST to determine which variables need heap boxing.
  // Returns a Map<scopeKey, Set<varName>> where scopeKey identifies a scope.
  // A variable needs boxing if:
  //   (a) it is captured by a closure AND assigned anywhere (closure or enclosing scope)
  //   (b) it is captured by 2+ closures (they need to share the same cell)
  //   (c) it is self-referencing (let f = fn(){...f...} where f is in the closure's captures)
  _analyzeBoxedVariables(program) {
    const result = /* @__PURE__ */ new Map();
    const analyzeScope = (statements, scopeId, outerDefs) => {
      const defs = new Set(outerDefs || []);
      const assigns = /* @__PURE__ */ new Set();
      const capturedBy = /* @__PURE__ */ new Map();
      const selfRefs = /* @__PURE__ */ new Set();
      for (const stmt of statements) {
        if (stmt instanceof LetStatement && stmt.name) {
          defs.add(stmt.name.value);
        } else if (stmt instanceof ExpressionStatement && stmt.expression instanceof LetStatement) {
          defs.add(stmt.expression.name.value);
        }
      }
      const walkExpr = (node, currentScopeDefs) => {
        if (!node) return;
        if (node instanceof AssignExpression) {
          const name = node.name?.value || node.name;
          if (name && typeof name === "string") {
            assigns.add(name);
          }
          walkExpr(node.value, currentScopeDefs);
          return;
        }
        if (node instanceof FunctionLiteral) {
          const params = new Set(node.parameters.map((p) => p.value || p.token?.literal));
          const innerDefs = new Set(params);
          const captures = /* @__PURE__ */ new Set();
          const collectInnerDefs = (n) => {
            if (!n) return;
            if (n instanceof LetStatement && n.name) {
              innerDefs.add(n.name.value);
            }
            if (n.body && n.body.statements) {
              for (const s of n.body.statements) collectInnerDefs(s);
            }
            if (n.statements) {
              for (const s of n.statements) collectInnerDefs(s);
            }
            if (n.consequence && n.consequence.statements) {
              for (const s of n.consequence.statements) collectInnerDefs(s);
            }
            if (n.alternative && n.alternative.statements) {
              for (const s of n.alternative.statements) collectInnerDefs(s);
            }
          };
          if (node.body && node.body.statements) {
            for (const s of node.body.statements) collectInnerDefs(s);
          }
          const findCaptures = (n) => {
            if (!n) return;
            if (n instanceof FunctionLiteral) {
              const nestedParams = new Set(n.parameters.map((p) => p.value || p.token?.literal));
              const findNestedCaptures = (nn) => {
                if (!nn) return;
                if (nn instanceof Identifier) {
                  const name = nn.value;
                  if (!nestedParams.has(name) && !innerDefs.has(name) && defs.has(name)) {
                    captures.add(name);
                  }
                }
                if (nn instanceof FunctionLiteral) {
                  if (nn.body && nn.body.statements) {
                    for (const s of nn.body.statements) findNestedCaptures(s);
                  }
                  return;
                }
                if (nn.left) findNestedCaptures(nn.left);
                if (nn.right) findNestedCaptures(nn.right);
                if (nn.condition) findNestedCaptures(nn.condition);
                if (nn.consequence) findNestedCaptures(nn.consequence);
                if (nn.alternative) findNestedCaptures(nn.alternative);
                if (nn.expression) findNestedCaptures(nn.expression);
                if (nn.value) findNestedCaptures(nn.value);
                if (nn.returnValue) findNestedCaptures(nn.returnValue);
                if (nn.index) findNestedCaptures(nn.index);
                if (nn.function) findNestedCaptures(nn.function);
                if (nn.body && nn.body.statements) for (const s of nn.body.statements) findNestedCaptures(s);
                if (nn.statements) for (const s of nn.statements) findNestedCaptures(s);
                if (nn.arguments) for (const a of nn.arguments) findNestedCaptures(a);
                if (nn.elements) for (const e of nn.elements) findNestedCaptures(e);
                if (nn.pairs) for (const [k, v] of nn.pairs) {
                  findNestedCaptures(k);
                  findNestedCaptures(v);
                }
              };
              if (n.body && n.body.statements) {
                for (const s of n.body.statements) findNestedCaptures(s);
              }
              return;
            }
            if (n instanceof Identifier) {
              const name = n.value;
              if (!params.has(name) && !innerDefs.has(name) && defs.has(name)) {
                captures.add(name);
              }
            }
            if (n.left) findCaptures(n.left);
            if (n.right) findCaptures(n.right);
            if (n.condition) findCaptures(n.condition);
            if (n.consequence) findCaptures(n.consequence);
            if (n.alternative) findCaptures(n.alternative);
            if (n.expression) findCaptures(n.expression);
            if (n.value) findCaptures(n.value);
            if (n.returnValue) findCaptures(n.returnValue);
            if (n.index) findCaptures(n.index);
            if (n.function) findCaptures(n.function);
            if (n.body && n.body.statements) for (const s of n.body.statements) findCaptures(s);
            if (n.statements) for (const s of n.statements) findCaptures(s);
            if (n.arguments) for (const a of n.arguments) findCaptures(a);
            if (n.elements) for (const e of n.elements) findCaptures(e);
            if (n.pairs) for (const [k, v] of n.pairs) {
              findCaptures(k);
              findCaptures(v);
            }
          };
          if (node.body && node.body.statements) {
            for (const s of node.body.statements) findCaptures(s);
          }
          const findInnerAssigns = (n) => {
            if (!n) return;
            if (n instanceof AssignExpression) {
              const name = n.name?.value || n.name;
              if (name && typeof name === "string" && defs.has(name)) {
                assigns.add(name);
              }
            }
            if (n instanceof FunctionLiteral) return;
            if (n.left) findInnerAssigns(n.left);
            if (n.right) findInnerAssigns(n.right);
            if (n.condition) findInnerAssigns(n.condition);
            if (n.consequence) findInnerAssigns(n.consequence);
            if (n.alternative) findInnerAssigns(n.alternative);
            if (n.expression) findInnerAssigns(n.expression);
            if (n.value) findInnerAssigns(n.value);
            if (n.returnValue) findInnerAssigns(n.returnValue);
            if (n.body && n.body.statements) for (const s of n.body.statements) findInnerAssigns(s);
            if (n.statements) for (const s of n.statements) findInnerAssigns(s);
            if (n.arguments) for (const a of n.arguments) findInnerAssigns(a);
            if (n.elements) for (const e of n.elements) findInnerAssigns(e);
            if (n.pairs) for (const [k, v] of n.pairs) findInnerAssigns(v);
          };
          if (node.body && node.body.statements) {
            for (const s of node.body.statements) findInnerAssigns(s);
          }
          for (const name of captures) {
            capturedBy.set(name, (capturedBy.get(name) || 0) + 1);
          }
          if (node.body && node.body.statements) {
            analyzeScope(node.body.statements, scopeId + "/" + (node.parameters.map((p) => p.value || p.token?.literal).join(",") || "anon"), defs);
          }
          return;
        }
        if (node.left) walkExpr(node.left, currentScopeDefs);
        if (node.right) walkExpr(node.right, currentScopeDefs);
        if (node.condition) walkExpr(node.condition, currentScopeDefs);
        if (node.consequence && node.consequence.statements) {
          for (const s of node.consequence.statements) walkStmt(s, currentScopeDefs);
        }
        if (node.alternative && node.alternative.statements) {
          for (const s of node.alternative.statements) walkStmt(s, currentScopeDefs);
        }
        if (node.expression) walkExpr(node.expression, currentScopeDefs);
        if (node.value && !(node instanceof LetStatement)) walkExpr(node.value, currentScopeDefs);
        if (node.returnValue) walkExpr(node.returnValue, currentScopeDefs);
        if (node.index) walkExpr(node.index, currentScopeDefs);
        if (node.function) walkExpr(node.function, currentScopeDefs);
        if (node.body && node.body.statements) {
          for (const s of node.body.statements) walkStmt(s, currentScopeDefs);
        }
        if (node.statements) {
          for (const s of node.statements) walkStmt(s, currentScopeDefs);
        }
        if (node.arguments) for (const a of node.arguments) walkExpr(a, currentScopeDefs);
        if (node.elements) for (const e of node.elements) walkExpr(e, currentScopeDefs);
        if (node.pairs) {
          for (const [key, value] of node.pairs) {
            walkExpr(key, currentScopeDefs);
            walkExpr(value, currentScopeDefs);
          }
        }
      };
      const walkStmt = (stmt, currentScopeDefs) => {
        if (stmt instanceof LetStatement) {
          if (stmt.value instanceof FunctionLiteral) {
            const name = stmt.name.value;
            const params = new Set(stmt.value.parameters.map((p) => p.value || p.token?.literal));
            const refsSelf = this._astReferencesName(stmt.value.body, name, params);
            if (refsSelf) {
              selfRefs.add(name);
            }
          }
          if (stmt.value) walkExpr(stmt.value, currentScopeDefs);
        } else if (stmt instanceof ExpressionStatement) {
          if (stmt.expression) walkExpr(stmt.expression, currentScopeDefs);
        } else if (stmt instanceof ReturnStatement) {
          if (stmt.returnValue) walkExpr(stmt.returnValue, currentScopeDefs);
        } else {
          walkExpr(stmt, currentScopeDefs);
        }
      };
      for (const stmt of statements) {
        walkStmt(stmt, defs);
      }
      const boxed = /* @__PURE__ */ new Set();
      const localDefs = /* @__PURE__ */ new Set();
      for (const stmt of statements) {
        if (stmt instanceof LetStatement && stmt.name) {
          localDefs.add(stmt.name.value);
        }
      }
      const needsBoxing = /* @__PURE__ */ new Set();
      for (const [name, count] of capturedBy) {
        if (assigns.has(name)) {
          needsBoxing.add(name);
        }
        if (count >= 2) {
          needsBoxing.add(name);
        }
      }
      for (const name of selfRefs) {
        if (capturedBy.has(name)) {
          const otherCaptures = [...capturedBy.keys()].filter((k) => k !== name);
          if (otherCaptures.length > 0) {
            needsBoxing.add(name);
          }
        }
      }
      for (const name of needsBoxing) {
        if (localDefs.has(name)) {
          boxed.add(name);
        } else {
          const parts = scopeId.split("/");
          for (let i = parts.length - 1; i >= 1; i--) {
            const parentId = parts.slice(0, i).join("/");
            if (!result.has(parentId)) result.set(parentId, /* @__PURE__ */ new Set());
            result.get(parentId).add(name);
            break;
          }
        }
      }
      if (boxed.size > 0) {
        if (!result.has(scopeId)) result.set(scopeId, /* @__PURE__ */ new Set());
        for (const name of boxed) result.get(scopeId).add(name);
      }
    };
    analyzeScope(program.statements, "top", /* @__PURE__ */ new Set());
    return result;
  }
  // Helper: check if an AST node references a name (excluding params)
  _astReferencesName(node, name, excludeParams) {
    if (!node) return false;
    if (node instanceof Identifier) {
      return node.value === name && !excludeParams?.has(name);
    }
    if (node instanceof FunctionLiteral) {
      const innerParams = new Set(node.parameters.map((p) => p.value || p.token?.literal));
      if (innerParams.has(name)) return false;
      return this._astReferencesName(node.body, name, innerParams);
    }
    const children = [
      node.left,
      node.right,
      node.condition,
      node.consequence,
      node.alternative,
      node.expression,
      node.value,
      node.returnValue,
      node.index,
      node.function
    ];
    for (const child of children) {
      if (this._astReferencesName(child, name, excludeParams)) return true;
    }
    if (node.body && node.body.statements) {
      for (const s of node.body.statements) {
        if (this._astReferencesName(s, name, excludeParams)) return true;
      }
    }
    if (node.statements) {
      for (const s of node.statements) {
        if (this._astReferencesName(s, name, excludeParams)) return true;
      }
    }
    if (node.arguments) {
      for (const a of node.arguments) {
        if (this._astReferencesName(a, name, excludeParams)) return true;
      }
    }
    if (node.elements) {
      for (const e of node.elements) {
        if (this._astReferencesName(e, name, excludeParams)) return true;
      }
    }
    if (node.pairs) {
      for (const [k, v] of node.pairs) {
        if (this._astReferencesName(k, name, excludeParams)) return true;
        if (this._astReferencesName(v, name, excludeParams)) return true;
      }
    }
    return false;
  }
  // Find free variables in a function literal
  _findCaptures(funcLit) {
    const params = new Set(funcLit.parameters.map((p) => p.value || p.token?.literal));
    const captures = /* @__PURE__ */ new Set();
    const walk = (node) => {
      if (!node) return;
      if (node instanceof Identifier) {
        const name = node.value;
        if (!params.has(name) && this.currentScope.resolve(name) && this.currentScope.resolve(name).type !== "func") {
          captures.add(name);
        }
      }
      if (node instanceof SelfExpression) {
        if (!params.has("self") && this.currentScope.resolve("self") && this.currentScope.resolve("self").type !== "func") {
          captures.add("self");
        }
      }
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
      if (node.condition) walk(node.condition);
      if (node.consequence) walk(node.consequence);
      if (node.alternative) walk(node.alternative);
      if (node.expression) walk(node.expression);
      if (node.value) walk(node.value);
      if (node.returnValue) walk(node.returnValue);
      if (node.index) walk(node.index);
      if (node.function) walk(node.function);
      if (node.body && node.body.statements) {
        for (const stmt of node.body.statements) walk(stmt);
      }
      if (node.statements) {
        for (const stmt of node.statements) walk(stmt);
      }
      if (node.arguments) {
        for (const arg of node.arguments) walk(arg);
      }
      if (node.elements) {
        for (const elem of node.elements) walk(elem);
      }
      if (node.parameters) {
      }
    };
    if (funcLit.body && funcLit.body.statements) {
      for (const stmt of funcLit.body.statements) walk(stmt);
    }
    return [...captures];
  }
  // Array literal → heap-allocated array
  compileArrayLiteral(node) {
    const hasSpread = node.elements.some((e) => e instanceof SpreadElement);
    if (!hasSpread) {
      const len = node.elements.length;
      this.currentBody.i32Const(len);
      this.currentBody.call(this._runtimeFuncs.makeArray);
      const arrLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(arrLocal);
      for (let i = 0; i < len; i++) {
        this.currentBody.localGet(arrLocal);
        this.currentBody.i32Const(i);
        this.compileNode(node.elements[i]);
        this.currentBody.call(this._runtimeFuncs.arraySet);
      }
      this.currentBody.localGet(arrLocal);
    } else {
      this.currentBody.i32Const(0);
      this.currentBody.call(this._runtimeFuncs.makeArray);
      let batchStart = -1;
      const arrLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(arrLocal);
      for (let i = 0; i < node.elements.length; i++) {
        const elem = node.elements[i];
        if (elem instanceof SpreadElement) {
          this.currentBody.localGet(arrLocal);
          this.compileNode(elem.expression);
          this.currentBody.call(this._runtimeFuncs.arrayConcat);
          this.currentBody.localSet(arrLocal);
        } else {
          this.currentBody.localGet(arrLocal);
          this.compileNode(elem);
          this.currentBody.call(this._runtimeFuncs.push);
          this.currentBody.localSet(arrLocal);
        }
      }
      this.currentBody.localGet(arrLocal);
    }
  }
  // Index expression: arr[idx]
  compileIndexExpression(node) {
    this.compileNode(node.left);
    this.compileNode(node.index);
    this.currentBody.call(this._runtimeFuncs.indexGet);
  }
  // Match expression: match (subject) { pattern => value, ... }
  compileMatchExpression(node) {
    this.compileNode(node.subject);
    const subjectLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(subjectLocal);
    const arms = node.arms || [];
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const isLast = i === arms.length - 1;
      const isWildcard = arm.pattern === null || arm.pattern?.constructor?.name === "Identifier" && arm.pattern.value === "_";
      if (isWildcard) {
        if (arm.pattern && arm.pattern.constructor?.name === "Identifier" && arm.pattern.value !== "_") {
          const binding = this.currentScope.define(arm.pattern.value, subjectLocal, "local");
        }
        this.compileNode(arm.value);
        break;
      }
      this.currentBody.localGet(subjectLocal);
      this.compileNode(arm.pattern);
      this.currentBody.emit(Op.i32_eq);
      if (isLast) {
        this.currentBody.if_(ValType.i32);
        this.blockDepth++;
        this.compileNode(arm.value);
        this.currentBody.else_();
        this.currentBody.i32Const(0);
        this.blockDepth--;
        this.currentBody.end();
      } else {
        this.currentBody.if_(ValType.i32);
        this.blockDepth++;
        this.compileNode(arm.value);
        this.currentBody.else_();
      }
    }
    let closingEnds = 0;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const isWildcard = arm.pattern === null || arm.pattern?.constructor?.name === "Identifier" && arm.pattern.value === "_";
      if (isWildcard) break;
      if (i < arms.length - 1) closingEnds++;
    }
    for (let i = 0; i < closingEnds; i++) {
      this.blockDepth--;
      this.currentBody.end();
    }
  }
  // Array comprehension: [body for variable in iterable if condition]
  // Desugars to: make empty array, loop over iterable, optionally filter, push body result
  compileArrayComprehension(node) {
    this.currentBody.i32Const(0);
    this.currentBody.call(this._runtimeFuncs.makeArray);
    const resultLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(resultLocal);
    this.compileNode(node.iterable);
    const iterLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(iterLocal);
    this.currentBody.localGet(iterLocal);
    this.currentBody.call(this._runtimeFuncs.len);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(lenLocal);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);
    const elemLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const varName = node.variable?.value || node.variable;
    this.currentScope.define(varName, elemLocal, "local");
    this.currentBody.block();
    this.blockDepth++;
    this.currentBody.loop();
    this.blockDepth++;
    const loopBreakDepth = this.blockDepth;
    const loopContinueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth: loopBreakDepth - 1, continueDepth: loopContinueDepth });
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1);
    this.currentBody.localGet(iterLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.indexGet);
    this.currentBody.localSet(elemLocal);
    if (node.condition) {
      this.compileNode(node.condition);
      this.currentBody.if_();
      this.blockDepth++;
      this.compileNode(node.body);
      const bodyVal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(bodyVal);
      this.currentBody.localGet(resultLocal);
      this.currentBody.localGet(bodyVal);
      this.currentBody.call(this._runtimeFuncs.push);
      this.currentBody.localSet(resultLocal);
      this.blockDepth--;
      this.currentBody.end();
    } else {
      this.compileNode(node.body);
      const bodyVal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(bodyVal);
      this.currentBody.localGet(resultLocal);
      this.currentBody.localGet(bodyVal);
      this.currentBody.call(this._runtimeFuncs.push);
      this.currentBody.localSet(resultLocal);
    }
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(0);
    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end();
    this.blockDepth--;
    this.currentBody.end();
    this.currentBody.localGet(resultLocal);
  }
  // Try/catch expression — using WASM exception handling proposal
  compileTryExpression(node) {
    this.currentBody.try_(ValType.i32);
    if (node.tryBlock) {
      this._compileBlockReturning(node.tryBlock);
    } else {
      this.currentBody.i32Const(0);
    }
    this.currentBody.catch_(this._exceptionTagIdx);
    if (node.catchBlock) {
      if (node.catchParam) {
        const paramName = node.catchParam.value || node.catchParam;
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(paramName, localIdx, "local");
      } else {
        this.currentBody.drop();
      }
      this._compileBlockReturning(node.catchBlock);
    }
    this.currentBody.end();
  }
  // Throw expression — throws a WASM exception with the value
  compileThrowExpression(node) {
    if (node.value) {
      this.compileNode(node.value);
    } else {
      this.currentBody.i32Const(0);
    }
    this.currentBody.throw_(this._exceptionTagIdx);
    this.currentBody.i32Const(0);
  }
  // Class compilation: compiles class as a constructor function
  // that creates an instance hash with fields and method closures
  compileClassStatement(stmt, bindingName) {
    const className = bindingName || stmt.name;
    const methodEntries = [];
    const prevClassName = this._currentClassName;
    this._currentClassName = className;
    this._currentSuperClass = stmt.superClass || null;
    for (const method of stmt.methods) {
      const params = [ValType.i32, ...method.params.map(() => ValType.i32)];
      const results = [ValType.i32];
      const { index: wasmFuncIdx, body: funcBody } = this.builder.addFunction(params, results);
      const tableSlot = this.nextTableSlot++;
      const prevBody2 = this.currentBody;
      const prevScope2 = this.currentScope;
      const prevFunc2 = this.currentFunc;
      const prevLocalIdx2 = this.nextLocalIndex;
      const prevParamIdx = this.nextParamIndex;
      const prevTempLocal2 = this._tempLocal;
      const prevBlockDepth2 = this.blockDepth;
      this.currentBody = funcBody;
      this.blockDepth = 0;
      this.currentFunc = { name: `${className}_${method.name}`, index: wasmFuncIdx };
      this.currentScope = new Scope(this.globalScope);
      this.nextParamIndex = 0;
      this.nextLocalIndex = params.length;
      this._tempLocal = null;
      this.currentScope.define("self", 0, ValType.i32);
      for (let i = 0; i < method.params.length; i++) {
        const pname = method.params[i].value || method.params[i];
        this.currentScope.define(pname, i + 1, ValType.i32);
      }
      this._compileBlockReturning(method.body);
      this.currentBody = prevBody2;
      this.blockDepth = prevBlockDepth2;
      this.currentScope = prevScope2;
      this.currentFunc = prevFunc2;
      this.nextLocalIndex = prevLocalIdx2;
      this.nextParamIndex = prevParamIdx;
      this._tempLocal = prevTempLocal2;
      this.closureFuncs.push({
        funcLit: method,
        captures: [],
        tableIndex: tableSlot,
        wasmFuncIndex: wasmFuncIdx
      });
      methodEntries.push({
        name: method.name,
        wasmFuncIdx,
        tableSlot,
        paramCount: method.params.length
      });
    }
    this._currentClassName = prevClassName;
    this._currentSuperClass = null;
    let allFields = [...stmt.fields];
    let allMethodEntries = [...methodEntries];
    let parentMethods = [];
    if (stmt.superClass) {
      const parentInfo = this._classRegistry.get(stmt.superClass);
      if (parentInfo) {
        for (const field of parentInfo.fields) {
          if (!allFields.includes(field)) {
            allFields.unshift(field);
          }
        }
        const childMethodNames = new Set(methodEntries.map((m) => m.name));
        for (const pm of parentInfo.methods) {
          if (!childMethodNames.has(pm.name)) {
            allMethodEntries.push(pm);
            parentMethods.push(pm);
          }
        }
      }
    }
    let initMethod = allMethodEntries.find((m) => m.name === "init");
    if (!initMethod && stmt.superClass) {
      const parentInfo = this._classRegistry.get(stmt.superClass);
      if (parentInfo && parentInfo.initMethod) {
        initMethod = parentInfo.initMethod;
        allMethodEntries.push(initMethod);
      }
    }
    const initParamCount = initMethod ? initMethod.paramCount : 0;
    const ctorParams = Array(initParamCount).fill(ValType.i32);
    const { index: ctorFuncIdx, body: ctorBody } = this.builder.addFunction(ctorParams, [ValType.i32]);
    const prevBody = this.currentBody;
    const prevScope = this.currentScope;
    const prevFunc = this.currentFunc;
    const prevLocalIdx = this.nextLocalIndex;
    const prevBlockDepth = this.blockDepth;
    const prevTempLocal = this._tempLocal;
    this.currentBody = ctorBody;
    this.blockDepth = 0;
    this.currentFunc = { name: `${className}_ctor`, index: ctorFuncIdx };
    this.currentScope = new Scope(this.globalScope);
    this.nextLocalIndex = ctorParams.length;
    this._tempLocal = null;
    this.currentBody.call(this._runtimeFuncs.hashNew);
    const instanceLocal = this.nextLocalIndex++;
    ctorBody.addLocal(ValType.i32);
    this.currentBody.localSet(instanceLocal);
    for (const field of allFields) {
      this.currentBody.localGet(instanceLocal);
      this.compileStringLiteral({ value: field });
      this.currentBody.i32Const(0);
      this.currentBody.call(this._runtimeFuncs.hashSet);
      this.currentBody.drop();
    }
    for (const method of allMethodEntries) {
      if (method.name === "init") continue;
      this.currentBody.i32Const(12);
      this.currentBody.call(this._runtimeFuncs.alloc);
      const closureLocal = this.nextLocalIndex++;
      ctorBody.addLocal(ValType.i32);
      this.currentBody.localSet(closureLocal);
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(TAG_CLOSURE2);
      this.currentBody.i32Store();
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(4);
      this.currentBody.emit(Op.i32_add);
      this.currentBody.i32Const(method.tableSlot);
      this.currentBody.i32Store();
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(8);
      this.currentBody.emit(Op.i32_add);
      this.currentBody.localGet(instanceLocal);
      this.currentBody.i32Store();
      this.currentBody.localGet(instanceLocal);
      this.compileStringLiteral({ value: method.name });
      this.currentBody.localGet(closureLocal);
      this.currentBody.call(this._runtimeFuncs.hashSet);
      this.currentBody.drop();
    }
    if (initMethod) {
      this.currentBody.localGet(instanceLocal);
      for (let i = 0; i < initParamCount; i++) {
        this.currentBody.localGet(i);
      }
      const initParamTypes = [ValType.i32, ...Array(initParamCount).fill(ValType.i32)];
      const typeIdx = this.builder.addType(initParamTypes, [ValType.i32]);
      this.currentBody.i32Const(initMethod.tableSlot);
      this.currentBody.callIndirect(typeIdx);
      this.currentBody.drop();
    }
    this.currentBody.localGet(instanceLocal);
    this.currentBody = prevBody;
    this.blockDepth = prevBlockDepth;
    this.currentScope = prevScope;
    this.currentFunc = prevFunc;
    this.nextLocalIndex = prevLocalIdx;
    this._tempLocal = prevTempLocal;
    this.currentScope.define(className, ctorFuncIdx, "func");
    this._classRegistry.set(className, {
      fields: allFields,
      methods: allMethodEntries.filter((m) => m.name !== "init"),
      initMethod,
      ctorFuncIdx
    });
  }
  // Compile super.method(args) — calls parent class method with self
  _compileSuperCall(node) {
    const methodName = node.function.index?.value || node.function.index;
    const parentName = this._currentSuperClass;
    if (!parentName) {
      this.errors.push(`super used outside of a class with parent`);
      this.currentBody.i32Const(0);
      return;
    }
    const parentInfo = this._classRegistry.get(parentName);
    if (!parentInfo) {
      this.errors.push(`Parent class '${parentName}' not found in registry`);
      this.currentBody.i32Const(0);
      return;
    }
    const parentMethod = parentInfo.methods.find((m) => m.name === methodName);
    if (!parentMethod && parentInfo.initMethod?.name === methodName) {
      const initMethod = parentInfo.initMethod;
      const selfBinding2 = this.currentScope.resolve("self");
      if (selfBinding2) {
        this.currentBody.localGet(selfBinding2.index);
      } else {
        this.currentBody.i32Const(0);
      }
      for (const arg of node.arguments || []) {
        this.compileNode(arg);
      }
      const paramTypes2 = [ValType.i32, ...(node.arguments || []).map(() => ValType.i32)];
      const typeIdx2 = this.builder.addType(paramTypes2, [ValType.i32]);
      this.currentBody.i32Const(initMethod.tableSlot);
      this.currentBody.callIndirect(typeIdx2);
      return;
    }
    if (!parentMethod) {
      this.errors.push(`Method '${methodName}' not found in parent class '${parentName}'`);
      this.currentBody.i32Const(0);
      return;
    }
    const selfBinding = this.currentScope.resolve("self");
    if (selfBinding) {
      this.currentBody.localGet(selfBinding.index);
    } else {
      this.currentBody.i32Const(0);
    }
    for (const arg of node.arguments || []) {
      this.compileNode(arg);
    }
    const paramTypes = [ValType.i32, ...(node.arguments || []).map(() => ValType.i32)];
    const typeIdx = this.builder.addType(paramTypes, [ValType.i32]);
    this.currentBody.i32Const(parentMethod.tableSlot);
    this.currentBody.callIndirect(typeIdx);
  }
  // Hash literal: {"key": value, ...}
  compileHashLiteral(node) {
    let allIntKeys = true;
    if (node.pairs) {
      for (const [key] of node.pairs) {
        if (key instanceof StringLiteral) {
          allIntKeys = false;
          break;
        }
      }
    }
    if (allIntKeys && node.pairs && node.pairs.size > 0) {
      this.currentBody.call(this._runtimeFuncs.hashNewNative);
      const hashLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(hashLocal);
      for (const [key, value] of node.pairs) {
        this.currentBody.localGet(hashLocal);
        this.compileNode(key);
        this.compileNode(value);
        this.currentBody.call(this._runtimeFuncs.hashSetNative);
        this.currentBody.drop();
      }
      this.currentBody.localGet(hashLocal);
    } else if (node.pairs && node.pairs.size > 0) {
      this.currentBody.call(this._runtimeFuncs.hashNewNative);
      const hashLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(hashLocal);
      for (const [key, value] of node.pairs) {
        this.currentBody.localGet(hashLocal);
        this.compileNode(key);
        this.compileNode(value);
        if (key instanceof StringLiteral) {
          this.currentBody.call(this._runtimeFuncs.hashSetStrNative);
        } else {
          this.currentBody.call(this._runtimeFuncs.hashSetNative);
        }
        this.currentBody.drop();
      }
      this.currentBody.localGet(hashLocal);
    } else {
      this.currentBody.call(this._runtimeFuncs.hashNewNative);
    }
  }
  // Temp local for || operator
  _tempLocal = null;
  _getTempLocal() {
    if (this._tempLocal === null) {
      this._tempLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
    }
    return this._tempLocal;
  }
  // Simple type inference: check if an expression produces a string
  _isStringExpression(...nodes) {
    return nodes.some((n) => this._nodeIsString(n));
  }
  _nodeIsString(node) {
    if (node instanceof StringLiteral) return true;
    if (node instanceof CallExpression && node.function instanceof Identifier && node.function.value === "str") return true;
    if (node instanceof InfixExpression && node.operator === "+" && this._isStringExpression(node.left, node.right)) return true;
    return false;
  }
  // Scan a function body to infer which parameters are used as integers
  _inferIntegerParams(funcNode) {
    const intParams = /* @__PURE__ */ new Set();
    const paramNames = new Set(funcNode.parameters.map((p) => p.value || p.token?.literal));
    const scan = (node) => {
      if (!node) return;
      if (node instanceof InfixExpression) {
        const ops = ["+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==", "!=", "&", "|", "^"];
        if (ops.includes(node.operator)) {
          if (node.left instanceof Identifier && paramNames.has(node.left.value)) {
            intParams.add(node.left.value);
          }
          if (node.right instanceof Identifier && paramNames.has(node.right.value)) {
            intParams.add(node.right.value);
          }
        }
        scan(node.left);
        scan(node.right);
      }
      if (node instanceof PrefixExpression) {
        if (node.right instanceof Identifier && paramNames.has(node.right.value)) {
          intParams.add(node.right.value);
        }
        scan(node.right);
      }
      if (node instanceof IfExpression) {
        scan(node.condition);
        if (node.consequence) node.consequence.statements?.forEach(scan);
        if (node.alternative) node.alternative.statements?.forEach(scan);
      }
      if (node instanceof BlockStatement) node.statements?.forEach(scan);
      if (node instanceof ExpressionStatement) scan(node.expression);
      if (node instanceof ReturnStatement) scan(node.returnValue);
      if (node instanceof LetStatement) scan(node.value);
      if (node instanceof CallExpression) {
        node.arguments?.forEach(scan);
        scan(node.function);
      }
    };
    if (funcNode.body?.statements) {
      funcNode.body.statements.forEach(scan);
    }
    return intParams;
  }
  // Get the FunctionLiteral returned by a function body (if it directly returns a closure)
  _getReturnedClosure(body) {
    if (!body || !body.statements || body.statements.length === 0) return null;
    const last = body.statements[body.statements.length - 1];
    const expr = last instanceof ExpressionStatement ? last.expression : last instanceof ReturnStatement ? last.returnValue : null;
    if (expr instanceof FunctionLiteral) return expr;
    if (expr instanceof IfExpression) {
      const thenClosure = this._getReturnedClosure(expr.consequence);
      if (thenClosure) return thenClosure;
    }
    return null;
  }
  // Infer which parameters of a function are definitely integers.
  // A parameter is definitely integer if it's only used in integer contexts:
  // - Arithmetic operations (+, -, *, /, %)
  // - Integer comparisons (<, >, <=, >=, ==, !=) with other int expressions
  // - Passed to functions where the corresponding parameter is also int
  // - Used as a direct call argument
  _inferIntParams(funcLit) {
    const paramNames = new Set(
      (funcLit.parameters || []).map((p) => p.value || p.token?.literal)
    );
    const nonIntParams = /* @__PURE__ */ new Set();
    const checkNode = (node) => {
      if (!node) return;
      if (node instanceof CallExpression) {
        if (node.function instanceof Identifier) {
          const name = node.function.value;
          const nonIntBuiltins = [
            "len",
            "push",
            "first",
            "last",
            "rest",
            "puts",
            "str",
            "map",
            "filter",
            "reduce",
            "sort",
            "reverse",
            "join",
            "split",
            "contains",
            "keys",
            "values",
            "type",
            "range",
            "zip",
            "flat",
            "any",
            "all",
            "find",
            "count",
            "sum",
            "max",
            "min",
            "slice",
            "insert",
            "remove",
            "concat",
            "unique",
            "groupBy",
            "sortBy",
            "chunks"
          ];
          if (nonIntBuiltins.includes(name) && !paramNames.has(name)) {
            for (const arg of node.arguments || []) {
              if (arg instanceof Identifier && paramNames.has(arg.value)) {
                nonIntParams.add(arg.value);
              }
            }
          }
        }
        for (const arg of node.arguments || []) checkNode(arg);
        checkNode(node.function);
        return;
      }
      if (node instanceof InfixExpression) {
        const hasFloat = (n) => n instanceof FloatLiteral;
        if (hasFloat(node.left) || hasFloat(node.right)) {
          if (node.left instanceof Identifier && paramNames.has(node.left.value)) {
            nonIntParams.add(node.left.value);
          }
          if (node.right instanceof Identifier && paramNames.has(node.right.value)) {
            nonIntParams.add(node.right.value);
          }
          const checkForParam = (n) => {
            if (n instanceof Identifier && paramNames.has(n.value)) {
              nonIntParams.add(n.value);
            }
            if (n instanceof InfixExpression) {
              checkForParam(n.left);
              checkForParam(n.right);
            }
          };
          checkForParam(node.left);
          checkForParam(node.right);
        }
        checkNode(node.left);
        checkNode(node.right);
        return;
      }
      if (node instanceof IndexExpression) {
        if (node.left instanceof Identifier && paramNames.has(node.left.value)) {
          nonIntParams.add(node.left.value);
        }
        checkNode(node.left);
        checkNode(node.index);
        return;
      }
      if (node instanceof IfExpression) {
        checkNode(node.condition);
        if (node.consequence) checkBlock(node.consequence);
        if (node.alternative) checkBlock(node.alternative);
        return;
      }
      if (node instanceof InfixExpression) {
        checkNode(node.left);
        checkNode(node.right);
        return;
      }
      if (node instanceof PrefixExpression) {
        checkNode(node.right);
        return;
      }
      if (node instanceof LetStatement) {
        checkNode(node.value);
        return;
      }
      if (node instanceof ExpressionStatement) {
        checkNode(node.expression);
        return;
      }
      if (node instanceof ReturnStatement) {
        checkNode(node.returnValue);
        return;
      }
      if (node instanceof WhileExpression || node instanceof DoWhileExpression) {
        checkNode(node.condition);
        if (node.body) checkBlock(node.body);
        return;
      }
      if (node instanceof ForExpression) {
        checkNode(node.init);
        checkNode(node.condition);
        checkNode(node.update);
        if (node.body) checkBlock(node.body);
        return;
      }
      if (node instanceof BlockStatement) {
        checkBlock(node);
        return;
      }
    };
    const checkBlock = (block) => {
      for (const stmt of block.statements || []) checkNode(stmt);
    };
    if (funcLit.body) checkBlock(funcLit.body);
    const intParams = /* @__PURE__ */ new Set();
    for (const name of paramNames) {
      if (!nonIntParams.has(name)) intParams.add(name);
    }
    return intParams;
  }
  // Detect if a function has ONLY tail-recursive calls (all recursive calls in tail position)
  _detectTailRecursion(funcName, funcLit) {
    if (!funcName || !funcLit.body) return null;
    let hasTailCalls = false;
    let hasNonTailCalls = false;
    const checkForNonTailCalls = (node) => {
      if (!node) return;
      if (node instanceof CallExpression) {
        if (node.function instanceof Identifier && node.function.value === funcName) {
          hasNonTailCalls = true;
        }
        for (const arg of node.arguments || []) {
          checkForNonTailCalls(arg);
        }
        return;
      }
      if (node instanceof InfixExpression) {
        checkForNonTailCalls(node.left);
        checkForNonTailCalls(node.right);
        return;
      }
      if (node instanceof PrefixExpression) {
        checkForNonTailCalls(node.right);
        return;
      }
      if (node instanceof IndexExpression) {
        checkForNonTailCalls(node.left);
        checkForNonTailCalls(node.index);
        return;
      }
      if (node instanceof AssignExpression) {
        checkForNonTailCalls(node.value);
        return;
      }
    };
    const checkTail = (node) => {
      if (!node) return;
      if (node instanceof CallExpression) {
        if (node.function instanceof Identifier && node.function.value === funcName) {
          hasTailCalls = true;
          for (const arg of node.arguments || []) {
            checkForNonTailCalls(arg);
          }
          return;
        }
        checkForNonTailCalls(node);
        return;
      }
      if (node instanceof IfExpression) {
        checkForNonTailCalls(node.condition);
        if (node.consequence) checkTail(this._lastExpr(node.consequence));
        if (node.alternative) checkTail(this._lastExpr(node.alternative));
        if (node.consequence) {
          for (let i = 0; i < node.consequence.statements.length - 1; i++) {
            checkForNonTailCalls(node.consequence.statements[i]);
          }
        }
        if (node.alternative) {
          for (let i = 0; i < node.alternative.statements.length - 1; i++) {
            checkForNonTailCalls(node.alternative.statements[i]);
          }
        }
        return;
      }
      checkForNonTailCalls(node);
    };
    checkTail(this._lastExpr(funcLit.body));
    if (funcLit.body && funcLit.body.statements) {
      for (let i = 0; i < funcLit.body.statements.length - 1; i++) {
        checkForNonTailCalls(funcLit.body.statements[i]);
      }
    }
    return hasTailCalls && !hasNonTailCalls ? { funcName } : null;
  }
  // Get the last expression from a block (the return value)
  _lastExpr(block) {
    if (!block || !block.statements || block.statements.length === 0) return null;
    const last = block.statements[block.statements.length - 1];
    if (last instanceof ExpressionStatement) return last.expression;
    if (last instanceof ReturnStatement) return last.returnValue;
    return last;
  }
  _isDefinitelyInteger(node) {
    if (node instanceof IntegerLiteral) return true;
    if (node instanceof BooleanLiteral) return true;
    if (node instanceof Identifier) {
      const binding = this.currentScope?.resolve(node.value);
      if (binding && binding.knownInt) return true;
      return false;
    }
    if (node instanceof CallExpression) {
      if (node.function instanceof Identifier) {
        const func = this.functions?.find((f) => f.name === node.function.value);
        if (func && func.returnsInt) return true;
        const binding = this.currentScope?.resolve(node.function.value);
        if (binding && binding.callReturnsInt) return true;
        if (binding && binding._initCall) {
          const initFunc = this.functions?.find((f) => f.name === binding._initCall);
          if (initFunc?.returnsIntClosure) return true;
        }
      }
      return false;
    }
    if (node instanceof InfixExpression) {
      const op = node.operator;
      if (["==", "!=", "<", ">", "<=", ">="].includes(op)) return true;
      if (["-", "*", "/", "%"].includes(op)) {
        return this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right);
      }
      if (op === "+") return this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right);
    }
    if (node instanceof PrefixExpression) return true;
    return false;
  }
  _mightBeString(node) {
    if (node instanceof StringLiteral) return true;
    if (node instanceof TemplateLiteral) return true;
    if (node instanceof CallExpression) {
      if (node.function instanceof Identifier && node.function.value === "str") return true;
    }
    if (node instanceof IndexExpression) return true;
    if (node instanceof InfixExpression && node.operator === "+" && (this._mightBeString(node.left) || this._mightBeString(node.right))) return true;
    if (node instanceof CallExpression && !(node.function instanceof Identifier && ["len", "first", "last", "type", "int"].includes(node.function.value))) {
      return false;
    }
    return false;
  }
  // Constant folding: try to evaluate an expression at compile time
  _tryConstantFold(node) {
    if (!(node instanceof InfixExpression)) return null;
    const left = this._getConstValue(node.left);
    const right = this._getConstValue(node.right);
    if (left === null || right === null) return null;
    switch (node.operator) {
      case "+":
        return left + right | 0;
      case "-":
        return left - right | 0;
      case "*":
        return Math.imul(left, right);
      case "/":
        return right !== 0 ? left / right | 0 : null;
      case "%":
        return right !== 0 ? left % right | 0 : null;
      case "==":
        return left === right ? 1 : 0;
      case "!=":
        return left !== right ? 1 : 0;
      case "<":
        return left < right ? 1 : 0;
      case ">":
        return left > right ? 1 : 0;
      case "<=":
        return left <= right ? 1 : 0;
      case ">=":
        return left >= right ? 1 : 0;
      case "&":
        return left & right;
      case "|":
        return left | right;
      case "^":
        return left ^ right;
      case "<<":
        return left << right;
      case ">>":
        return left >> right;
      default:
        return null;
    }
  }
  _getConstValue(node) {
    if (node instanceof IntegerLiteral) return node.value;
    if (node instanceof BooleanLiteral) return node.value ? 1 : 0;
    if (node instanceof InfixExpression) return this._tryConstantFold(node);
    if (node instanceof PrefixExpression && node.operator === "-") {
      const val = this._getConstValue(node.right);
      return val !== null ? -val : null;
    }
    if (node instanceof PrefixExpression && node.operator === "!") {
      const val = this._getConstValue(node.right);
      return val !== null ? val === 0 ? 1 : 0 : null;
    }
    return null;
  }
  // Inline map: compile map(arr, fn(x){body}) as a WASM loop
  // Only used when callback has no captures and 1 parameter
  _compileInlineMap(arrExpr, callback) {
    const paramName = callback.parameters[0].value || callback.parameters[0].token?.literal;
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const resultLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.compileNode(arrExpr);
    this.currentBody.localSet(arrLocal);
    this.currentBody.localGet(arrLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load();
    this.currentBody.localSet(lenLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.call(this._runtimeFuncs.makeArray);
    this.currentBody.localSet(resultLocal);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);
    const prevScope = this.currentScope;
    this.currentScope = new Scope(prevScope);
    const paramLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentScope.define(paramName, paramLocal, ValType.i32);
    this.currentBody.block();
    this.currentBody.loop();
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1);
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.arrayGet);
    this.currentBody.localSet(paramLocal);
    this._compileBlockReturning(callback.body);
    const tmpLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(tmpLocal);
    this.currentBody.localGet(resultLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(tmpLocal);
    this.currentBody.call(this._runtimeFuncs.arraySet);
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(0);
    this.currentBody.end();
    this.currentBody.end();
    this.currentScope = prevScope;
    this.currentBody.localGet(resultLocal);
  }
  // Inline filter: compile filter(arr, fn(x){pred}) as a WASM loop + conditional push
  _compileInlineFilter(arrExpr, callback) {
    const paramName = callback.parameters[0].value || callback.parameters[0].token?.literal;
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const resultLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.compileNode(arrExpr);
    this.currentBody.localSet(arrLocal);
    this.currentBody.localGet(arrLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load();
    this.currentBody.localSet(lenLocal);
    this.currentBody.i32Const(0);
    this.currentBody.call(this._runtimeFuncs.makeArray);
    this.currentBody.localSet(resultLocal);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);
    const prevScope = this.currentScope;
    this.currentScope = new Scope(prevScope);
    const paramLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentScope.define(paramName, paramLocal, ValType.i32);
    this.currentBody.block();
    this.currentBody.loop();
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1);
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.arrayGet);
    this.currentBody.localSet(paramLocal);
    this._compileBlockReturning(callback.body);
    this.currentBody.if_(ValType.void);
    this.currentBody.localGet(resultLocal);
    this.currentBody.localGet(paramLocal);
    this.currentBody.call(this._runtimeFuncs.push);
    this.currentBody.localSet(resultLocal);
    this.currentBody.end();
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(0);
    this.currentBody.end();
    this.currentBody.end();
    this.currentScope = prevScope;
    this.currentBody.localGet(resultLocal);
  }
  // Inline reduce: compile reduce(arr, fn(acc,el){body}, init) as a WASM loop with accumulator
  _compileInlineReduce(arrExpr, callback, initExpr) {
    const accName = callback.parameters[0].value || callback.parameters[0].token?.literal;
    const elemName = callback.parameters[1].value || callback.parameters[1].token?.literal;
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const accLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.compileNode(arrExpr);
    this.currentBody.localSet(arrLocal);
    this.currentBody.localGet(arrLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load();
    this.currentBody.localSet(lenLocal);
    if (initExpr) {
      this.compileNode(initExpr);
    } else {
      this.currentBody.localGet(arrLocal);
      this.currentBody.i32Const(0);
      this.currentBody.call(this._runtimeFuncs.arrayGet);
    }
    this.currentBody.localSet(accLocal);
    this.currentBody.i32Const(initExpr ? 0 : 1);
    this.currentBody.localSet(iLocal);
    const prevScope = this.currentScope;
    this.currentScope = new Scope(prevScope);
    const accParamLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentScope.define(accName, accParamLocal, ValType.i32);
    const elemParamLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentScope.define(elemName, elemParamLocal, ValType.i32);
    this.currentBody.block();
    this.currentBody.loop();
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1);
    this.currentBody.localGet(accLocal);
    this.currentBody.localSet(accParamLocal);
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.arrayGet);
    this.currentBody.localSet(elemParamLocal);
    this._compileBlockReturning(callback.body);
    this.currentBody.localSet(accLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);
    this.currentBody.br(0);
    this.currentBody.end();
    this.currentBody.end();
    this.currentScope = prevScope;
    this.currentBody.localGet(accLocal);
  }
};
function createWasmImports(outputLines = [], memoryRef = { memory: null }) {
  const hashMaps = /* @__PURE__ */ new Map();
  let nextHashId = 1;
  function readString(ptr) {
    const mem = memoryRef.memory;
    if (!mem || ptr <= 0) return "";
    const view = new DataView(mem.buffer);
    const tag = view.getInt32(ptr, true);
    if (tag !== TAG_STRING2) return String(ptr);
    const len = view.getInt32(ptr + 4, true);
    const bytes = new Uint8Array(mem.buffer, ptr + 8, len);
    return new TextDecoder().decode(bytes);
  }
  function isFloatPtr(v) {
    const mem = memoryRef.memory;
    if (!mem || v < 16 || (v & 3) !== 0) return false;
    const view = new DataView(mem.buffer);
    if (v + 12 > view.byteLength) return false;
    return view.getInt32(v, true) === TAG_FLOAT;
  }
  function readFloat(ptr) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const view = new DataView(mem.buffer);
    return view.getFloat64(ptr + 4, true);
  }
  function hostAlloc(size) {
    size = size + 3 & ~3;
    if (memoryRef.alloc) {
      return memoryRef.alloc(size);
    }
    if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
    const ptr = memoryRef.jsHeapPtr;
    memoryRef.jsHeapPtr += size;
    const mem = memoryRef.memory;
    if (mem && memoryRef.jsHeapPtr > mem.buffer.byteLength) {
      const needed = Math.ceil((memoryRef.jsHeapPtr - mem.buffer.byteLength) / 65536);
      try {
        mem.grow(needed);
      } catch (e) {
        throw new Error(`WASM heap exhausted: needed ${memoryRef.jsHeapPtr} bytes, have ${mem.buffer.byteLength}`);
      }
    }
    return ptr;
  }
  function writeFloat(value) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const view = new DataView(mem.buffer);
    const ptr = hostAlloc(12);
    view.setInt32(ptr, TAG_FLOAT, true);
    view.setFloat64(ptr + 4, value, true);
    return ptr;
  }
  function toNumber(v) {
    if (isFloatPtr(v)) return readFloat(v);
    return v;
  }
  function fromNumber(n) {
    if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) return n;
    return writeFloat(n);
  }
  function writeString(str) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const size = 8 + bytes.length;
    const ptr = hostAlloc(size);
    const view = new DataView(mem.buffer);
    view.setInt32(ptr, TAG_STRING2, true);
    view.setInt32(ptr + 4, bytes.length, true);
    new Uint8Array(mem.buffer).set(bytes, ptr + 8);
    return ptr;
  }
  function writeArray(elements) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const capacity = Math.max(elements.length, 4);
    const size = ARRAY_HEADER2 + capacity * 4;
    const ptr = hostAlloc(size);
    const view = new DataView(mem.buffer);
    view.setInt32(ptr, TAG_ARRAY2, true);
    view.setInt32(ptr + 4, elements.length, true);
    view.setInt32(ptr + 8, capacity, true);
    for (let i = 0; i < elements.length; i++) {
      view.setInt32(ptr + ARRAY_HEADER2 + i * 4, elements[i], true);
    }
    return ptr;
  }
  return {
    env: {
      puts(value) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const formatted = formatWasmValue(value, view);
          outputLines.push(formatted);
        } else {
          outputLines.push(String(value));
        }
      },
      str(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        const formatted = formatWasmValue(value, view);
        return writeString(formatted);
      },
      __str_concat(ptr1, ptr2) {
        const s1 = readString(ptr1);
        const s2 = readString(ptr2);
        return writeString(s1 + s2);
      },
      __str_eq(ptr1, ptr2) {
        const s1 = readString(ptr1);
        const s2 = readString(ptr2);
        return s1 === s2 ? 1 : 0;
      },
      __str_cmp(ptr1, ptr2) {
        const s1 = readString(ptr1);
        const s2 = readString(ptr2);
        return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
      },
      __str_char_at(ptr, index) {
        const s = readString(ptr);
        if (index < 0 || index >= s.length) return 0;
        return writeString(s[index]);
      },
      __str_split(strPtr, sepPtr) {
        const s = readString(strPtr);
        const sep = readString(sepPtr);
        const parts = s.split(sep);
        return writeArray(parts.map((p) => writeString(p)));
      },
      __str_trim(ptr) {
        const s = readString(ptr);
        return writeString(s.trim());
      },
      __str_replace(strPtr, oldPtr, newPtr) {
        const s = readString(strPtr);
        const old = readString(oldPtr);
        const newStr = readString(newPtr);
        return writeString(s.split(old).join(newStr));
      },
      __str_indexOf(strPtr, searchPtr) {
        const s = readString(strPtr);
        const search = readString(searchPtr);
        return s.indexOf(search);
      },
      __str_startsWith(strPtr, prefixPtr) {
        const s = readString(strPtr);
        const prefix = readString(prefixPtr);
        return s.startsWith(prefix) ? 1 : 0;
      },
      __str_endsWith(strPtr, suffixPtr) {
        const s = readString(strPtr);
        const suffix = readString(suffixPtr);
        return s.endsWith(suffix) ? 1 : 0;
      },
      __str_toUpper(ptr) {
        const s = readString(ptr);
        return writeString(s.toUpperCase());
      },
      __str_toLower(ptr) {
        const s = readString(ptr);
        return writeString(s.toLowerCase());
      },
      __str_substring(ptr, start, end) {
        const s = readString(ptr);
        if (end === -1) return writeString(s.substring(start));
        return writeString(s.substring(start, end));
      },
      // Utility builtins
      __abs(v) {
        if (isFloatPtr(v)) return fromNumber(Math.abs(toNumber(v)));
        return Math.abs(v);
      },
      __max(a, b) {
        return fromNumber(Math.max(toNumber(a), toNumber(b)));
      },
      __min(a, b) {
        return fromNumber(Math.min(toNumber(a), toNumber(b)));
      },
      __range(start, stop) {
        const arr = [];
        for (let i = start; i < stop; i++) arr.push(i);
        return writeArray(arr);
      },
      __join(arrPtr, sepPtr) {
        const mem = memoryRef.memory;
        if (!mem) return writeString("");
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || arrPtr + 8 > view.byteLength) return writeString("");
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY2) return writeString("");
        const len = view.getInt32(arrPtr + 4, true);
        const sep = readString(sepPtr);
        const parts = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          parts.push(readString(elem));
        }
        return writeString(parts.join(sep));
      },
      __keys(hashPtr) {
        const mem = memoryRef.memory;
        if (!mem) return writeArray([]);
        const view = new DataView(mem.buffer);
        if (hashPtr < 16) return writeArray([]);
        const tag = view.getInt32(hashPtr, true);
        if (tag !== TAG_HASH) return writeArray([]);
        const capacity = view.getInt32(hashPtr + 4, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const keys = [];
        for (let i = 0; i < capacity; i++) {
          const entryAddr = entriesPtr + i * 12;
          const status = view.getInt32(entryAddr, true);
          if (status === 1) {
            keys.push(view.getInt32(entryAddr + 4, true));
          }
        }
        return writeArray(keys);
      },
      __values(hashPtr) {
        const mem = memoryRef.memory;
        if (!mem) return writeArray([]);
        const view = new DataView(mem.buffer);
        if (hashPtr < 16) return writeArray([]);
        const tag = view.getInt32(hashPtr, true);
        if (tag !== TAG_HASH) return writeArray([]);
        const capacity = view.getInt32(hashPtr + 4, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const vals = [];
        for (let i = 0; i < capacity; i++) {
          const entryAddr = entriesPtr + i * 12;
          const status = view.getInt32(entryAddr, true);
          if (status === 1) {
            vals.push(view.getInt32(entryAddr + 8, true));
          }
        }
        return writeArray(vals);
      },
      __iter_prepare(ptr) {
        const mem = memoryRef.memory;
        if (!mem || ptr < 16) return ptr;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(ptr, true);
        if (tag === TAG_HASH) {
          const capacity = view.getInt32(ptr + 4, true);
          const entriesPtr = view.getInt32(ptr + 12, true);
          const keys = [];
          for (let i = 0; i < capacity; i++) {
            const entryAddr = entriesPtr + i * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 1) keys.push(view.getInt32(entryAddr + 4, true));
          }
          return writeArray(keys);
        }
        return ptr;
      },
      __hash_has(hashPtr, key) {
        const mem = memoryRef.memory;
        if (!mem || hashPtr < 16) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(hashPtr, true);
        if (tag !== TAG_HASH) return 0;
        const capacity = view.getInt32(hashPtr + 4, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const mask = capacity - 1;
        let isStrKey = false;
        if (key > 0) {
          try {
            isStrKey = view.getInt32(key, true) === TAG_STRING2;
          } catch (e) {
          }
        }
        if (isStrKey) {
          const keyLen = view.getInt32(key + 4, true);
          let hash2 = 2166136261 | 0;
          for (let b = 0; b < keyLen; b++) {
            hash2 ^= view.getUint8(key + 8 + b);
            hash2 = Math.imul(hash2, 16777619);
          }
          let idx2 = (hash2 >>> 0 & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx2 * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0) return 0;
            if (status === 1) {
              const storedKey = view.getInt32(entryAddr + 4, true);
              try {
                if (view.getInt32(storedKey, true) === TAG_STRING2) {
                  const storedLen = view.getInt32(storedKey + 4, true);
                  if (storedLen === keyLen) {
                    let match = true;
                    for (let b = 0; b < keyLen; b++) {
                      if (view.getUint8(storedKey + 8 + b) !== view.getUint8(key + 8 + b)) {
                        match = false;
                        break;
                      }
                    }
                    if (match) return 1;
                  }
                }
              } catch (e) {
              }
            }
            idx2 = idx2 + 1 & mask;
          }
          return 0;
        }
        let hash = Math.imul(key, 2654435769) ^ key >>> 16;
        let idx = (hash >>> 0 & mask) >>> 0;
        for (let probe = 0; probe < capacity; probe++) {
          const entryAddr = entriesPtr + idx * 12;
          const status = view.getInt32(entryAddr, true);
          if (status === 0) return 0;
          if (status === 1 && view.getInt32(entryAddr + 4, true) === key) return 1;
          idx = idx + 1 & mask;
        }
        return 0;
      },
      __hash_merge(hashPtr1, hashPtr2) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        const newHash = memoryRef.alloc(16);
        const TAG_HASH_LOCAL = 4;
        let newCap = 16;
        let newEntries = memoryRef.alloc(newCap * 12);
        new Uint8Array(mem.buffer, newEntries, newCap * 12).fill(0);
        view.setInt32(newHash, TAG_HASH_LOCAL, true);
        view.setInt32(newHash + 4, newCap, true);
        view.setInt32(newHash + 8, 0, true);
        view.setInt32(newHash + 12, newEntries, true);
        const insertInto = (k, v) => {
          let size = view.getInt32(newHash + 8, true);
          let cap = view.getInt32(newHash + 4, true);
          if (size * 4 >= cap * 3 && memoryRef.alloc) {
            const nc = cap * 2;
            const ne = memoryRef.alloc(nc * 12);
            new Uint8Array(mem.buffer, ne, nc * 12).fill(0);
            const oe = view.getInt32(newHash + 12, true);
            for (let i = 0; i < cap; i++) {
              const ea = oe + i * 12;
              if (view.getInt32(ea, true) === 1) {
                const ek = view.getInt32(ea + 4, true);
                const ev = view.getInt32(ea + 8, true);
                let isStr2 = false;
                try {
                  isStr2 = ek > 0 && view.getInt32(ek, true) === TAG_STRING2;
                } catch (e) {
                }
                let h2;
                if (isStr2) {
                  const len = view.getInt32(ek + 4, true);
                  h2 = 2166136261 | 0;
                  for (let b = 0; b < len; b++) {
                    h2 ^= view.getUint8(ek + 8 + b);
                    h2 = Math.imul(h2, 16777619);
                  }
                  h2 = h2 >>> 0;
                } else {
                  h2 = (Math.imul(ek, 2654435769) ^ ek >>> 16) >>> 0;
                }
                let idx2 = h2 & nc - 1;
                for (let p = 0; p < nc; p++) {
                  const na = ne + idx2 * 12;
                  if (view.getInt32(na, true) === 0) {
                    view.setInt32(na, 1, true);
                    view.setInt32(na + 4, ek, true);
                    view.setInt32(na + 8, ev, true);
                    break;
                  }
                  idx2 = idx2 + 1 & nc - 1;
                }
              }
            }
            view.setInt32(newHash + 4, nc, true);
            view.setInt32(newHash + 12, ne, true);
            cap = nc;
          }
          const entriesPtr = view.getInt32(newHash + 12, true);
          const mask = cap - 1;
          let isStr = false;
          try {
            isStr = k > 0 && view.getInt32(k, true) === TAG_STRING2;
          } catch (e) {
          }
          let h;
          if (isStr) {
            const len = view.getInt32(k + 4, true);
            h = 2166136261 | 0;
            for (let b = 0; b < len; b++) {
              h ^= view.getUint8(k + 8 + b);
              h = Math.imul(h, 16777619);
            }
            h = h >>> 0;
          } else {
            h = (Math.imul(k, 2654435769) ^ k >>> 16) >>> 0;
          }
          let idx = h & mask;
          for (let probe = 0; probe < cap; probe++) {
            const ea = entriesPtr + idx * 12;
            const status = view.getInt32(ea, true);
            if (status === 0 || status === 2) {
              view.setInt32(ea, 1, true);
              view.setInt32(ea + 4, k, true);
              view.setInt32(ea + 8, v, true);
              view.setInt32(newHash + 8, view.getInt32(newHash + 8, true) + 1, true);
              return;
            }
            if (status === 1) {
              const storedK = view.getInt32(ea + 4, true);
              if (isStr) {
                try {
                  if (view.getInt32(storedK, true) === TAG_STRING2) {
                    const kLen = view.getInt32(k + 4, true);
                    const sLen = view.getInt32(storedK + 4, true);
                    if (kLen === sLen) {
                      let match = true;
                      for (let b = 0; b < kLen; b++) {
                        if (view.getUint8(k + 8 + b) !== view.getUint8(storedK + 8 + b)) {
                          match = false;
                          break;
                        }
                      }
                      if (match) {
                        view.setInt32(ea + 8, v, true);
                        return;
                      }
                    }
                  }
                } catch (e) {
                }
              } else if (storedK === k) {
                view.setInt32(ea + 8, v, true);
                return;
              }
            }
            idx = idx + 1 & mask;
          }
        };
        for (const srcPtr of [hashPtr1, hashPtr2]) {
          if (srcPtr < 16) continue;
          if (view.getInt32(srcPtr, true) !== TAG_HASH_LOCAL) continue;
          const cap = view.getInt32(srcPtr + 4, true);
          const entries = view.getInt32(srcPtr + 12, true);
          for (let i = 0; i < cap; i++) {
            const ea = entries + i * 12;
            if (view.getInt32(ea, true) === 1) {
              insertInto(view.getInt32(ea + 4, true), view.getInt32(ea + 8, true));
            }
          }
        }
        return newHash;
      },
      __hash_delete(hashPtr, key) {
        const mem = memoryRef.memory;
        if (!mem || hashPtr < 16) return hashPtr;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(hashPtr, true);
        if (tag !== TAG_HASH) return hashPtr;
        const capacity = view.getInt32(hashPtr + 4, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const mask = capacity - 1;
        let isStrKey = false;
        if (key > 0) {
          try {
            isStrKey = view.getInt32(key, true) === TAG_STRING2;
          } catch (e) {
          }
        }
        if (isStrKey) {
          const keyLen = view.getInt32(key + 4, true);
          let hash = 2166136261 | 0;
          for (let b = 0; b < keyLen; b++) {
            hash ^= view.getUint8(key + 8 + b);
            hash = Math.imul(hash, 16777619);
          }
          let idx = (hash >>> 0 & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0) return hashPtr;
            if (status === 1) {
              const storedKey = view.getInt32(entryAddr + 4, true);
              try {
                if (view.getInt32(storedKey, true) === TAG_STRING2) {
                  const storedLen = view.getInt32(storedKey + 4, true);
                  if (storedLen === keyLen) {
                    let match = true;
                    for (let b = 0; b < keyLen; b++) {
                      if (view.getUint8(storedKey + 8 + b) !== view.getUint8(key + 8 + b)) {
                        match = false;
                        break;
                      }
                    }
                    if (match) {
                      view.setInt32(entryAddr, 2, true);
                      view.setInt32(hashPtr + 8, view.getInt32(hashPtr + 8, true) - 1, true);
                      return hashPtr;
                    }
                  }
                }
              } catch (e) {
              }
            }
            idx = idx + 1 & mask;
          }
        } else {
          let hash = Math.imul(key, 2654435769) ^ key >>> 16;
          let idx = (hash >>> 0 & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0) return hashPtr;
            if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
              view.setInt32(entryAddr, 2, true);
              view.setInt32(hashPtr + 8, view.getInt32(hashPtr + 8, true) - 1, true);
              return hashPtr;
            }
            idx = idx + 1 & mask;
          }
        }
        return hashPtr;
      },
      __contains(arrPtr, elem) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || arrPtr + 8 > view.byteLength) return 0;
        const tag = view.getInt32(arrPtr, true);
        if (tag === TAG_STRING2) {
          const s = readString(arrPtr);
          const search = readString(elem);
          return s.includes(search) ? 1 : 0;
        }
        if (tag !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        for (let i = 0; i < len; i++) {
          if (view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true) === elem) return 1;
        }
        return 0;
      },
      __reverse(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16) return 0;
        const tag = view.getInt32(arrPtr, true);
        if (tag === TAG_STRING2) {
          return writeString(readString(arrPtr).split("").reverse().join(""));
        }
        if (tag !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const elems = [];
        for (let i = len - 1; i >= 0; i--) {
          elems.push(view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true));
        }
        return writeArray(elems);
      },
      // Higher-order functions: call closure via exported table
      // NOTE: After each callback, we must refresh the DataView because
      // WASM memory may have grown (buffer detached on Memory.grow())
      __map(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          results.push(fn(envPtr, elem));
        }
        return writeArray(results);
      },
      __filter(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          if (fn(envPtr, elem)) results.push(elem);
        }
        return writeArray(results);
      },
      __reduce(arrPtr, closurePtr, initValue) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const sentinel = -2147483648;
        let acc;
        let startIdx;
        if (initValue !== sentinel) {
          acc = initValue;
          startIdx = 0;
        } else {
          if (len === 0) return 0;
          acc = view.getInt32(arrPtr + ARRAY_HEADER2, true);
          startIdx = 1;
        }
        for (let i = startIdx; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          acc = fn(envPtr, acc, elem);
        }
        return acc;
      },
      __find(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          if (fn(envPtr, elem)) return elem;
        }
        return 0;
      },
      __any(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          if (fn(envPtr, elem)) return 1;
        }
        return 0;
      },
      __every(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          if (!fn(envPtr, elem)) return 0;
        }
        return 1;
      },
      __sort(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const elems = [];
        for (let i = 0; i < len; i++) {
          elems.push(view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true));
        }
        if (closurePtr > 0 && view.getInt32(closurePtr, true) === TAG_CLOSURE2) {
          const table = memoryRef.table;
          if (table) {
            const tableIdx = view.getInt32(closurePtr + 4, true);
            const envPtr = view.getInt32(closurePtr + 8, true);
            const cmpFn = table.get(tableIdx);
            elems.sort((a, b) => cmpFn(envPtr, a, b));
          }
        } else {
          elems.sort((a, b) => a - b);
        }
        return writeArray(elems);
      },
      __forEach(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          fn(envPtr, view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true));
        }
        return 0;
      },
      __flatMap(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          const subResult = fn(envPtr, elem);
          view = new DataView(mem.buffer);
          if (subResult > 0 && view.getInt32(subResult, true) === TAG_ARRAY2) {
            const subLen = view.getInt32(subResult + 4, true);
            for (let j = 0; j < subLen; j++) {
              results.push(view.getInt32(subResult + ARRAY_HEADER2 + j * 4, true));
            }
          } else {
            results.push(subResult);
          }
        }
        return writeArray(results);
      },
      __zip(arrAPtr, arrBPtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrAPtr < 16 || view.getInt32(arrAPtr, true) !== TAG_ARRAY2) return 0;
        if (arrBPtr < 16 || view.getInt32(arrBPtr, true) !== TAG_ARRAY2) return 0;
        const lenA = view.getInt32(arrAPtr + 4, true);
        const lenB = view.getInt32(arrBPtr + 4, true);
        const len = Math.min(lenA, lenB);
        const pairs = [];
        for (let i = 0; i < len; i++) {
          const a = view.getInt32(arrAPtr + ARRAY_HEADER2 + i * 4, true);
          const b = view.getInt32(arrBPtr + ARRAY_HEADER2 + i * 4, true);
          pairs.push(writeArray([a, b]));
        }
        return writeArray(pairs);
      },
      __enumerate(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const pairs = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + i * 4, true);
          pairs.push(writeArray([i, elem]));
        }
        return writeArray(pairs);
      },
      __add(a, b) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const isStrPtr = (v) => {
            if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
            const tag = view.getInt32(v, true);
            if (tag !== TAG_STRING2) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1e6 && v + 8 + len <= view.byteLength;
          };
          try {
            if (isFloatPtr(a) || isFloatPtr(b)) {
              return fromNumber(toNumber(a) + toNumber(b));
            }
            if (isStrPtr(a) || isStrPtr(b)) {
              const sA = isStrPtr(a) ? readString(a) : String(a);
              const sB = isStrPtr(b) ? readString(b) : String(b);
              return writeString(sA + sB);
            }
          } catch (e) {
          }
        }
        return a + b;
      },
      __eq(a, b) {
        if (a === b) return 1;
        try {
          if (isFloatPtr(a) || isFloatPtr(b)) {
            return toNumber(a) === toNumber(b) ? 1 : 0;
          }
          const mem = memoryRef.memory;
          if (mem) {
            const view = new DataView(mem.buffer);
            const isStrPtr = (v) => {
              if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
              const tag = view.getInt32(v, true);
              if (tag !== TAG_STRING2) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1e6 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) === readString(b) ? 1 : 0;
            }
          }
        } catch (e) {
        }
        return a === b ? 1 : 0;
      },
      __lt(a, b) {
        try {
          if (isFloatPtr(a) || isFloatPtr(b)) {
            return toNumber(a) < toNumber(b) ? 1 : 0;
          }
          const mem = memoryRef.memory;
          if (mem) {
            const view = new DataView(mem.buffer);
            const isStrPtr = (v) => {
              if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
              const tag = view.getInt32(v, true);
              if (tag !== TAG_STRING2) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1e6 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) < readString(b) ? 1 : 0;
            }
          }
        } catch (e) {
        }
        return a < b ? 1 : 0;
      },
      __gt(a, b) {
        try {
          if (isFloatPtr(a) || isFloatPtr(b)) {
            return toNumber(a) > toNumber(b) ? 1 : 0;
          }
          const mem = memoryRef.memory;
          if (mem) {
            const view = new DataView(mem.buffer);
            const isStrPtr = (v) => {
              if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
              const tag = view.getInt32(v, true);
              if (tag !== TAG_STRING2) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1e6 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) > readString(b) ? 1 : 0;
            }
          }
        } catch (e) {
        }
        return a > b ? 1 : 0;
      },
      // Float arithmetic host imports
      __float_new(lo, hi) {
        const buf = new ArrayBuffer(8);
        const i32 = new Int32Array(buf);
        const f64 = new Float64Array(buf);
        i32[0] = lo;
        i32[1] = hi;
        return writeFloat(f64[0]);
      },
      __sub(a, b) {
        return fromNumber(toNumber(a) - toNumber(b));
      },
      __mul(a, b) {
        return fromNumber(toNumber(a) * toNumber(b));
      },
      __div(a, b) {
        const nb = toNumber(b);
        if (nb === 0) {
          if (isFloatPtr(a) || isFloatPtr(b)) return fromNumber(toNumber(a) / nb);
          return 0;
        }
        return fromNumber(toNumber(a) / nb);
      },
      __mod(a, b) {
        const nb = toNumber(b);
        if (nb === 0) {
          if (isFloatPtr(a) || isFloatPtr(b)) return fromNumber(NaN);
          return 0;
        }
        return fromNumber(toNumber(a) % nb);
      },
      __neg(a) {
        return fromNumber(-toNumber(a));
      },
      __to_float(a) {
        return writeFloat(a);
      },
      __array_concat(arrA, arrB) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        const lenA = arrA > 0 && view.getInt32(arrA, true) === TAG_ARRAY2 ? view.getInt32(arrA + 4, true) : 0;
        const lenB = arrB > 0 && view.getInt32(arrB, true) === TAG_ARRAY2 ? view.getInt32(arrB + 4, true) : 0;
        const newLen = lenA + lenB;
        const newCap = Math.max(newLen, 4);
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += ARRAY_HEADER2 + newCap * 4;
        memoryRef.jsHeapPtr = memoryRef.jsHeapPtr + 3 & ~3;
        view.setInt32(newPtr, TAG_ARRAY2, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
        for (let i = 0; i < lenA; i++) {
          view.setInt32(newPtr + ARRAY_HEADER2 + i * 4, view.getInt32(arrA + ARRAY_HEADER2 + i * 4, true), true);
        }
        for (let i = 0; i < lenB; i++) {
          view.setInt32(newPtr + ARRAY_HEADER2 + (lenA + i) * 4, view.getInt32(arrB + ARRAY_HEADER2 + i * 4, true), true);
        }
        return newPtr;
      },
      __rest(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (len <= 0) return 0;
        const newLen = len - 1;
        const newCap = Math.max(newLen, 4);
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        const newSize = ARRAY_HEADER2 + newCap * 4;
        memoryRef.jsHeapPtr += newSize;
        memoryRef.jsHeapPtr = memoryRef.jsHeapPtr + 3 & ~3;
        view.setInt32(newPtr, TAG_ARRAY2, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + (i + 1) * 4, true);
          view.setInt32(newPtr + ARRAY_HEADER2 + i * 4, elem, true);
        }
        return newPtr;
      },
      __type(value) {
        const mem = memoryRef.memory;
        if (!mem) return writeString("unknown");
        const view = new DataView(mem.buffer);
        if (value >= 16 && (value & 3) === 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true);
            const len = view.getInt32(value + 4, true);
            if (tag === TAG_STRING2 && len >= 0 && len < 1e6) return writeString("STRING");
            if (tag === TAG_ARRAY2 && len >= 0 && len < 1e6) return writeString("ARRAY");
            if (tag === TAG_CLOSURE2) return writeString("FUNCTION");
          } catch (e) {
          }
        }
        return writeString("INTEGER");
      },
      __int(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true);
            if (tag === TAG_STRING2) {
              const str = readString(value);
              return parseInt(str, 10) || 0;
            }
          } catch (e) {
          }
        }
        return value;
      },
      __slice(arrPtr, start, end) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY2) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (end < 0) end = len;
        if (start < 0) start = 0;
        if (end > len) end = len;
        const newLen = Math.max(0, end - start);
        const newCap = Math.max(newLen, 4);
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += ARRAY_HEADER2 + newCap * 4;
        memoryRef.jsHeapPtr = memoryRef.jsHeapPtr + 3 & ~3;
        view.setInt32(newPtr, TAG_ARRAY2, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER2 + (start + i) * 4, true);
          view.setInt32(newPtr + ARRAY_HEADER2 + i * 4, elem, true);
        }
        return newPtr;
      },
      __hash_new() {
        const id = nextHashId++;
        hashMaps.set(id, /* @__PURE__ */ new Map());
        return id;
      },
      __hash_set(hashId, key, value) {
        const map = hashMaps.get(hashId);
        if (!map) return hashId;
        const mem = memoryRef.memory;
        let resolvedKey = key;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tag = view.getInt32(key, true);
            if (tag === TAG_STRING2) {
              resolvedKey = "s:" + readString(key);
            }
          } catch (e) {
          }
        }
        map.set(resolvedKey, value);
        return hashId;
      },
      __hash_get(hashId, key) {
        const map = hashMaps.get(hashId);
        if (!map) return 0;
        const mem = memoryRef.memory;
        let resolvedKey = key;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tag = view.getInt32(key, true);
            if (tag === TAG_STRING2) {
              resolvedKey = "s:" + readString(key);
            }
          } catch (e) {
          }
        }
        return map.get(resolvedKey) || 0;
      },
      __index_get(obj, key) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          const mem2 = memoryRef.memory;
          let resolvedKey = key;
          if (mem2 && key > 0) {
            const view2 = new DataView(mem2.buffer);
            try {
              const tag2 = view2.getInt32(key, true);
              if (tag2 === TAG_STRING2) {
                resolvedKey = "s:" + readString(key);
              }
            } catch (e) {
            }
          }
          return map.get(resolvedKey) || 0;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true);
        if (tag === TAG_HASH) {
          const capacity = view.getInt32(obj + 4, true);
          const entriesPtr = view.getInt32(obj + 12, true);
          const mask = capacity - 1;
          let isStrKey = false;
          if (key > 0) {
            try {
              isStrKey = view.getInt32(key, true) === TAG_STRING2;
            } catch (e) {
            }
          }
          if (isStrKey) {
            const keyLen = view.getInt32(key + 4, true);
            let hash2 = 2166136261 | 0;
            for (let b = 0; b < keyLen; b++) {
              hash2 ^= view.getUint8(key + 8 + b);
              hash2 = Math.imul(hash2, 16777619);
            }
            let idx2 = (hash2 >>> 0 & mask) >>> 0;
            for (let probe = 0; probe < capacity; probe++) {
              const entryAddr = entriesPtr + idx2 * 12;
              const status = view.getInt32(entryAddr, true);
              if (status === 0) return 0;
              if (status === 1) {
                const storedKey = view.getInt32(entryAddr + 4, true);
                try {
                  if (view.getInt32(storedKey, true) === TAG_STRING2) {
                    const storedLen = view.getInt32(storedKey + 4, true);
                    if (storedLen === keyLen) {
                      let match = true;
                      for (let b = 0; b < keyLen; b++) {
                        if (view.getUint8(storedKey + 8 + b) !== view.getUint8(key + 8 + b)) {
                          match = false;
                          break;
                        }
                      }
                      if (match) return view.getInt32(entryAddr + 8, true);
                    }
                  }
                } catch (e) {
                }
              }
              idx2 = idx2 + 1 & mask;
            }
            return 0;
          }
          let hash = Math.imul(key, 2654435769) ^ key >>> 16;
          let idx = (hash & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0) return 0;
            if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
              return view.getInt32(entryAddr + 8, true);
            }
            idx = idx + 1 & mask;
          }
          return 0;
        }
        if (tag === TAG_STRING2) {
          const str = readString(obj);
          if (key < 0 || key >= str.length) return 0;
          return writeString(str[key]);
        }
        if (tag !== TAG_ARRAY2) return 0;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return 0;
        return view.getInt32(obj + ARRAY_HEADER2 + key * 4, true);
      },
      __index_set(obj, key, value) {
        if (hashMaps.has(obj)) {
          const map = hashMaps.get(obj);
          const mem2 = memoryRef.memory;
          let resolvedKey = key;
          if (mem2 && key > 0) {
            const view2 = new DataView(mem2.buffer);
            try {
              const tag2 = view2.getInt32(key, true);
              if (tag2 === TAG_STRING2) {
                resolvedKey = "s:" + readString(key);
              }
            } catch (e) {
            }
          }
          map.set(resolvedKey, value);
          return;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true);
        if (tag === TAG_HASH) {
          const capacity = view.getInt32(obj + 4, true);
          const entriesPtr = view.getInt32(obj + 12, true);
          const mask = capacity - 1;
          let isStrKey = false;
          if (key > 0) {
            try {
              isStrKey = view.getInt32(key, true) === TAG_STRING2;
            } catch (e) {
            }
          }
          if (isStrKey) {
            const keyLen = view.getInt32(key + 4, true);
            const fnvHashStr = (ptr) => {
              const len2 = view.getInt32(ptr + 4, true);
              let h = 2166136261 | 0;
              for (let b = 0; b < len2; b++) {
                h ^= view.getUint8(ptr + 8 + b);
                h = Math.imul(h, 16777619);
              }
              return h >>> 0;
            };
            let curSize = view.getInt32(obj + 8, true);
            let curCap = capacity;
            let curEntries = entriesPtr;
            let curMask = mask;
            if (curSize * 4 >= curCap * 3 && memoryRef.alloc) {
              const newCap = curCap * 2;
              const newEntriesPtr = memoryRef.alloc(newCap * 12);
              const bytes = new Uint8Array(mem.buffer, newEntriesPtr, newCap * 12);
              bytes.fill(0);
              for (let i = 0; i < curCap; i++) {
                const ea = curEntries + i * 12;
                if (view.getInt32(ea, true) === 1) {
                  const k = view.getInt32(ea + 4, true);
                  const v = view.getInt32(ea + 8, true);
                  const h2 = fnvHashStr(k);
                  let ni = (h2 & newCap - 1) >>> 0;
                  for (let p = 0; p < newCap; p++) {
                    const na = newEntriesPtr + ni * 12;
                    if (view.getInt32(na, true) === 0) {
                      view.setInt32(na, 1, true);
                      view.setInt32(na + 4, k, true);
                      view.setInt32(na + 8, v, true);
                      break;
                    }
                    ni = ni + 1 & newCap - 1;
                  }
                }
              }
              view.setInt32(obj + 4, newCap, true);
              view.setInt32(obj + 12, newEntriesPtr, true);
              curCap = newCap;
              curEntries = newEntriesPtr;
              curMask = newCap - 1;
            }
            let hash2 = 2166136261 | 0;
            for (let b = 0; b < keyLen; b++) {
              hash2 ^= view.getUint8(key + 8 + b);
              hash2 = Math.imul(hash2, 16777619);
            }
            let idx2 = (hash2 >>> 0 & curMask) >>> 0;
            for (let probe = 0; probe < curCap; probe++) {
              const entryAddr = curEntries + idx2 * 12;
              const status = view.getInt32(entryAddr, true);
              if (status === 0 || status === 2) {
                view.setInt32(entryAddr, 1, true);
                view.setInt32(entryAddr + 4, key, true);
                view.setInt32(entryAddr + 8, value, true);
                view.setInt32(obj + 8, view.getInt32(obj + 8, true) + 1, true);
                return;
              }
              if (status === 1) {
                const storedKey = view.getInt32(entryAddr + 4, true);
                try {
                  if (view.getInt32(storedKey, true) === TAG_STRING2) {
                    const storedLen = view.getInt32(storedKey + 4, true);
                    if (storedLen === keyLen) {
                      let match = true;
                      for (let b = 0; b < keyLen; b++) {
                        if (view.getUint8(storedKey + 8 + b) !== view.getUint8(key + 8 + b)) {
                          match = false;
                          break;
                        }
                      }
                      if (match) {
                        view.setInt32(entryAddr + 8, value, true);
                        return;
                      }
                    }
                  }
                } catch (e) {
                }
              }
              idx2 = idx2 + 1 & curMask;
            }
            return;
          }
          let hash = Math.imul(key, 2654435769) ^ key >>> 16;
          let idx = (hash & mask) >>> 0;
          let size = view.getInt32(obj + 8, true);
          if (size * 4 >= capacity * 3) {
            const newCap = capacity * 2;
            const newEntriesSize = newCap * 12;
            const allocExport = memoryRef.alloc;
            if (allocExport) {
              const newEntriesPtr = allocExport(newEntriesSize);
              const bytes = new Uint8Array(mem.buffer, newEntriesPtr, newEntriesSize);
              bytes.fill(0);
              for (let i = 0; i < capacity; i++) {
                const ea = entriesPtr + i * 12;
                if (view.getInt32(ea, true) === 1) {
                  const k = view.getInt32(ea + 4, true);
                  const v = view.getInt32(ea + 8, true);
                  let h2 = Math.imul(k, 2654435769) ^ k >>> 16;
                  let ni = (h2 >>> 0 & newCap - 1) >>> 0;
                  for (let p = 0; p < newCap; p++) {
                    const na = newEntriesPtr + ni * 12;
                    if (view.getInt32(na, true) === 0) {
                      view.setInt32(na, 1, true);
                      view.setInt32(na + 4, k, true);
                      view.setInt32(na + 8, v, true);
                      break;
                    }
                    ni = ni + 1 & newCap - 1;
                  }
                }
              }
              view.setInt32(obj + 4, newCap, true);
              view.setInt32(obj + 12, newEntriesPtr, true);
              const updatedEntriesPtr = newEntriesPtr;
              const updatedMask = newCap - 1;
              hash = Math.imul(key, 2654435769) ^ key >>> 16;
              idx = (hash >>> 0 & updatedMask) >>> 0;
              for (let probe = 0; probe < newCap; probe++) {
                const entryAddr = updatedEntriesPtr + idx * 12;
                const status = view.getInt32(entryAddr, true);
                if (status === 0 || status === 2) {
                  view.setInt32(entryAddr, 1, true);
                  view.setInt32(entryAddr + 4, key, true);
                  view.setInt32(entryAddr + 8, value, true);
                  view.setInt32(obj + 8, size + 1, true);
                  return;
                }
                if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
                  view.setInt32(entryAddr + 8, value, true);
                  return;
                }
                idx = idx + 1 & updatedMask;
              }
              return;
            }
          }
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0 || status === 2) {
              view.setInt32(entryAddr, 1, true);
              view.setInt32(entryAddr + 4, key, true);
              view.setInt32(entryAddr + 8, value, true);
              if (status !== 1) {
                view.setInt32(obj + 8, view.getInt32(obj + 8, true) + 1, true);
              }
              return;
            }
            if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
              view.setInt32(entryAddr + 8, value, true);
              return;
            }
            idx = idx + 1 & mask;
          }
          return;
        }
        if (tag !== TAG_ARRAY2) return;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return;
        view.setInt32(obj + ARRAY_HEADER2 + key * 4, value, true);
      },
      // GC stubs (no-op in non-GC mode)
      __gc_alloc(size) {
        return 0;
      },
      __gc_collect() {
        return 0;
      },
      __gc_register(ptr, size) {
      },
      __gc_add_root(ptr) {
      },
      __gc_remove_root(ptr) {
      }
    }
  };
}
function formatWasmValue(value, dataView) {
  if (value > 0 && dataView && value + 8 <= dataView.byteLength) {
    try {
      const tag = dataView.getInt32(value, true);
      if (tag === TAG_STRING2) {
        const len = dataView.getInt32(value + 4, true);
        if (len >= 0 && len < 1e5 && value + 8 + len <= dataView.byteLength) {
          const bytes = new Uint8Array(dataView.buffer, value + 8, len);
          return new TextDecoder().decode(bytes);
        }
      }
      if (tag === TAG_FLOAT) {
        const f = dataView.getFloat64(value + 4, true);
        return Number.isInteger(f) ? f.toFixed(1) : String(f);
      }
      if (tag === TAG_ARRAY2) {
        const len = dataView.getInt32(value + 4, true);
        if (len >= 0 && len < 1e5) {
          const elems = [];
          for (let i = 0; i < len; i++) {
            const elem = dataView.getInt32(value + ARRAY_HEADER2 + i * 4, true);
            elems.push(formatWasmValue(elem, dataView));
          }
          return "[" + elems.join(", ") + "]";
        }
      }
      if (tag === TAG_HASH) {
        const capacity = dataView.getInt32(value + 4, true);
        const entriesPtr = dataView.getInt32(value + 12, true);
        const entries = [];
        for (let i = 0; i < capacity && entries.length < 50; i++) {
          const entryAddr = entriesPtr + i * 12;
          const status = dataView.getInt32(entryAddr, true);
          if (status === 1) {
            const k = dataView.getInt32(entryAddr + 4, true);
            const v = dataView.getInt32(entryAddr + 8, true);
            const keyStr = formatWasmValue(k, dataView);
            const valStr = formatWasmValue(v, dataView);
            entries.push(`${keyStr}: ${valStr}`);
          }
        }
        return "{" + entries.join(", ") + "}";
      }
    } catch (e) {
    }
  }
  return String(value);
}
var _moduleCache = /* @__PURE__ */ new Map();
var _MODULE_CACHE_MAX = 64;
function _hashString(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = hash * 16777619 | 0;
  }
  return hash >>> 0;
}
async function compileAndRun(input, options = {}) {
  if (typeof input !== "string") {
    throw new TypeError(`compileAndRun() expects a string, got ${typeof input}`);
  }
  const timings = {};
  const t0 = performance.now();
  const useCache = options.cache !== false;
  const cacheKey = useCache ? `${_hashString(input)}:${options.optimize ? 1 : 0}` : null;
  let module = null;
  let cacheHit = false;
  if (useCache && _moduleCache.has(cacheKey)) {
    const cached = _moduleCache.get(cacheKey);
    module = cached.module;
    if (options.warnings && cached.warnings.length > 0) {
      options.warnings.push(...cached.warnings);
    }
    timings.compile = 0;
    timings.encode = 0;
    timings.wasmCompile = 0;
    timings.cacheHit = true;
    cacheHit = true;
  }
  if (!module) {
    const compiler = new WasmCompiler();
    if (options.optimize) {
      const lexer = new Lexer(input);
      const parser = new Parser(lexer);
      const program = parser.parseProgram();
      if (parser.errors.length > 0) {
        throw new Error(`Parse errors: ${parser.errors.join(", ")}`);
      }
      const tOpt = performance.now();
      constantFold(program);
      eliminateDeadCode(program);
      if (options.typeCheck) {
        const ti = new TypeInference();
        const result = ti.infer(program);
        if (options.warnings) {
          options.warnings.push(...result.warnings);
        }
        if (options.typeErrors) {
          options.typeErrors.push(...result.errors);
        }
      }
      timings.optimize = performance.now() - tOpt;
      const builder = compiler.compileProgram(program);
      timings.compile = performance.now() - t0;
      if (!builder || compiler.errors.length > 0) {
        throw new Error(`Compilation errors: ${compiler.errors.join(", ")}`);
      }
    } else {
      compiler.compile(input);
      timings.compile = performance.now() - t0;
      if (compiler.errors.length > 0) {
        throw new Error(`Compilation errors: ${compiler.errors.join(", ")}`);
      }
    }
    if (options.warnings && compiler.warnings.length > 0) {
      options.warnings.push(...compiler.warnings);
    }
    const t1 = performance.now();
    const binary = compiler.builder.build();
    timings.encode = performance.now() - t1;
    const t2 = performance.now();
    module = await WebAssembly.compile(binary);
    timings.wasmCompile = performance.now() - t2;
    if (useCache) {
      if (_moduleCache.size >= _MODULE_CACHE_MAX) {
        const firstKey = _moduleCache.keys().next().value;
        _moduleCache.delete(firstKey);
      }
      _moduleCache.set(cacheKey, { module, warnings: compiler.warnings.slice() });
    }
  }
  const outputLines = options.outputLines || [];
  const memoryRef = { memory: null };
  let imports;
  let gc = null;
  if (options.gc) {
    gc = new WasmGC(memoryRef, typeof options.gc === "object" ? options.gc : {});
    imports = createGCImports(gc, outputLines, memoryRef);
  } else {
    imports = createWasmImports(outputLines, memoryRef);
  }
  const t3 = performance.now();
  const instance = await WebAssembly.instantiate(module, imports);
  memoryRef.memory = instance.exports.memory;
  memoryRef.table = instance.exports.__indirect_function_table || null;
  memoryRef.alloc = instance.exports.__alloc || null;
  timings.instantiate = performance.now() - t3;
  const t4 = performance.now();
  const rawResult = instance.exports.main();
  timings.execute = performance.now() - t4;
  timings.total = performance.now() - t0;
  if (options.timings) Object.assign(options.timings, timings);
  if (options.instance) options.instance.ref = instance;
  if (options.gcStats && gc) options.gcStats.ref = gc.getStats();
  if (options.raw) return rawResult;
  if (memoryRef.memory && rawResult > 0 && rawResult < memoryRef.memory.buffer.byteLength) {
    const dataView = new DataView(memoryRef.memory.buffer);
    try {
      const tag = dataView.getInt32(rawResult, true);
      if (tag === TAG_ARRAY2 || tag === TAG_STRING2 || tag === TAG_HASH || tag === TAG_FLOAT) {
        return formatWasmValue(rawResult, dataView);
      }
    } catch (e) {
    }
  }
  return rawResult;
}
export {
  compileAndRun,
  compileAndRun as compileToWasm
};
