// WASM Compiler for Monkey Language
// Walks the AST and emits WebAssembly bytecode via the binary encoder.
// Supports: integers, floats, booleans, arithmetic, comparisons, let bindings,
// if/else, while/for loops, functions, return, break/continue, strings, arrays.
//
// Memory layout:
//   0-1023: reserved (data segment for string constants)
//   1024+: bump-allocated heap (strings, arrays)
//
// Value representation (all i32):
//   Integers/booleans: raw i32 values
//   Strings: pointer to heap object [TAG_STRING:i32][length:i32][bytes...]
//   Arrays: pointer to heap object [TAG_ARRAY:i32][length:i32][elem0:i32][elem1:i32]...
//   Null: 0
//
// Heap object tags:
const TAG_STRING = 1;
const TAG_ARRAY = 2;
const TAG_CLOSURE = 3;
const TAG_HASH = 4;

import { WasmModuleBuilder, FuncBodyBuilder, Op, ValType, ExportKind, encodeULEB128 } from './wasm.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import * as ast from './ast.js';
import { peepholeOptimize } from './wasm-optimize.js';
import { WasmGC, createGCImports } from './wasm-gc.js';
import { constantFold } from './constant-fold.js';
import { eliminateDeadCode } from './dead-code.js';
import { TypeInference } from './type-inference.js';

// Compilation environment — tracks variable bindings per scope
class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map(); // name → { index, type }
    this.nextLocal = parent ? 0 : 0; // set by compiler
  }

  define(name, index, type = ValType.i32, knownInt = false) {
    this.vars.set(name, { index, type, knownInt });
  }

  resolve(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.resolve(name);
    return null;
  }
}

// WASM Compiler
export class WasmCompiler {
  constructor() {
    this.builder = new WasmModuleBuilder();
    this.functions = []; // [{name, index, params, scope}]
    this.globalScope = new Scope();
    this.currentFunc = null;
    this.currentBody = null;
    this.currentScope = null;
    this.nextParamIndex = 0;
    this.nextLocalIndex = 0;
    this.loopStack = []; // for break/continue: [{breakDepth, continueDepth}]
    this.blockDepth = 0; // current nesting depth for label calculation
    this.errors = [];
    this.warnings = [];
    this.stringConstants = []; // [{offset, length, value}] — data segment entries
    this.nextDataOffset = 65536; // start high to avoid integer/pointer confusion

    // Closure support
    this.closureFuncs = []; // [{funcLit, captures, tableIndex, wasmFuncIndex}]
    this.nextTableSlot = 0;
    this._classRegistry = new Map(); // className -> { fields, methods: [{name, tableSlot, paramCount}], ctorFuncIdx }

    // Compilation statistics
    this.stats = {
      constantsFolded: 0,
      functionsCompiled: 0,
      closuresCreated: 0,
      stringsAllocated: 0,
      arraysAllocated: 0,
    };

    // Add 1 page of memory for strings/arrays
    this.builder.addMemory(4); // 4 pages = 256KB
    
    // Exception handling: create a tag for monkey-lang exceptions (carries i32 value)
    const exTagType = this.builder.addType([ValType.i32], []);
    this._exceptionTagIdx = this.builder.addTag(exTagType);
    this.builder.addExport('memory', ExportKind.Memory, 0);

    // Heap pointer global — starts after data segment (set after compilation)
    this.heapPtr = this.builder.addGlobal(ValType.i32, true, 131072); // default, updated later

    // Runtime function indices (added during compileProgram)
    this._runtimeFuncs = {};
  }

  compile(input) {
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
    // Add runtime helper functions first
    this._addRuntimeFunctions();

    // First pass: collect top-level function names to know what's global
    const topLevelFuncNames = new Set();
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement &&
          (stmt.value instanceof ast.FunctionLiteral)) {
        topLevelFuncNames.add(stmt.name.value);
      }
    }

    // Second pass: register non-capturing functions
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement &&
          (stmt.value instanceof ast.FunctionLiteral)) {
        const params = new Set(stmt.value.parameters.map(p => p.value || p.token?.literal));
        const hasFreeVars = this._hasFreeVariables(stmt.value, params, topLevelFuncNames);
        if (!hasFreeVars) {
          this._declareFunction(stmt.name.value, stmt.value);
        }
      }
    }

    // Create a "main" function for top-level code
    const mainType = this.builder.addType([], [ValType.i32]);
    const { index: mainIdx, body: mainBody } = this.builder.addFunction([], [ValType.i32]);
    this.builder.addExport('main', ExportKind.Func, mainIdx);

    this.currentFunc = { name: 'main', index: mainIdx };
    this.currentBody = mainBody;
    this.currentScope = new Scope(this.globalScope);
    this.nextParamIndex = 0;
    this.nextLocalIndex = 0;

    let lastIsExpr = false;
    for (let i = 0; i < program.statements.length; i++) {
      const stmt = program.statements[i];
      lastIsExpr = false;

      if (stmt instanceof ast.LetStatement &&
          (stmt.value instanceof ast.FunctionLiteral)) {
        // Check if already handled as a named (non-capturing) function
        const binding = this.currentScope.resolve(stmt.name.value);
        if (binding && binding.type === 'func') {
          continue; // Already handled in first pass
        }
        // Otherwise, compile as a let with a closure value
      }

      // Handle class definitions: let ClassName = class { ... }
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.ClassStatement) {
        this.compileClassStatement(stmt.value, stmt.name.value);
        continue;
      }

      if (stmt instanceof ast.ExpressionStatement) {
        this.compileNode(stmt.expression);
        if (i < program.statements.length - 1) {
          // Drop intermediate expression results
          mainBody.drop();
        } else {
          lastIsExpr = true;
        }
      } else if (stmt instanceof ast.ReturnStatement) {
        this.compileNode(stmt.returnValue);
        mainBody.return_();
        lastIsExpr = true;
      } else {
        this.compileStatement(stmt);
      }
    }

    if (!lastIsExpr) {
      // Default return 0 if no expression result
      mainBody.i32Const(0);
    }

    // Now compile all collected functions
    this._compileFunctions();

    // Add string constant data segments
    for (const sc of this.stringConstants) {
      const encoder = new TextEncoder();
      const strBytes = encoder.encode(sc.value);
      // Layout: [TAG_STRING:i32][length:i32][bytes...]
      const data = new Uint8Array(8 + strBytes.length);
      const view = new DataView(data.buffer);
      view.setInt32(0, TAG_STRING, true);
      view.setInt32(4, strBytes.length, true);
      data.set(strBytes, 8);
      this.builder.addDataSegment(sc.offset, [...data]);
    }

    // Finalize closure table
    if (this.closureFuncs.length > 0) {
      const tableSize = this.closureFuncs.length;
      this.builder.addTable(ValType.funcref, tableSize, tableSize);
      const funcIndices = this.closureFuncs.map(cf => cf.wasmFuncIndex);
      this.builder.addElement(0, 0, funcIndices);
    }

    // Peephole optimize all function bodies
    for (const func of this.builder.functions) {
      peepholeOptimize(func.body);
    }

    return this.builder;
  }

  _addRuntimeFunctions() {
    // Import puts from JS host: env.puts(value: i32) → void
    const putsIdx = this.builder.addImport('env', 'puts', [ValType.i32], []);
    this._runtimeFuncs.puts = putsIdx;
    this.globalScope.define('puts', putsIdx, 'func');

    // Import str from JS host: env.str(value: i32) → i32 (returns string pointer)
    const strIdx = this.builder.addImport('env', 'str', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.str = strIdx;
    this.globalScope.define('str', strIdx, 'func');

    // Import __str_concat from JS host: env.__str_concat(ptr1: i32, ptr2: i32) → i32
    const strConcatIdx = this.builder.addImport('env', '__str_concat', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strConcat = strConcatIdx;

    // Import __str_eq from JS host: env.__str_eq(ptr1: i32, ptr2: i32) → i32
    const strEqIdx = this.builder.addImport('env', '__str_eq', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strEq = strEqIdx;

    // Import __str_cmp: compare two strings, returns -1/0/1
    const strCmpIdx = this.builder.addImport('env', '__str_cmp', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strCmp = strCmpIdx;

    // Import __str_char_at: returns single character string at index
    const strCharAtIdx = this.builder.addImport('env', '__str_char_at', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strCharAt = strCharAtIdx;

    // Import __add: runtime-dispatched addition (int + int or string concat)
    const addIdx = this.builder.addImport('env', '__add', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.add = addIdx;

    // Import __eq: runtime-dispatched equality (handles strings and ints)
    const eqIdx = this.builder.addImport('env', '__eq', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.eq = eqIdx;

    // Import __lt: runtime-dispatched less-than (handles strings and ints)
    const ltIdx = this.builder.addImport('env', '__lt', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.lt = ltIdx;

    // Import __gt: runtime-dispatched greater-than
    const gtIdx = this.builder.addImport('env', '__gt', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.gt = gtIdx;

    // Import __array_concat: concatenate two arrays
    const arrayConcatIdx = this.builder.addImport('env', '__array_concat', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.arrayConcat = arrayConcatIdx;

    // Import __rest from JS host: env.__rest(arr_ptr: i32) → i32 (new array without first)
    const restIdx = this.builder.addImport('env', '__rest', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.rest = restIdx;

    // Import __type from JS host: env.__type(value: i32) → i32 (returns string pointer of type name)
    const typeIdx = this.builder.addImport('env', '__type', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.type = typeIdx;
    this.globalScope.define('type', typeIdx, 'func');

    // Import __int from JS host: env.__int(value: i32) → i32 (parse string to integer)
    const intIdx = this.builder.addImport('env', '__int', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.int = intIdx;
    this.globalScope.define('int', intIdx, 'func');

    // Import __slice from JS host: env.__slice(arr: i32, start: i32, end: i32) → i32
    const sliceIdx = this.builder.addImport('env', '__slice', [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.slice = sliceIdx;

    // Import hash map operations from JS host
    const hashNewIdx = this.builder.addImport('env', '__hash_new', [], [ValType.i32]);
    this._runtimeFuncs.hashNew = hashNewIdx;

    const hashSetIdx = this.builder.addImport('env', '__hash_set', [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashSet = hashSetIdx;

    const hashGetIdx = this.builder.addImport('env', '__hash_get', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.hashGet = hashGetIdx;

    // Unified index getter: dispatches to arrayGet or hashGet based on object type
    const indexGetIdx = this.builder.addImport('env', '__index_get', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.indexGet = indexGetIdx;

    // Unified index setter: dispatches to array set or hash set
    const indexSetIdx = this.builder.addImport('env', '__index_set', [ValType.i32, ValType.i32, ValType.i32], []);
    this._runtimeFuncs.indexSet = indexSetIdx;

    // GC imports: __gc_alloc(size) → ptr, __gc_collect() → freed_bytes, __gc_register(ptr, size) → void
    const gcAllocIdx = this.builder.addImport('env', '__gc_alloc', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.gcAlloc = gcAllocIdx;

    const gcCollectIdx = this.builder.addImport('env', '__gc_collect', [], [ValType.i32]);
    this._runtimeFuncs.gcCollect = gcCollectIdx;

    const gcRegisterIdx = this.builder.addImport('env', '__gc_register', [ValType.i32, ValType.i32], []);
    this._runtimeFuncs.gcRegister = gcRegisterIdx;

    const gcAddRootIdx = this.builder.addImport('env', '__gc_add_root', [ValType.i32], []);
    this._runtimeFuncs.gcAddRoot = gcAddRootIdx;

    const gcRemoveRootIdx = this.builder.addImport('env', '__gc_remove_root', [ValType.i32], []);
    this._runtimeFuncs.gcRemoveRoot = gcRemoveRootIdx;

    // __alloc(size) → pointer — bump allocator, registers with GC for tracking
    const { index: allocIdx, body: allocBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    allocBody.addLocal(ValType.i32); // local[1] = ptr
    allocBody
      .globalGet(this.heapPtr) // ptr = heap_ptr
      .localTee(1)
      .localGet(0)             // size
      .emit(Op.i32_add)        // heap_ptr + size
      .globalSet(this.heapPtr) // heap_ptr = heap_ptr + size
      // Register allocation with GC
      .localGet(1)             // ptr
      .localGet(0)             // size
      .call(gcRegisterIdx);    // __gc_register(ptr, size)
    allocBody.localGet(1);      // return old heap_ptr
    this._runtimeFuncs.alloc = allocIdx;

    // __len(ptr) → i32 — get length of string or array
    const { index: lenIdx, body: lenBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    lenBody
      .localGet(0)
      .i32Const(4)
      .emit(Op.i32_add)       // ptr + 4 (skip tag)
      .i32Load();             // load length
    this._runtimeFuncs.len = lenIdx;

    // __array_get(arr_ptr, index) → i32 — array element access
    const { index: arrGetIdx, body: arrGetBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32], [ValType.i32]
    );
    arrGetBody
      .localGet(0)           // arr_ptr
      .i32Const(8)
      .emit(Op.i32_add)      // skip tag + length
      .localGet(1)           // index
      .i32Const(4)
      .emit(Op.i32_mul)      // index * 4
      .emit(Op.i32_add)      // arr_ptr + 8 + index*4
      .i32Load();            // load element
    this._runtimeFuncs.arrayGet = arrGetIdx;

    // __array_set(arr_ptr, index, value) → void
    const { index: arrSetIdx, body: arrSetBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32], []
    );
    arrSetBody
      .localGet(0)           // arr_ptr
      .i32Const(8)
      .emit(Op.i32_add)
      .localGet(1)           // index
      .i32Const(4)
      .emit(Op.i32_mul)
      .emit(Op.i32_add)      // addr = arr_ptr + 8 + index*4
      .localGet(2)           // value
      .i32Store();           // store value
    this._runtimeFuncs.arraySet = arrSetIdx;

    // __make_array(length) → ptr — allocate an array with given length, zero-initialized
    const { index: makeArrIdx, body: makeArrBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    makeArrBody.addLocal(ValType.i32); // local[1] = ptr
    makeArrBody
      // Allocate: 8 + length*4 bytes
      .localGet(0).i32Const(4).emit(Op.i32_mul).i32Const(8).emit(Op.i32_add)
      .call(allocIdx)
      .localTee(1)
      // Store tag
      .i32Const(TAG_ARRAY)
      .i32Store()
      // Store length
      .localGet(1).i32Const(4).emit(Op.i32_add)
      .localGet(0)
      .i32Store();
    makeArrBody.localGet(1); // return ptr
    this._runtimeFuncs.makeArray = makeArrIdx;

    // __push(arr_ptr, value) → new_arr_ptr — append element to array (creates new array)
    const { index: pushIdx, body: pushBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32], [ValType.i32]
    );
    pushBody.addLocal(ValType.i32); // local[2] = old_len
    pushBody.addLocal(ValType.i32); // local[3] = new_arr
    pushBody.addLocal(ValType.i32); // local[4] = i
    pushBody
      // old_len = len(arr)
      .localGet(0).call(lenIdx).localSet(2)
      // new_arr = make_array(old_len + 1)
      .localGet(2).i32Const(1).emit(Op.i32_add).call(makeArrIdx).localSet(3)
      // Copy elements
      .i32Const(0).localSet(4)
      .block().loop()
        .localGet(4).localGet(2).emit(Op.i32_ge_s).brIf(1)
        .localGet(3).localGet(4)
        .localGet(0).localGet(4).call(arrGetIdx)
        .call(arrSetIdx)
        .localGet(4).i32Const(1).emit(Op.i32_add).localSet(4)
        .br(0)
      .end().end()
      // Set new element
      .localGet(3).localGet(2).localGet(1).call(arrSetIdx);
    pushBody.localGet(3); // return new array
    this._runtimeFuncs.push = pushIdx;

    // === Native Hash Map Functions ===
    // Hash map layout: [TAG_HASH:i32][capacity:i32][size:i32][entries_ptr:i32]
    // Entry layout: [status:i32][key:i32][value:i32] (12 bytes per entry)
    // Status: 0=empty, 1=occupied, 2=deleted
    const INITIAL_CAPACITY = 8;
    const ENTRY_SIZE = 12;

    // __hash_fnv(key: i32) → i32 — FNV-1a hash of an integer key
    const { index: hashFnvIdx, body: hashFnvBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    // Simple integer hash: multiply by golden ratio and shift
    hashFnvBody
      .localGet(0)
      .i32Const(0x9e3779b9)  // golden ratio constant
      .emit(Op.i32_mul)
      .localGet(0)
      .i32Const(16)
      .emit(Op.i32_shr_u)
      .emit(Op.i32_xor);     // key * golden_ratio ^ (key >> 16)
    this._runtimeFuncs.hashFnv = hashFnvIdx;

    // __hash_new_native() → ptr — allocate a new hash map
    const { index: hashNewNativeIdx, body: hashNewNativeBody } = this.builder.addFunction(
      [], [ValType.i32]
    );
    hashNewNativeBody.addLocal(ValType.i32); // local[0] = map_ptr
    hashNewNativeBody.addLocal(ValType.i32); // local[1] = entries_ptr
    hashNewNativeBody
      // Allocate hash map header: 16 bytes
      .i32Const(16)
      .call(allocIdx)
      .localTee(0)
      // Store TAG_HASH
      .i32Const(TAG_HASH)
      .i32Store()
      // Store capacity
      .localGet(0).i32Const(4).emit(Op.i32_add)
      .i32Const(INITIAL_CAPACITY)
      .i32Store()
      // Store size = 0
      .localGet(0).i32Const(8).emit(Op.i32_add)
      .i32Const(0)
      .i32Store()
      // Allocate entries: INITIAL_CAPACITY * 12 bytes (zero-initialized by bump allocator)
      .i32Const(INITIAL_CAPACITY * ENTRY_SIZE)
      .call(allocIdx)
      .localSet(1)
      // Store entries_ptr
      .localGet(0).i32Const(12).emit(Op.i32_add)
      .localGet(1)
      .i32Store();
    // Zero-initialize entries (status=0 means empty)
    // Bump allocator starts from zeroed memory, so entries are already 0
    hashNewNativeBody.localGet(0); // return map_ptr
    this._runtimeFuncs.hashNewNative = hashNewNativeIdx;

    // __hash_find_slot(entries_ptr: i32, capacity: i32, key: i32) → slot_index: i32
    // Linear probe: returns index where key is found, or first empty/deleted slot.
    // Uses a result local to avoid complex typed blocks.
    const { index: hashFindSlotIdx, body: hashFindSlotBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]
    );
    hashFindSlotBody.addLocal(ValType.i32); // local[3] = index
    hashFindSlotBody.addLocal(ValType.i32); // local[4] = entry_addr
    hashFindSlotBody.addLocal(ValType.i32); // local[5] = status
    hashFindSlotBody.addLocal(ValType.i32); // local[6] = result
    hashFindSlotBody.addLocal(ValType.i32); // local[7] = found flag (0=searching)
    hashFindSlotBody
      // index = hash(key) & (capacity - 1)
      .localGet(2).call(hashFnvIdx)
      .localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and)
      .localSet(3)
      .i32Const(0).localSet(7)   // found = 0
      // Probe loop
      .block().loop()
        // if found, break
        .localGet(7).brIf(1)
        // entry_addr = entries_ptr + index * 12
        .localGet(0).localGet(3).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add)
        .localSet(4)
        // status = entry.status
        .localGet(4).i32Load().localSet(5)
        // if empty: return current index
        .localGet(5).emit(Op.i32_eqz)
        .if_()
          .localGet(3).localSet(6)
          .i32Const(1).localSet(7)
        .end()
        // if occupied and key matches: return current index
        .localGet(5).i32Const(1).emit(Op.i32_eq)
        .if_()
          .localGet(4).i32Const(4).emit(Op.i32_add).i32Load()
          .localGet(2).emit(Op.i32_eq)
          .if_()
            .localGet(3).localSet(6)
            .i32Const(1).localSet(7)
          .end()
        .end()
        // if deleted and not found yet: use as candidate
        .localGet(5).i32Const(2).emit(Op.i32_eq)
        .if_()
          .localGet(7).emit(Op.i32_eqz)
          .if_()
            .localGet(3).localSet(6)
            .i32Const(1).localSet(7)
          .end()
        .end()
        // advance: index = (index + 1) & (capacity - 1)
        .localGet(3).i32Const(1).emit(Op.i32_add)
        .localGet(1).i32Const(1).emit(Op.i32_sub).emit(Op.i32_and)
        .localSet(3)
        .br(0)
      .end().end();
    hashFindSlotBody.localGet(6);  // return result
    this._runtimeFuncs.hashFindSlot = hashFindSlotIdx;

    // __hash_set_native(map_ptr: i32, key: i32, value: i32) → map_ptr: i32
    const { index: hashSetNativeIdx, body: hashSetNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]
    );
    hashSetNativeBody.addLocal(ValType.i32); // local[3] = entries_ptr
    hashSetNativeBody.addLocal(ValType.i32); // local[4] = capacity
    hashSetNativeBody.addLocal(ValType.i32); // local[5] = slot_index
    hashSetNativeBody.addLocal(ValType.i32); // local[6] = entry_addr
    hashSetNativeBody.addLocal(ValType.i32); // local[7] = old_status
    hashSetNativeBody
      .localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(3) // entries_ptr
      .localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(4)  // capacity
      // Find slot
      .localGet(3).localGet(4).localGet(1).call(hashFindSlotIdx).localSet(5)
      // entry_addr = entries_ptr + slot * 12
      .localGet(3).localGet(5).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(6)
      // old_status
      .localGet(6).i32Load().localSet(7)
      // Write entry
      .localGet(6).i32Const(1).i32Store()                                    // status = occupied
      .localGet(6).i32Const(4).emit(Op.i32_add).localGet(1).i32Store()       // key
      .localGet(6).i32Const(8).emit(Op.i32_add).localGet(2).i32Store()       // value
      // If new entry, increment size
      .localGet(7).i32Const(1).emit(Op.i32_ne)
      .if_()
        .localGet(0).i32Const(8).emit(Op.i32_add)
        .localGet(0).i32Const(8).emit(Op.i32_add).i32Load()
        .i32Const(1).emit(Op.i32_add).i32Store()
      .end();
    hashSetNativeBody.localGet(0); // return map_ptr
    this._runtimeFuncs.hashSetNative = hashSetNativeIdx;

    // __hash_get_native(map_ptr: i32, key: i32) → value: i32
    const { index: hashGetNativeIdx, body: hashGetNativeBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32], [ValType.i32]
    );
    hashGetNativeBody.addLocal(ValType.i32); // local[2] = entries_ptr
    hashGetNativeBody.addLocal(ValType.i32); // local[3] = capacity
    hashGetNativeBody.addLocal(ValType.i32); // local[4] = slot_index
    hashGetNativeBody.addLocal(ValType.i32); // local[5] = entry_addr
    hashGetNativeBody
      .localGet(0).i32Const(12).emit(Op.i32_add).i32Load().localSet(2)
      .localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(3)
      .localGet(2).localGet(3).localGet(1).call(hashFindSlotIdx).localSet(4)
      .localGet(2).localGet(4).i32Const(ENTRY_SIZE).emit(Op.i32_mul).emit(Op.i32_add).localSet(5)
      // If occupied, return value; else 0
      .localGet(5).i32Load().i32Const(1).emit(Op.i32_eq)
      .if_(ValType.i32)
        .localGet(5).i32Const(8).emit(Op.i32_add).i32Load()
      .else_()
        .i32Const(0)
      .end();
    this._runtimeFuncs.hashGetNative = hashGetNativeIdx;

    // Register builtins in global scope
    this.globalScope.define('__alloc', allocIdx, 'func');
    this.globalScope.define('__len', lenIdx, 'func');
    this.globalScope.define('__array_get', arrGetIdx, 'func');
    this.globalScope.define('__array_set', arrSetIdx, 'func');
    this.globalScope.define('__make_array', makeArrIdx, 'func');
    this.globalScope.define('__push', pushIdx, 'func');
  }

  _declareFunction(name, funcLit) {
    const params = funcLit.parameters.map(() => ValType.i32);
    const results = [ValType.i32]; // all functions return i32 for now

    const { index, body } = this.builder.addFunction(params, results);
    this.builder.addExport(name, ExportKind.Func, index);

    this.functions.push({
      name, index, body, funcLit, params,
    });

    // Register in global scope so calls can find it
    this.globalScope.define(name, index, 'func');
  }

  _compileFunctions() {
    for (const func of this.functions) {
      const prevBody = this.currentBody;
      const prevScope = this.currentScope;
      const prevFunc = this.currentFunc;
      const prevLocalIdx = this.nextLocalIndex;
      const prevParamIdx = this.nextParamIndex;
      const prevBlockDepth = this.blockDepth;

      this.currentBody = func.body;
      this.blockDepth = 0;
      this.currentFunc = func;
      this.currentScope = new Scope(this.globalScope);
      this.nextParamIndex = 0;
      this.nextLocalIndex = func.params.length;

      // Bind parameters
      for (const param of func.funcLit.parameters) {
        const name = param.value || param.token?.literal;
        this.currentScope.define(name, this.nextParamIndex, ValType.i32);
        this.nextParamIndex++;
      }

      // Compile function body
      const body = func.funcLit.body;
      this._compileBlockReturning(body);

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

      if (stmt instanceof ast.ReturnStatement) {
        this.compileNode(stmt.returnValue);
        this.currentBody.return_();
        if (!isLast) continue;
        return;
      }

      if (stmt instanceof ast.ExpressionStatement) {
        this.compileNode(stmt.expression);
        if (!isLast) {
          this.currentBody.drop();
        }
        // Last expression: leave on stack as return value
      } else {
        this.compileStatement(stmt);
        if (isLast) {
          this.currentBody.i32Const(0); // statements don't produce values
        }
      }
    }
  }

  compileStatement(stmt) {
    if (stmt instanceof ast.LetStatement) {
      this.compileLetStatement(stmt);
    } else if (stmt instanceof ast.EnumStatement) {
      // Store enum mappings for later resolution
      if (!this._enumValues) this._enumValues = {};
      for (let i = 0; i < stmt.variants.length; i++) {
        this._enumValues[`${stmt.name}.${stmt.variants[i]}`] = i;
        // Also define short name
        this._enumValues[stmt.variants[i]] = i;
        // Define as local for direct access
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.i32Const(i);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(stmt.variants[i], localIdx, 'local');
      }
    } else if (stmt instanceof ast.ClassStatement) {
      this.compileClassStatement(stmt);
    } else if (stmt instanceof ast.ImportStatement) {
      // Import statement: bind module name to empty hash (stub for WASM)
      // Real modules would require host-backed function imports per module
      this.warnings.push(`import "${stmt.moduleName}" is limited in WASM mode`);
      const bindName = stmt.alias || stmt.moduleName;
      if (stmt.bindings) {
        // Selective import: define each binding as 0 (stub)
        for (const name of stmt.bindings) {
          const localIdx = this.nextLocalIndex++;
          this.currentBody.addLocal(ValType.i32);
          this.currentBody.i32Const(0);
          this.currentBody.localSet(localIdx);
          this.currentScope.define(name, localIdx, 'local');
        }
      } else {
        // Namespace import: bind to empty hash
        this.currentBody.call(this._runtimeFuncs.hashNew);
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(bindName, localIdx, 'local');
      }
    } else if (stmt instanceof ast.DestructuringLet) {
      // let [a, b, c] = expr
      this.compileNode(stmt.value);
      const arrLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(arrLocal);
      for (let i = 0; i < stmt.names.length; i++) {
        const name = stmt.names[i];
        if (!name || name.value === '_') continue;
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localGet(arrLocal);
        this.currentBody.i32Const(i);
        this.currentBody.call(this._runtimeFuncs.indexGet);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(name.value, localIdx, 'local');
      }
    } else if (stmt instanceof ast.HashDestructuringLet) {
      // let {x, y, z} = expr — extract hash keys by name
      this.compileNode(stmt.value);
      const hashLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(hashLocal);
      for (const name of stmt.names) {
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localGet(hashLocal);
        // Create string key from the identifier name
        this.compileStringLiteral({ value: name.value });
        this.currentBody.call(this._runtimeFuncs.indexGet);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(name.value, localIdx, 'local');
      }
    } else if (stmt instanceof ast.ReturnStatement) {
      this.compileNode(stmt.returnValue);
      this.currentBody.return_();
    } else if (stmt instanceof ast.ExpressionStatement) {
      this.compileNode(stmt.expression);
      this.currentBody.drop();
    } else if (stmt instanceof ast.BreakStatement) {
      // break jumps to the block wrapping the loop
      if (this.loopStack.length > 0) {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.currentBody.br(this.blockDepth - loop.breakDepth);
      }
    } else if (stmt instanceof ast.ContinueStatement) {
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
    this.currentScope.define(name, localIdx, ValType.i32, isInt);
    if (stmt.isConst) {
      if (!this._constVars) this._constVars = new Set();
      this._constVars.add(name);
    }

    if (stmt.value) {
      this.compileNode(stmt.value);
      this.currentBody.localSet(localIdx);
    }
  }

  compileNode(node) {
    // Track source line for source map
    if (node?.token?.line && this.currentBody) {
      this.currentBody.setSourceLine(node.token.line);
    }
    if (node instanceof ast.IntegerLiteral) {
      this.currentBody.i32Const(node.value);
    } else if (node instanceof ast.FloatLiteral) {
      // For now, truncate floats to i32
      this.currentBody.i32Const(Math.trunc(node.value));
    } else if (node instanceof ast.BooleanLiteral) {
      this.currentBody.i32Const(node.value ? 1 : 0);
    } else if (node instanceof ast.NullLiteral) {
      this.currentBody.i32Const(0);
    } else if (node instanceof ast.Identifier) {
      this.compileIdentifier(node);
    } else if (node instanceof ast.PrefixExpression) {
      this.compilePrefixExpression(node);
    } else if (node instanceof ast.InfixExpression) {
      this.compileInfixExpression(node);
    } else if (node instanceof ast.IfExpression) {
      this.compileIfExpression(node);
    } else if (node instanceof ast.CallExpression) {
      this.compileCallExpression(node);
    } else if (node instanceof ast.FunctionLiteral) {
      this.compileFunctionLiteral(node);
    } else if (node instanceof ast.WhileExpression) {
      this.compileWhileExpression(node);
    } else if (node instanceof ast.ForExpression) {
      this.compileForExpression(node);
    } else if (node instanceof ast.ForInExpression) {
      this.compileForInExpression(node);
    } else if (node instanceof ast.RangeExpression) {
      this.compileRangeExpression(node);
    } else if (node instanceof ast.DoWhileExpression) {
      this.compileDoWhileExpression(node);
    } else if (node instanceof ast.AssignExpression) {
      this.compileAssignExpression(node);
    } else if (node instanceof ast.BlockStatement) {
      this._compileBlockReturning(node);
    } else if (node instanceof ast.TernaryExpression) {
      // condition ? consequence : alternative
      this.compileNode(node.condition);
      this.currentBody.if_(ValType.i32);
      this.compileNode(node.consequence);
      this.currentBody.else_();
      this.compileNode(node.alternative);
      this.currentBody.end();
    } else if (node instanceof ast.StringLiteral) {
      this.compileStringLiteral(node);
    } else if (node instanceof ast.TemplateLiteral) {
      this.compileTemplateLiteral(node);
    } else if (node instanceof ast.ArrayLiteral) {
      this.compileArrayLiteral(node);
    } else if (node instanceof ast.IndexExpression) {
      // Check if this is an enum access: EnumName.Variant
      if (node.left instanceof ast.Identifier && 
          node.index instanceof ast.StringLiteral &&
          this._enumValues) {
        const key = `${node.left.value}.${node.index.value}`;
        if (key in this._enumValues) {
          this.currentBody.i32Const(this._enumValues[key]);
          return;
        }
      }
      this.compileIndexExpression(node);
    } else if (node instanceof ast.SliceExpression) {
      // arr[start:end]
      this.compileNode(node.left);
      this.compileNode(node.start || { value: 0, constructor: ast.IntegerLiteral });
      this.compileNode(node.end || { value: 0, constructor: ast.IntegerLiteral });
      this.currentBody.call(this._runtimeFuncs.slice);
    } else if (node instanceof ast.HashLiteral) {
      this.compileHashLiteral(node);
    } else if (node instanceof ast.MatchExpression) {
      this.compileMatchExpression(node);
    } else if (node instanceof ast.ArrayComprehension) {
      this.compileArrayComprehension(node);
    } else if (node instanceof ast.TryExpression) {
      this.compileTryExpression(node);
    } else if (node instanceof ast.ThrowExpression) {
      this.compileThrowExpression(node);
    } else if (node instanceof ast.SelfExpression) {
      // self is local[0] in methods (env_ptr = instance hash)
      const binding = this.currentScope.resolve('self');
      if (binding) {
        this.currentBody.localGet(binding.index);
      } else {
        this.currentBody.i32Const(0);
      }
    } else if (node instanceof ast.ClassStatement) {
      // Class used as expression — compile and push 0 (constructor is bound by name)
      this.compileClassStatement(node);
      this.currentBody.i32Const(0); // class expressions evaluate to 0
    } else if (node instanceof ast.GeneratorLiteral) {
      // Generators require coroutine state machines — not supported in WASM
      this.warnings.push(`Generators are not supported in WASM mode (line ${node.token?.line || '?'})`);
      this.currentBody.i32Const(0);
    } else if (node instanceof ast.YieldExpression) {
      this.warnings.push(`yield is not supported in WASM mode (line ${node.token?.line || '?'})`);
      if (node.value) {
        this.compileNode(node.value);
      } else {
        this.currentBody.i32Const(0);
      }
    } else if (node instanceof ast.OptionalChainExpression) {
      // obj?.key — if obj is 0 (null), return 0; else index
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
    } else if (node instanceof ast.IndexAssignExpression) {
      this.compileNode(node.left);
      this.compileNode(node.index);
      this.compileNode(node.value);
      // array_set(arr, index, value) — returns void, so we need the value on stack
      // Use a temp local to save the value
      const tmpLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpLocal); // save value
      // Now stack: [arr, index], value in local
      // But wait — array_set needs arr, index, value as args
      // We saved value, need to push it back
      const tmpIdx = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpIdx); // save index
      const tmpArr = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(tmpArr); // save arr

      this.currentBody.localGet(tmpArr);
      this.currentBody.localGet(tmpIdx);
      this.currentBody.localGet(tmpLocal);
      this.currentBody.call(this._runtimeFuncs.indexSet);
      this.currentBody.localGet(tmpLocal); // return the assigned value
    } else {
      // Unknown/unsupported node type
      const nodeName = node?.constructor?.name || 'unknown';

      // Handle break/continue that appear as expressions
      if (node instanceof ast.BreakStatement) {
        if (this.loopStack.length > 0) {
          const loop = this.loopStack[this.loopStack.length - 1];
          this.currentBody.br(this.blockDepth - loop.breakDepth);
        }
        this.currentBody.i32Const(0); // unreachable but needed for type
        return;
      }
      if (node instanceof ast.ContinueStatement) {
        if (this.loopStack.length > 0) {
          const loop = this.loopStack[this.loopStack.length - 1];
          this.currentBody.br(this.blockDepth - loop.continueDepth);
        }
        this.currentBody.i32Const(0);
        return;
      }
      const token = node?.token;
      const loc = token?.line ? ` at line ${token.line}` : '';
      this.warnings.push(`Unsupported: ${nodeName}${loc} (compiled as 0)`);
      this.currentBody.i32Const(0);
    }
  }

  compileIdentifier(node) {
    const name = node.value;
    const binding = this.currentScope.resolve(name);
    if (binding) {
      if (binding.type === 'func') {
        // Wrap named function as a closure value
        this._wrapFunctionAsClosure(name, binding.index);
      } else {
        this.currentBody.localGet(binding.index);
      }
    } else {
      // Undefined variable
      const _l = node?.token?.line ? ` (line ${node.token.line})` : ""; this.errors.push(`undefined variable: ${name}${_l}`);
      this.currentBody.i32Const(0);
    }
  }

  // Create a closure wrapper for a named WASM function so it can be used as a value
  _wrapFunctionAsClosure(name, funcIndex) {
    // Find the function's type signature
    const funcEntry = this.functions.find(f => f.name === name);
    if (!funcEntry) {
      // Runtime function or unknown — just push 0
      this.currentBody.i32Const(0);
      return;
    }

    // Create a wrapper function that takes (env_ptr, ...params) and calls the real function
    const origParams = funcEntry.funcLit.parameters;
    const wrapperParams = [ValType.i32, ...origParams.map(() => ValType.i32)]; // env_ptr + params
    const { index: wrapperIdx, body: wrapperBody } = this.builder.addFunction(wrapperParams, [ValType.i32]);

    // Forward actual params (skip env_ptr at local[0])
    for (let i = 0; i < origParams.length; i++) {
      wrapperBody.localGet(i + 1);
    }
    wrapperBody.call(funcIndex);

    const tableSlot = this.nextTableSlot++;
    this.closureFuncs.push({
      funcLit: funcEntry.funcLit,
      captures: [],
      tableIndex: tableSlot,
      wasmFuncIndex: wrapperIdx,
    });

    // Allocate a minimal closure: [TAG_CLOSURE][table_index][env_ptr=0]
    this.currentBody.i32Const(12);
    this.currentBody.call(this._runtimeFuncs.alloc);
    const closureLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closureLocal);

    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(TAG_CLOSURE);
    this.currentBody.i32Store();

    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(tableSlot);
    this.currentBody.i32Store();

    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(0); // no env
    this.currentBody.i32Store();

    this.currentBody.localGet(closureLocal);
  }

  compilePrefixExpression(node) {
    this.compileNode(node.right);
    switch (node.operator) {
      case '-':
        // negate: 0 - value
        this.currentBody.i32Const(0);
        // Swap: we need 0 on the bottom, value on top
        // WASM doesn't have swap, so use a local
        // Actually, emit 0 first then subtract
        // Fix: emit 0 first, then the value, then sub
        break;
      case '!':
        this.currentBody.emit(Op.i32_eqz);
        break;
      default:
        // Unknown prefix
        break;
    }
  }

  compileInfixExpression(node) {
    // Constant folding: evaluate at compile time if both operands are constants
    const folded = this._tryConstantFold(node);
    if (folded !== null) {
      this.currentBody.i32Const(folded);
      this.stats.constantsFolded++;
      return;
    }

    // Special case: short-circuit && and ||
    if (node.operator === '&&') {
      this.compileNode(node.left);
      this.currentBody.if_(ValType.i32);
      this.compileNode(node.right);
      this.currentBody.else_();
      this.currentBody.i32Const(0);
      this.currentBody.end();
      return;
    }
    if (node.operator === '||') {
      this.compileNode(node.left);
      this.currentBody.localTee(this._getTempLocal());
      this.currentBody.if_(ValType.i32);
      this.currentBody.localGet(this._getTempLocal());
      this.currentBody.else_();
      this.compileNode(node.right);
      this.currentBody.end();
      return;
    }
    if (node.operator === '??') {
      // Null coalescing: a ?? b — if a is 0 (null), use b
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

    // Check if this is string concatenation
    if (node.operator === '+' && this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strConcat);
      return;
    }

    // Check if this is string comparison
    if ((node.operator === '==' || node.operator === '!=') &&
        this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strEq);
      if (node.operator === '!=') {
        this.currentBody.emit(Op.i32_eqz);
      }
      return;
    }

    // String ordering comparisons (<, >, <=, >=)
    if ((node.operator === '<' || node.operator === '>' ||
         node.operator === '<=' || node.operator === '>=') &&
        this._isStringExpression(node.left, node.right)) {
      this.compileNode(node.left);
      this.compileNode(node.right);
      this.currentBody.call(this._runtimeFuncs.strCmp);
      // strCmp returns -1/0/1
      switch (node.operator) {
        case '<':  this.currentBody.i32Const(0); this.currentBody.emit(Op.i32_lt_s); break;
        case '>':  this.currentBody.i32Const(0); this.currentBody.emit(Op.i32_gt_s); break;
        case '<=': this.currentBody.i32Const(1); this.currentBody.emit(Op.i32_lt_s); break;
        case '>=': this.currentBody.i32Const(-1); this.currentBody.emit(Op.i32_gt_s); break;
      }
      return;
    }

    this.compileNode(node.left);
    this.compileNode(node.right);

    switch (node.operator) {
      case '+':
        // Use runtime dispatch when string operations are possible
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_add);
        } else {
          this.currentBody.call(this._runtimeFuncs.add);
        }
        break;
      case '-':  this.currentBody.emit(Op.i32_sub); break;
      case '*':  this.currentBody.emit(Op.i32_mul); break;
      case '/':  this.currentBody.emit(Op.i32_div_s); break;
      case '%':  this.currentBody.emit(Op.i32_rem_s); break;
      case '==':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_eq);
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
        }
        break;
      case '!=':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_ne);
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
          this.currentBody.emit(Op.i32_eqz);
        }
        break;
      case '<':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_lt_s);
        } else {
          this.currentBody.call(this._runtimeFuncs.lt);
        }
        break;
      case '>':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_gt_s);
        } else {
          this.currentBody.call(this._runtimeFuncs.gt);
        }
        break;
      case '<=':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_le_s);
        } else {
          // a <= b === !(a > b)
          this.currentBody.call(this._runtimeFuncs.gt);
          this.currentBody.emit(Op.i32_eqz);
        }
        break;
      case '>=':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_ge_s);
        } else {
          // a >= b === !(a < b)
          this.currentBody.call(this._runtimeFuncs.lt);
          this.currentBody.emit(Op.i32_eqz);
        }
        break;
      case '&':  this.currentBody.emit(Op.i32_and); break;
      case '|':  this.currentBody.emit(Op.i32_or); break;
      case '^':  this.currentBody.emit(Op.i32_xor); break;
      case '<<': this.currentBody.emit(Op.i32_shl); break;
      case '>>': this.currentBody.emit(Op.i32_shr_s); break;
      default:
        const _l2 = node?.token?.line ? ` (line ${node.token.line})` : ""; this.errors.push(`unsupported operator: ${node.operator}${_l2}`);
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
    // Check for builtin functions first
    if (node.function instanceof ast.Identifier) {
      const name = node.function.value;

      // Built-in: len(x)
      if (name === 'len' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.len);
        return;
      }

      // Built-in: push(arr, val)
      if (name === 'push' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.push);
        return;
      }

      // Built-in: puts(val) — prints and returns null (0)
      if (name === 'puts' && node.arguments.length >= 1) {
        for (const arg of node.arguments) {
          this.compileNode(arg);
          this.currentBody.call(this._runtimeFuncs.puts);
        }
        this.currentBody.i32Const(0); // puts returns null
        return;
      }

      // Built-in: str(val) — converts to string
      if (name === 'str' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.str);
        return;
      }

      // Built-in: first(arr)
      if (name === 'first' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.i32Const(0);
        this.currentBody.call(this._runtimeFuncs.arrayGet);
        return;
      }

      // Built-in: last(arr)
      if (name === 'last' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        const arrTmp = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localTee(arrTmp);
        this.currentBody.call(this._runtimeFuncs.len);
        this.currentBody.i32Const(1);
        this.currentBody.emit(Op.i32_sub);
        // Now stack has: index. Need arr again.
        const idxTmp = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(idxTmp);
        this.currentBody.localGet(arrTmp);
        this.currentBody.localGet(idxTmp);
        this.currentBody.call(this._runtimeFuncs.arrayGet);
        return;
      }

      // Built-in: rest(arr) — creates new array without first element
      if (name === 'rest' && node.arguments.length === 1) {
        // Import rest from JS host
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.rest);
        return;
      }
    }

    // Find function
    if (node.function instanceof ast.Identifier) {
      const name = node.function.value;
      const binding = this.currentScope.resolve(name);
      if (binding && binding.type === 'func') {
        // Direct function call
        // Compile arguments
        for (const arg of node.arguments) {
          this.compileNode(arg);
        }
        this.currentBody.call(binding.index);
      } else if (binding) {
        // Variable holding a closure — indirect call
        this._emitClosureCall(node, () => this.currentBody.localGet(binding.index));
      } else {
        const _l3 = node?.token?.line ? ` (line ${node.token.line})` : ""; this.errors.push(`unknown function: ${name}${_l3}`);
        this.currentBody.i32Const(0);
      }
    } else {
      // Expression-based call (e.g., immediate function call)
      this._emitClosureCall(node, () => this.compileNode(node.function));
    }
  }

  // Emit a closure call via call_indirect
  _emitClosureCall(node, emitClosure) {
    // Evaluate the closure to get its pointer
    emitClosure();
    const closurePtrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closurePtrLocal);

    // Load env_ptr from closure (offset 8)
    this.currentBody.localGet(closurePtrLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load(); // env_ptr is first arg

    // Compile actual arguments
    for (const arg of node.arguments) {
      this.compileNode(arg);
    }

    // Load table_index from closure (offset 4)
    this.currentBody.localGet(closurePtrLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Load(); // table index on top

    // call_indirect with type signature: (env_ptr, arg0, arg1, ...) -> i32
    const numParams = node.arguments.length + 1; // +1 for env_ptr
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
    this.currentBody.brIf(this.blockDepth - breakDepth); // break if condition is false

    this._compileBlockStatements(node.body);

    this.currentBody.br(this.blockDepth - continueDepth); // continue

    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end(); // end loop
    this.blockDepth--;
    this.currentBody.end(); // end block

    this.currentBody.i32Const(0); // while produces 0
  }

  compileForExpression(node) {
    // Compile init
    if (node.init) {
      if (node.init instanceof ast.LetStatement) {
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

    // Condition
    if (node.condition) {
      this.compileNode(node.condition);
      this.currentBody.emit(Op.i32_eqz);
      this.currentBody.brIf(this.blockDepth - breakDepth);
    }

    // block $continue — continue exits this block, falls through to update
    this.currentBody.block();
    this.blockDepth++;
    const continueDepth = this.blockDepth;

    this.loopStack.push({ breakDepth, continueDepth });

    // Body
    this._compileBlockStatements(node.body);

    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end(); // end $continue block

    // Update (always executes, even after continue)
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
    // for (x in iterable) { body }
    // Compiles to:
    //   let arr = iterable
    //   let __len = len(arr)
    //   let __i = 0
    //   while (__i < __len) {
    //     let x = arr[__i]
    //     body
    //     __i = __i + 1
    //   }

    // Compile iterable
    this.compileNode(node.iterable);
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(arrLocal);

    // len = __len(arr)
    this.currentBody.localGet(arrLocal);
    this.currentBody.call(this._runtimeFuncs.len);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(lenLocal);

    // i = 0
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);

    // Bind loop variable
    const varLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentScope.define(node.variable, varLocal, ValType.i32);

    // block $break
    this.currentBody.block();
    this.blockDepth++;
    const breakDepth = this.blockDepth;
    this.currentBody.loop(); // $loop_start
    this.blockDepth++;
    const loopStartDepth = this.blockDepth;

    // if i >= len, break
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(this.blockDepth - breakDepth);

    // x = arr[i] (or str[i] for string iteration)
    this.currentBody.localGet(arrLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.indexGet);
    this.currentBody.localSet(varLocal);

    // block $continue — continue exits this block, falls through to increment
    this.currentBody.block();
    this.blockDepth++;
    const continueDepth = this.blockDepth;

    this.loopStack.push({ breakDepth, continueDepth });

    // body
    this._compileBlockStatements(node.body);

    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end(); // end $continue block

    // i++ (always executes, even after continue)
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);

    this.currentBody.br(this.blockDepth - loopStartDepth); // loop back to start

    this.blockDepth--;
    this.currentBody.end(); // end loop
    this.blockDepth--;
    this.currentBody.end(); // end block

    this.currentBody.i32Const(0); // for-in produces 0
  }

  compileRangeExpression(node) {
    // start..end → array [start, start+1, ..., end-1]
    // Allocate array with (end - start) elements
    this.compileNode(node.start);
    const startLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(startLocal);

    this.compileNode(node.end);
    const endLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(endLocal);

    // len = end - start
    this.currentBody.localGet(endLocal);
    this.currentBody.localGet(startLocal);
    this.currentBody.emit(Op.i32_sub);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localTee(lenLocal);

    // arr = make_array(len)
    this.currentBody.call(this._runtimeFuncs.makeArray);
    const arrLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(arrLocal);

    // Fill: for i=0; i<len; i++ → arr[i] = start + i
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
    this.currentBody.brIf(this.blockDepth - continueDepth); // continue if true

    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end(); // end loop
    this.blockDepth--;
    this.currentBody.end(); // end block

    this.currentBody.i32Const(0);
  }

  compileAssignExpression(node) {
    const name = node.name.value || node.name;
    
    // Check const enforcement
    if (this._constVars?.has(name)) {
      const line = node?.token?.line ? ` (line ${node.token.line})` : '';
      this.errors.push(`cannot assign to const variable: ${name}${line}`);
      this.currentBody.i32Const(0);
      return;
    }

    const binding = this.currentScope.resolve(name);
    if (binding) {
      this.compileNode(node.value);
      this.currentBody.localTee(binding.index); // assign and leave value on stack
    } else {
      const _l4 = node?.token?.line ? ` (line ${node.token.line})` : ""; this.errors.push(`undefined variable for assignment: ${name}${_l4}`);
      this.currentBody.i32Const(0);
    }
  }

  _compileBlockStatements(block) {
    for (const stmt of block.statements) {
      if (stmt instanceof ast.ExpressionStatement) {
        this.compileNode(stmt.expression);
        this.currentBody.drop();
      } else if (stmt instanceof ast.ReturnStatement) {
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
    
    // String interning: check if this string is already in the pool
    if (this._stringInternPool && this._stringInternPool.has(str)) {
      const offset = this._stringInternPool.get(str);
      this.currentBody.i32Const(offset);
      return;
    }

    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);

    // Allocate in data segment
    const offset = this.nextDataOffset;
    this.nextDataOffset += 8 + bytes.length; // tag + length + bytes
    // Align to 4 bytes
    this.nextDataOffset = (this.nextDataOffset + 3) & ~3;

    this.stringConstants.push({ offset, length: bytes.length, value: str });

    // Register in intern pool
    if (!this._stringInternPool) this._stringInternPool = new Map();
    this._stringInternPool.set(str, offset);

    // Push pointer to the string constant
    this.currentBody.i32Const(offset);
  }

  // Template literal → concatenation of parts
  compileTemplateLiteral(node) {
    if (node.parts.length === 0) {
      // Empty template → empty string
      this.compileStringLiteral({ value: '' });
      return;
    }

    // Compile first part
    const firstPart = node.parts[0];
    if (firstPart instanceof ast.StringLiteral) {
      this.compileStringLiteral(firstPart);
    } else {
      // Expression part — convert to string via str()
      this.compileNode(firstPart);
      this.currentBody.call(this._runtimeFuncs.str);
    }

    // Concatenate remaining parts
    for (let i = 1; i < node.parts.length; i++) {
      const part = node.parts[i];
      if (part instanceof ast.StringLiteral) {
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
    // 1. Analyze free variables (captures from current scope)
    const captures = this._findCaptures(node);

    // 2. Create the WASM function with extra env_ptr as first param
    const params = [ValType.i32, ...node.parameters.map(() => ValType.i32)]; // env_ptr + params
    const results = [ValType.i32]; // all functions return i32

    const { index: wasmFuncIdx, body: funcBody } = this.builder.addFunction(params, results);
    const tableSlot = this.nextTableSlot++;

    // 3. Compile the function body in a new scope
    const prevBody = this.currentBody;
    const prevScope = this.currentScope;
    const prevFunc = this.currentFunc;
    const prevLocalIdx = this.nextLocalIndex;
    const prevParamIdx = this.nextParamIndex;
    const prevTempLocal = this._tempLocal;
    const prevBlockDepth = this.blockDepth;

    this.currentBody = funcBody;
    this.blockDepth = 0;
    this.currentFunc = { name: `closure_${tableSlot}`, index: wasmFuncIdx };
    this.currentScope = new Scope(this.globalScope);
    this.nextParamIndex = 0;
    this.nextLocalIndex = params.length;
    this._tempLocal = null;

    // Bind env_ptr as local 0
    const envPtrLocal = 0;

    // Bind actual parameters (starting at local 1)
    // Infer integer types by scanning the function body
    const intParams = this._inferIntegerParams(node);
    for (let i = 0; i < node.parameters.length; i++) {
      const name = node.parameters[i].value || node.parameters[i].token?.literal;
      const isInt = intParams.has(name);
      this.currentScope.define(name, i + 1, ValType.i32, isInt);
    }

    // Bind captured variables — read them from the environment
    for (let i = 0; i < captures.length; i++) {
      const localIdx = this.nextLocalIndex++;
      funcBody.addLocal(ValType.i32);
      // Load from env: env_ptr + 4 + i*4
      funcBody
        .localGet(envPtrLocal)
        .i32Const(4 + i * 4)
        .emit(Op.i32_add)
        .i32Load()
        .localSet(localIdx);
      this.currentScope.define(captures[i], localIdx, ValType.i32);
    }

    // Compile function body
    this._compileBlockReturning(node.body);

    // Restore state
    this.currentBody = prevBody;
    this.blockDepth = prevBlockDepth;
    this.currentScope = prevScope;
    this.currentFunc = prevFunc;
    this.nextLocalIndex = prevLocalIdx;
    this.nextParamIndex = prevParamIdx;
    this._tempLocal = prevTempLocal;

    // 4. Record for table registration
    this.closureFuncs.push({
      funcLit: node,
      captures,
      tableIndex: tableSlot,
      wasmFuncIndex: wasmFuncIdx,
    });

    // 5. Emit code to create the closure object at runtime
    // Allocate environment: [num_captures:i32][cap0:i32][cap1:i32]...
    const envSize = 4 + captures.length * 4;
    this.currentBody.i32Const(envSize);
    this.currentBody.call(this._runtimeFuncs.alloc);

    const envLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(envLocal);

    // Store num captures
    this.currentBody.localGet(envLocal);
    this.currentBody.i32Const(captures.length);
    this.currentBody.i32Store();

    // Store captured variables
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

    // Allocate closure object: [TAG_CLOSURE:i32][table_index:i32][env_ptr:i32]
    this.currentBody.i32Const(12); // 3 * i32
    this.currentBody.call(this._runtimeFuncs.alloc);

    const closureLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(closureLocal);

    // Store tag
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(TAG_CLOSURE);
    this.currentBody.i32Store();

    // Store table index
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(4);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.i32Const(tableSlot);
    this.currentBody.i32Store();

    // Store env_ptr
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localGet(envLocal);
    this.currentBody.i32Store();

    // Leave closure pointer on stack
    this.currentBody.localGet(closureLocal);
  }

  // Check if a function literal has free variables (references to non-param, non-global names)
  _hasFreeVariables(funcLit, params, topLevelFuncNames = new Set()) {
    let hasFree = false;
    const locals = new Set(params); // Track locally-defined names
    const walk = (node) => {
      if (!node || hasFree) return;
      if (node instanceof ast.FunctionLiteral) return; // Don't walk into nested functions
      // Track let bindings as local
      if (node instanceof ast.LetStatement && node.name) {
        locals.add(node.name.value);
      }
      if (node instanceof ast.Identifier) {
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
      if (node.value && !(node instanceof ast.LetStatement)) walk(node.value);
      if (node instanceof ast.LetStatement && node.value) walk(node.value);
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

  // Find free variables in a function literal
  _findCaptures(funcLit) {
    const params = new Set(funcLit.parameters.map(p => p.value || p.token?.literal));
    const captures = new Set();

    const walk = (node) => {
      if (!node) return;
      if (node instanceof ast.Identifier) {
        const name = node.value;
        if (!params.has(name) && this.currentScope.resolve(name) &&
            this.currentScope.resolve(name).type !== 'func') {
          captures.add(name);
        }
      }
      // Walk children
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
        // Don't walk parameter identifiers — they're definitions not references
      }
    };

    if (funcLit.body && funcLit.body.statements) {
      for (const stmt of funcLit.body.statements) walk(stmt);
    }

    return [...captures];
  }

  // Array literal → heap-allocated array
  compileArrayLiteral(node) {
    const hasSpread = node.elements.some(e => e instanceof ast.SpreadElement);
    
    if (!hasSpread) {
      // Fast path: no spreads, allocate exact size
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
      // Slow path: build with concat for spreads
      // Start with empty array
      this.currentBody.i32Const(0);
      this.currentBody.call(this._runtimeFuncs.makeArray);
      
      let batchStart = -1;
      const arrLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(arrLocal);
      
      for (let i = 0; i < node.elements.length; i++) {
        const elem = node.elements[i];
        if (elem instanceof ast.SpreadElement) {
          // Concat current array with spread array
          this.currentBody.localGet(arrLocal);
          this.compileNode(elem.expression);
          this.currentBody.call(this._runtimeFuncs.arrayConcat);
          this.currentBody.localSet(arrLocal);
        } else {
          // Push single element
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
    // Evaluate subject once, store in temp
    this.compileNode(node.subject);
    const subjectLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(subjectLocal);

    // Compile as nested if-else chain
    // For each arm: if (subject == pattern) { value } else { next arm }
    const arms = node.arms || [];
    
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const isLast = i === arms.length - 1;
      const isWildcard = arm.pattern === null || 
                         (arm.pattern?.constructor?.name === 'Identifier' && arm.pattern.value === '_');

      if (isWildcard) {
        // Wildcard matches everything — just emit the value
        // If pattern has a binding (like n in "n => ..."), bind subject to it
        if (arm.pattern && arm.pattern.constructor?.name === 'Identifier' && arm.pattern.value !== '_') {
          const binding = this.currentScope.define(arm.pattern.value, subjectLocal, 'local');
        }
        this.compileNode(arm.value);
        // Close all remaining if blocks
        break;
      }

      // Compare subject to pattern
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

    // Close all the else branches
    let closingEnds = 0;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const isWildcard = arm.pattern === null || 
                         (arm.pattern?.constructor?.name === 'Identifier' && arm.pattern.value === '_');
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
    // Allocate result array (empty)
    this.currentBody.i32Const(0);
    this.currentBody.call(this._runtimeFuncs.makeArray);
    const resultLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(resultLocal);

    // Compile iterable, store in temp
    this.compileNode(node.iterable);
    const iterLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(iterLocal);

    // Get length
    this.currentBody.localGet(iterLocal);
    this.currentBody.call(this._runtimeFuncs.len);
    const lenLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.localSet(lenLocal);

    // Loop counter
    const iLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    this.currentBody.i32Const(0);
    this.currentBody.localSet(iLocal);

    // Loop variable binding
    const elemLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const varName = node.variable?.value || node.variable;
    this.currentScope.define(varName, elemLocal, 'local');

    // block { loop {
    this.currentBody.block();
    this.blockDepth++;
    this.currentBody.loop();
    this.blockDepth++;

    const loopBreakDepth = this.blockDepth;
    const loopContinueDepth = this.blockDepth;
    this.loopStack.push({ breakDepth: loopBreakDepth - 1, continueDepth: loopContinueDepth });

    // if (i >= len) break
    this.currentBody.localGet(iLocal);
    this.currentBody.localGet(lenLocal);
    this.currentBody.emit(Op.i32_ge_s);
    this.currentBody.brIf(1); // break out of block

    // elem = iterable[i]
    this.currentBody.localGet(iterLocal);
    this.currentBody.localGet(iLocal);
    this.currentBody.call(this._runtimeFuncs.indexGet);
    this.currentBody.localSet(elemLocal);

    if (node.condition) {
      // if (condition) { result = push(result, body) }
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
      this.currentBody.end(); // end if
    } else {
      // result = push(result, body)
      this.compileNode(node.body);
      const bodyVal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(bodyVal);
      this.currentBody.localGet(resultLocal);
      this.currentBody.localGet(bodyVal);
      this.currentBody.call(this._runtimeFuncs.push);
      this.currentBody.localSet(resultLocal);
    }

    // i++
    this.currentBody.localGet(iLocal);
    this.currentBody.i32Const(1);
    this.currentBody.emit(Op.i32_add);
    this.currentBody.localSet(iLocal);

    // br loop
    this.currentBody.br(0);

    this.loopStack.pop();
    this.blockDepth--;
    this.currentBody.end(); // end loop
    this.blockDepth--;
    this.currentBody.end(); // end block

    // Return result array
    this.currentBody.localGet(resultLocal);
  }

  // Try/catch expression — using WASM exception handling proposal
  compileTryExpression(node) {
    // try (result i32)
    this.currentBody.try_(ValType.i32);
    
    // Compile try body
    if (node.tryBlock) {
      this._compileBlockReturning(node.tryBlock);
    } else {
      this.currentBody.i32Const(0);
    }
    
    // catch — handles the exception
    this.currentBody.catch_(this._exceptionTagIdx);
    
    // The caught value (i32) is on the stack
    if (node.catchBlock) {
      // Bind the exception variable if present
      if (node.catchParam) {
        const paramName = node.catchParam.value || node.catchParam;
        const localIdx = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localSet(localIdx);
        this.currentScope.define(paramName, localIdx, 'local');
      } else {
        this.currentBody.drop(); // discard caught value
      }
      this._compileBlockReturning(node.catchBlock);
    }
    // If no catch block, the caught value stays on the stack as the result
    
    // end try
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
    // Dead code after throw, but WASM needs a value for type checking
    this.currentBody.i32Const(0);
  }

  // Class compilation: compiles class as a constructor function
  // that creates an instance hash with fields and method closures
  compileClassStatement(stmt, bindingName) {
    const className = bindingName || stmt.name;
    
    // 1. Compile each method as a WASM function with (self, ...params) -> i32
    const methodEntries = []; // [{name, wasmFuncIdx, tableSlot, paramCount}]
    
    for (const method of stmt.methods) {
      const params = [ValType.i32, ...method.params.map(() => ValType.i32)]; // self + params
      const results = [ValType.i32];
      
      const { index: wasmFuncIdx, body: funcBody } = this.builder.addFunction(params, results);
      const tableSlot = this.nextTableSlot++;
      
      // Save compiler state
      const prevBody = this.currentBody;
      const prevScope = this.currentScope;
      const prevFunc = this.currentFunc;
      const prevLocalIdx = this.nextLocalIndex;
      const prevParamIdx = this.nextParamIndex;
      const prevTempLocal = this._tempLocal;
      const prevBlockDepth = this.blockDepth;
      
      this.currentBody = funcBody;
      this.blockDepth = 0;
      this.currentFunc = { name: `${className}_${method.name}`, index: wasmFuncIdx };
      this.currentScope = new Scope(this.globalScope);
      this.nextParamIndex = 0;
      this.nextLocalIndex = params.length;
      this._tempLocal = null;
      
      // Bind self as local 0 (the first parameter)
      this.currentScope.define('self', 0, ValType.i32);
      
      // Bind method parameters
      for (let i = 0; i < method.params.length; i++) {
        const pname = method.params[i].value || method.params[i];
        this.currentScope.define(pname, i + 1, ValType.i32);
      }
      
      // Compile method body
      this._compileBlockReturning(method.body);
      
      // Restore state
      this.currentBody = prevBody;
      this.blockDepth = prevBlockDepth;
      this.currentScope = prevScope;
      this.currentFunc = prevFunc;
      this.nextLocalIndex = prevLocalIdx;
      this.nextParamIndex = prevParamIdx;
      this._tempLocal = prevTempLocal;
      
      this.closureFuncs.push({
        funcLit: method,
        captures: [],
        tableIndex: tableSlot,
        wasmFuncIndex: wasmFuncIdx,
      });
      
      methodEntries.push({
        name: method.name,
        wasmFuncIdx,
        tableSlot,
        paramCount: method.params.length,
      });
    }
    
    // 2. Handle inheritance: merge parent fields and methods
    let allFields = [...stmt.fields];
    let allMethodEntries = [...methodEntries];
    let parentMethods = [];
    
    if (stmt.superClass) {
      const parentInfo = this._classRegistry.get(stmt.superClass);
      if (parentInfo) {
        // Add parent fields that aren't overridden
        for (const field of parentInfo.fields) {
          if (!allFields.includes(field)) {
            allFields.unshift(field);
          }
        }
        // Add parent methods that aren't overridden by child
        const childMethodNames = new Set(methodEntries.map(m => m.name));
        for (const pm of parentInfo.methods) {
          if (!childMethodNames.has(pm.name)) {
            allMethodEntries.push(pm);
            parentMethods.push(pm);
          }
        }
      }
    }
    
    // 3. Create the constructor function
    // Find init method (child's init takes priority, then parent's)
    let initMethod = allMethodEntries.find(m => m.name === 'init');
    if (!initMethod && stmt.superClass) {
      const parentInfo = this._classRegistry.get(stmt.superClass);
      if (parentInfo && parentInfo.initMethod) {
        initMethod = parentInfo.initMethod;
        allMethodEntries.push(initMethod);
      }
    }
    const initParamCount = initMethod ? initMethod.paramCount : 0;
    
    // Constructor params: same as init params (or empty if no init)
    const ctorParams = Array(initParamCount).fill(ValType.i32);
    const { index: ctorFuncIdx, body: ctorBody } = this.builder.addFunction(ctorParams, [ValType.i32]);
    
    // Save state for constructor compilation
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
    
    // Create instance hash
    this.currentBody.call(this._runtimeFuncs.hashNew);
    const instanceLocal = this.nextLocalIndex++;
    ctorBody.addLocal(ValType.i32);
    this.currentBody.localSet(instanceLocal);
    
    // Initialize fields to 0
    for (const field of allFields) {
      this.currentBody.localGet(instanceLocal);
      this.compileStringLiteral({ value: field });
      this.currentBody.i32Const(0);
      this.currentBody.call(this._runtimeFuncs.hashSet);
      this.currentBody.drop(); // hashSet returns hash id
    }
    
    // Store method closures in the instance hash
    for (const method of allMethodEntries) {
      if (method.name === 'init') continue; // init is called, not stored
      
      // Create closure: [TAG_CLOSURE][tableSlot][env_ptr=instance]
      this.currentBody.i32Const(12);
      this.currentBody.call(this._runtimeFuncs.alloc);
      const closureLocal = this.nextLocalIndex++;
      ctorBody.addLocal(ValType.i32);
      this.currentBody.localSet(closureLocal);
      
      // Tag
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(TAG_CLOSURE);
      this.currentBody.i32Store();
      
      // Table slot
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(4);
      this.currentBody.emit(Op.i32_add);
      this.currentBody.i32Const(method.tableSlot);
      this.currentBody.i32Store();
      
      // Env ptr = instance hash
      this.currentBody.localGet(closureLocal);
      this.currentBody.i32Const(8);
      this.currentBody.emit(Op.i32_add);
      this.currentBody.localGet(instanceLocal);
      this.currentBody.i32Store();
      
      // Store in instance hash
      this.currentBody.localGet(instanceLocal);
      this.compileStringLiteral({ value: method.name });
      this.currentBody.localGet(closureLocal);
      this.currentBody.call(this._runtimeFuncs.hashSet);
      this.currentBody.drop();
    }
    
    // Call init if present
    if (initMethod) {
      // Create init closure with instance as env
      this.currentBody.localGet(instanceLocal); // self (env_ptr)
      // Push constructor args
      for (let i = 0; i < initParamCount; i++) {
        this.currentBody.localGet(i); // constructor param
      }
      // Call init directly via table
      const initParamTypes = [ValType.i32, ...Array(initParamCount).fill(ValType.i32)]; // self + args
      const typeIdx = this.builder.addType(initParamTypes, [ValType.i32]);
      this.currentBody.i32Const(initMethod.tableSlot);
      this.currentBody.callIndirect(typeIdx);
      this.currentBody.drop(); // discard init return value
    }
    
    // Return instance
    this.currentBody.localGet(instanceLocal);
    
    // Restore state
    this.currentBody = prevBody;
    this.blockDepth = prevBlockDepth;
    this.currentScope = prevScope;
    this.currentFunc = prevFunc;
    this.nextLocalIndex = prevLocalIdx;
    this._tempLocal = prevTempLocal;
    
    // 4. Bind class name to the constructor function
    this.currentScope.define(className, ctorFuncIdx, 'func');
    
    // 5. Register class for inheritance
    this._classRegistry.set(className, {
      fields: allFields,
      methods: allMethodEntries.filter(m => m.name !== 'init'),
      initMethod,
      ctorFuncIdx,
    });
  }

  // Hash literal: {"key": value, ...}
  compileHashLiteral(node) {
    // Check if all keys are integer-like (no string keys)
    let allIntKeys = true;
    if (node.pairs) {
      for (const [key] of node.pairs) {
        if (key instanceof ast.StringLiteral) {
          allIntKeys = false;
          break;
        }
      }
    }

    if (allIntKeys && node.pairs && node.pairs.size > 0) {
      // Native WASM hash map (integer keys only) 
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
    } else {
      // JS-hosted hash map (handles string keys correctly)
      this.currentBody.call(this._runtimeFuncs.hashNew);
      const hashLocal = this.nextLocalIndex++;
      this.currentBody.addLocal(ValType.i32);
      this.currentBody.localSet(hashLocal);

      if (node.pairs) {
        for (const [key, value] of node.pairs) {
          this.currentBody.localGet(hashLocal);
          this.compileNode(key);
          this.compileNode(value);
          this.currentBody.call(this._runtimeFuncs.hashSet);
          this.currentBody.drop();
        }
      }
      this.currentBody.localGet(hashLocal);
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
    return nodes.some(n => this._nodeIsString(n));
  }

  _nodeIsString(node) {
    if (node instanceof ast.StringLiteral) return true;
    // str() call returns a string
    if (node instanceof ast.CallExpression &&
        node.function instanceof ast.Identifier &&
        node.function.value === 'str') return true;
    // String concatenation (recursive)
    if (node instanceof ast.InfixExpression &&
        node.operator === '+' &&
        this._isStringExpression(node.left, node.right)) return true;
    return false;
  }

  // Scan a function body to infer which parameters are used as integers
  _inferIntegerParams(funcNode) {
    const intParams = new Set();
    const paramNames = new Set(funcNode.parameters.map(p => p.value || p.token?.literal));
    
    const scan = (node) => {
      if (!node) return;
      // Pattern: param op literal (arithmetic or comparison)
      if (node instanceof ast.InfixExpression) {
        const ops = ['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '!=', '&', '|', '^'];
        if (ops.includes(node.operator)) {
          if (node.left instanceof ast.Identifier && paramNames.has(node.left.value)) {
            intParams.add(node.left.value);
          }
          if (node.right instanceof ast.Identifier && paramNames.has(node.right.value)) {
            intParams.add(node.right.value);
          }
        }
        scan(node.left);
        scan(node.right);
      }
      // Pattern: -param or !param
      if (node instanceof ast.PrefixExpression) {
        if (node.right instanceof ast.Identifier && paramNames.has(node.right.value)) {
          intParams.add(node.right.value);
        }
        scan(node.right);
      }
      // Recurse into common structures
      if (node instanceof ast.IfExpression) {
        scan(node.condition);
        if (node.consequence) node.consequence.statements?.forEach(scan);
        if (node.alternative) node.alternative.statements?.forEach(scan);
      }
      if (node instanceof ast.BlockStatement) node.statements?.forEach(scan);
      if (node instanceof ast.ExpressionStatement) scan(node.expression);
      if (node instanceof ast.ReturnStatement) scan(node.returnValue);
      if (node instanceof ast.LetStatement) scan(node.value);
      if (node instanceof ast.CallExpression) {
        node.arguments?.forEach(scan);
        scan(node.function);
      }
    };
    
    if (funcNode.body?.statements) {
      funcNode.body.statements.forEach(scan);
    }
    
    return intParams;
  }

  _isDefinitelyInteger(node) {
    if (node instanceof ast.IntegerLiteral) return true;
    if (node instanceof ast.BooleanLiteral) return true;
    if (node instanceof ast.Identifier) {
      // Check if the variable is known to be an integer from its binding
      const binding = this.currentScope?.resolve(node.value);
      if (binding && binding.knownInt) return true;
      return false;
    }
    if (node instanceof ast.InfixExpression) {
      const op = node.operator;
      if (['-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>='].includes(op)) return true;
      if (op === '+' && this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) return true;
    }
    if (node instanceof ast.PrefixExpression) return true;
    return false;
  }

  _mightBeString(node) {
    // Returns true if the node might produce a string at runtime
    if (node instanceof ast.StringLiteral) return true;
    if (node instanceof ast.TemplateLiteral) return true;
    if (node instanceof ast.CallExpression) {
      if (node.function instanceof ast.Identifier && node.function.value === 'str') return true;
    }
    // Array/hash index could return a string
    if (node instanceof ast.IndexExpression) return true;
    // String concat
    if (node instanceof ast.InfixExpression && node.operator === '+' &&
        (this._mightBeString(node.left) || this._mightBeString(node.right))) return true;
    // CallExpression with unknown return type
    if (node instanceof ast.CallExpression && 
        !(node.function instanceof ast.Identifier && ['len', 'first', 'last', 'type', 'int'].includes(node.function.value))) {
      // Most function calls could potentially return strings
      return false; // Conservative: assume functions return integers unless we know otherwise
    }
    return false;
  }

  // Constant folding: try to evaluate an expression at compile time
  _tryConstantFold(node) {
    if (!(node instanceof ast.InfixExpression)) return null;

    const left = this._getConstValue(node.left);
    const right = this._getConstValue(node.right);
    if (left === null || right === null) return null;

    switch (node.operator) {
      case '+':  return (left + right) | 0;
      case '-':  return (left - right) | 0;
      case '*':  return Math.imul(left, right);
      case '/':  return right !== 0 ? (left / right) | 0 : null;
      case '%':  return right !== 0 ? (left % right) | 0 : null;
      case '==': return left === right ? 1 : 0;
      case '!=': return left !== right ? 1 : 0;
      case '<':  return left < right ? 1 : 0;
      case '>':  return left > right ? 1 : 0;
      case '<=': return left <= right ? 1 : 0;
      case '>=': return left >= right ? 1 : 0;
      case '&':  return left & right;
      case '|':  return left | right;
      case '^':  return left ^ right;
      case '<<': return left << right;
      case '>>': return left >> right;
      default: return null;
    }
  }

  _getConstValue(node) {
    if (node instanceof ast.IntegerLiteral) return node.value;
    if (node instanceof ast.BooleanLiteral) return node.value ? 1 : 0;
    if (node instanceof ast.InfixExpression) return this._tryConstantFold(node);
    if (node instanceof ast.PrefixExpression && node.operator === '-') {
      const val = this._getConstValue(node.right);
      return val !== null ? -val : null;
    }
    if (node instanceof ast.PrefixExpression && node.operator === '!') {
      const val = this._getConstValue(node.right);
      return val !== null ? (val === 0 ? 1 : 0) : null;
    }
    return null;
  }
}

// === Prefix negation fix ===
// Override compilePrefixExpression to handle negation correctly
const origPrefix = WasmCompiler.prototype.compilePrefixExpression;
WasmCompiler.prototype.compilePrefixExpression = function(node) {
  if (node.operator === '-') {
    this.currentBody.i32Const(0);
    this.compileNode(node.right);
    this.currentBody.emit(Op.i32_sub);
    return;
  }
  if (node.operator === '!') {
    this.compileNode(node.right);
    this.currentBody.emit(Op.i32_eqz);
    return;
  }
  this.compileNode(node.right);
};

// === High-level API ===

// Create default JS host imports for WASM modules
function createWasmImports(outputLines = [], memoryRef = { memory: null }) {
  // Hash map storage (JS-side, indexed by unique IDs)
  const hashMaps = new Map();
  let nextHashId = 1;
  // Helper to read string from WASM memory
  function readString(ptr) {
    const mem = memoryRef.memory;
    if (!mem || ptr <= 0) return '';
    const view = new DataView(mem.buffer);
    const tag = view.getInt32(ptr, true);
    if (tag !== TAG_STRING) return String(ptr);
    const len = view.getInt32(ptr + 4, true);
    const bytes = new Uint8Array(mem.buffer, ptr + 8, len);
    return new TextDecoder().decode(bytes);
  }

  // Helper to write string into WASM memory (bump allocator via global[0])
  function writeString(str) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const view = new DataView(mem.buffer);

    // Read heap pointer from global — we need to bump-allocate
    // The heap pointer is stored as a WASM global, but we can't read it from JS.
    // Instead, we'll track our own allocation offset.
    if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 100000; // start high to avoid collisions
    const ptr = memoryRef.jsHeapPtr;
    memoryRef.jsHeapPtr += 8 + bytes.length;
    // Align to 4 bytes
    memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;

    // Write: [TAG_STRING:i32][length:i32][bytes...]
    view.setInt32(ptr, TAG_STRING, true);
    view.setInt32(ptr + 4, bytes.length, true);
    new Uint8Array(mem.buffer).set(bytes, ptr + 8);

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
        // Convert value to string representation and store in WASM memory
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
      __add(a, b) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          // Validate pointer: must be >= 16, 4-byte aligned, in bounds, and have a valid tag+length
          const isStrPtr = (v) => {
            if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
            const tag = view.getInt32(v, true);
            if (tag !== TAG_STRING) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
          };
          try {
            if (isStrPtr(a) || isStrPtr(b)) {
              if (isStrPtr(a) || isStrPtr(b)) {
              const sA = isStrPtr(a) ? readString(a) : String(a);
              const sB = isStrPtr(b) ? readString(b) : String(b);
                return writeString(sA + sB);
              }
            }
          } catch (e) {}
        }
        return a + b;
      },
      __eq(a, b) {
        if (a === b) return 1;
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const isStrPtr = (v) => {
            if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
            const tag = view.getInt32(v, true);
            if (tag !== TAG_STRING) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
          };
          try {
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) === readString(b) ? 1 : 0;
            }
          } catch (e) {}
        }
        return a === b ? 1 : 0;
      },
      __lt(a, b) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const isStrPtr = (v) => {
            if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
            const tag = view.getInt32(v, true);
            if (tag !== TAG_STRING) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
          };
          try {
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) < readString(b) ? 1 : 0;
            }
          } catch (e) {}
        }
        return a < b ? 1 : 0;
      },
      __gt(a, b) {
        const mem = memoryRef.memory;
        if (mem) {
          const view = new DataView(mem.buffer);
          const isStrPtr = (v) => {
            if (v < 16 || (v & 3) !== 0 || v + 8 > view.byteLength) return false;
            const tag = view.getInt32(v, true);
            if (tag !== TAG_STRING) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
          };
          try {
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) > readString(b) ? 1 : 0;
            }
          } catch (e) {}
        }
        return a > b ? 1 : 0;
      },
      __array_concat(arrA, arrB) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        
        const lenA = (arrA > 0 && view.getInt32(arrA, true) === TAG_ARRAY) ? view.getInt32(arrA + 4, true) : 0;
        const lenB = (arrB > 0 && view.getInt32(arrB, true) === TAG_ARRAY) ? view.getInt32(arrB + 4, true) : 0;
        const newLen = lenA + lenB;
        
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 100000;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += 8 + newLen * 4;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;
        
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < lenA; i++) {
          view.setInt32(newPtr + 8 + i * 4, view.getInt32(arrA + 8 + i * 4, true), true);
        }
        for (let i = 0; i < lenB; i++) {
          view.setInt32(newPtr + 8 + (lenA + i) * 4, view.getInt32(arrB + 8 + i * 4, true), true);
        }
        return newPtr;
      },
      __rest(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (len <= 0) return 0;

        // Allocate new array with len-1 elements
        const newLen = len - 1;
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 100000;
        const newPtr = memoryRef.jsHeapPtr;
        const newSize = 8 + newLen * 4;
        memoryRef.jsHeapPtr += newSize;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;

        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + 8 + (i + 1) * 4, true);
          view.setInt32(newPtr + 8 + i * 4, elem, true);
        }
        return newPtr;
      },
      __type(value) {
        const mem = memoryRef.memory;
        if (!mem) return writeString('unknown');
        const view = new DataView(mem.buffer);
        if (value >= 16 && (value & 3) === 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true);
            const len = view.getInt32(value + 4, true);
            if (tag === TAG_STRING && len >= 0 && len < 1000000) return writeString('STRING');
            if (tag === TAG_ARRAY && len >= 0 && len < 1000000) return writeString('ARRAY');
            if (tag === TAG_CLOSURE) return writeString('FUNCTION');
          } catch (e) {}
        }
        return writeString('INTEGER');
      },
      __int(value) {
        const mem = memoryRef.memory;
        if (!mem) return value;
        const view = new DataView(mem.buffer);
        if (value > 0 && value + 8 <= view.byteLength) {
          try {
            const tag = view.getInt32(value, true);
            if (tag === TAG_STRING) {
              const str = readString(value);
              return parseInt(str, 10) || 0;
            }
          } catch (e) {}
        }
        return value;
      },
      __slice(arrPtr, start, end) {
        const mem = memoryRef.memory;
        if (!mem || arrPtr <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (end <= 0) end = len; // default to full length
        if (start < 0) start = 0;
        if (end > len) end = len;
        const newLen = Math.max(0, end - start);

        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 100000;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += 8 + newLen * 4;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;

        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + 8 + (start + i) * 4, true);
          view.setInt32(newPtr + 8 + i * 4, elem, true);
        }
        return newPtr;
      },
      __hash_new() {
        const id = nextHashId++;
        hashMaps.set(id, new Map());
        return id;
      },
      __hash_set(hashId, key, value) {
        const map = hashMaps.get(hashId);
        if (!map) return hashId;
        // Use key as-is (integer keys) or resolve string keys
        const mem = memoryRef.memory;
        let resolvedKey = key;
        if (mem && key > 0) {
          const view = new DataView(mem.buffer);
          try {
            const tag = view.getInt32(key, true);
            if (tag === TAG_STRING) {
              resolvedKey = 's:' + readString(key);
            }
          } catch (e) {}
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
            if (tag === TAG_STRING) {
              resolvedKey = 's:' + readString(key);
            }
          } catch (e) {}
        }
        return map.get(resolvedKey) || 0;
      },
      __index_get(obj, key) {
        // Dispatch based on object type in linear memory
        if (hashMaps.has(obj)) {
          // Legacy JS-hosted hash map (backward compat)
          const map = hashMaps.get(obj);
          const mem = memoryRef.memory;
          let resolvedKey = key;
          if (mem && key > 0) {
            const view = new DataView(mem.buffer);
            try {
              const tag = view.getInt32(key, true);
              if (tag === TAG_STRING) {
                resolvedKey = 's:' + readString(key);
              }
            } catch (e) {}
          }
          return map.get(resolvedKey) || 0;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return 0;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true);

        // Native hash map (TAG_HASH = 4): linear probe lookup
        if (tag === TAG_HASH) {
          const capacity = view.getInt32(obj + 4, true);
          const entriesPtr = view.getInt32(obj + 12, true);
          const mask = capacity - 1;
          // Hash the key (same golden ratio as WASM-side __hash_fnv)
          let hash = Math.imul(key, 0x9e3779b9) ^ (key >>> 16);
          let idx = (hash & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0) return 0; // empty — not found
            if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
              return view.getInt32(entryAddr + 8, true); // found!
            }
            idx = (idx + 1) & mask;
          }
          return 0;
        }

        if (tag === TAG_STRING) {
          const str = readString(obj);
          if (key < 0 || key >= str.length) return 0;
          return writeString(str[key]);
        }
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return 0;
        return view.getInt32(obj + 8 + key * 4, true);
      },
      __index_set(obj, key, value) {
        // Dispatch based on object type
        if (hashMaps.has(obj)) {
          // Legacy JS-hosted hash map
          const map = hashMaps.get(obj);
          const mem = memoryRef.memory;
          let resolvedKey = key;
          if (mem && key > 0) {
            const view = new DataView(mem.buffer);
            try {
              const tag = view.getInt32(key, true);
              if (tag === TAG_STRING) {
                resolvedKey = 's:' + readString(key);
              }
            } catch (e) {}
          }
          map.set(resolvedKey, value);
          return;
        }
        const mem = memoryRef.memory;
        if (!mem || obj <= 0) return;
        const view = new DataView(mem.buffer);
        const tag = view.getInt32(obj, true);

        // Native hash map set
        if (tag === TAG_HASH) {
          const capacity = view.getInt32(obj + 4, true);
          const entriesPtr = view.getInt32(obj + 12, true);
          const mask = capacity - 1;
          let hash = Math.imul(key, 0x9e3779b9) ^ (key >>> 16);
          let idx = (hash & mask) >>> 0;
          for (let probe = 0; probe < capacity; probe++) {
            const entryAddr = entriesPtr + idx * 12;
            const status = view.getInt32(entryAddr, true);
            if (status === 0 || status === 2) {
              // Empty or deleted — insert
              view.setInt32(entryAddr, 1, true);     // occupied
              view.setInt32(entryAddr + 4, key, true);
              view.setInt32(entryAddr + 8, value, true);
              if (status !== 1) {
                // Increment size
                view.setInt32(obj + 8, view.getInt32(obj + 8, true) + 1, true);
              }
              return;
            }
            if (status === 1 && view.getInt32(entryAddr + 4, true) === key) {
              // Overwrite existing
              view.setInt32(entryAddr + 8, value, true);
              return;
            }
            idx = (idx + 1) & mask;
          }
          return;
        }

        if (tag !== TAG_ARRAY) return;
        const len = view.getInt32(obj + 4, true);
        if (key < 0 || key >= len) return;
        view.setInt32(obj + 8 + key * 4, value, true);
      },
      // GC stubs (no-op in non-GC mode)
      __gc_alloc(size) { return 0; },
      __gc_collect() { return 0; },
      __gc_register(ptr, size) {},
      __gc_add_root(ptr) {},
      __gc_remove_root(ptr) {},
    },
  };
}

// Format a WASM i32 value as a human-readable string
export function formatWasmValue(value, dataView) {
  // Check if it's a pointer to a heap object
  if (value > 0 && dataView && value + 8 <= dataView.byteLength) {
    try {
      const tag = dataView.getInt32(value, true);
      if (tag === TAG_STRING) {
        const len = dataView.getInt32(value + 4, true);
        if (len >= 0 && len < 100000 && value + 8 + len <= dataView.byteLength) {
          const bytes = new Uint8Array(dataView.buffer, value + 8, len);
          return new TextDecoder().decode(bytes);
        }
      }
      if (tag === TAG_ARRAY) {
        const len = dataView.getInt32(value + 4, true);
        if (len >= 0 && len < 100000) {
          const elems = [];
          for (let i = 0; i < len; i++) {
            const elem = dataView.getInt32(value + 8 + i * 4, true);
            elems.push(formatWasmValue(elem, dataView));
          }
          return '[' + elems.join(', ') + ']';
        }
      }
    } catch (e) {
      // Not a valid pointer, treat as integer
    }
  }
  return String(value);
}

export async function compileAndRun(input, options = {}) {
  const timings = {};
  const t0 = performance.now();

  const compiler = new WasmCompiler();
  
  // Run optimization pipeline if enabled
  if (options.optimize) {
    const lexer = new Lexer(input);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    
    if (parser.errors.length > 0) {
      throw new Error(`Parse errors: ${parser.errors.join(', ')}`);
    }
    
    const tOpt = performance.now();
    // 1. Constant folding
    constantFold(program);
    // 2. Dead code elimination
    eliminateDeadCode(program);
    // 3. Type inference (for warnings and future optimizations)
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
    
    // Compile the optimized AST
    const builder = compiler.compileProgram(program);
    timings.compile = performance.now() - t0;
    
    if (!builder || compiler.errors.length > 0) {
      throw new Error(`Compilation errors: ${compiler.errors.join(', ')}`);
    }
  } else {
    // Standard path: compile from source
    compiler.compile(input);
    timings.compile = performance.now() - t0;
    
    if (compiler.errors.length > 0) {
      throw new Error(`Compilation errors: ${compiler.errors.join(', ')}`);
    }
  }

  if (options.warnings && compiler.warnings.length > 0) {
    options.warnings.push(...compiler.warnings);
  }

  const t1 = performance.now();
  const binary = compiler.builder.build();
  timings.encode = performance.now() - t1;

  const t2 = performance.now();
  const module = await WebAssembly.compile(binary);
  timings.wasmCompile = performance.now() - t2;

  const outputLines = options.outputLines || [];
  const memoryRef = { memory: null };

  let imports;
  let gc = null;
  if (options.gc) {
    gc = new WasmGC(memoryRef, typeof options.gc === 'object' ? options.gc : {});
    imports = createGCImports(gc, outputLines, memoryRef);
  } else {
    imports = createWasmImports(outputLines, memoryRef);
  }

  const t3 = performance.now();
  const instance = await WebAssembly.instantiate(module, imports);
  memoryRef.memory = instance.exports.memory;
  timings.instantiate = performance.now() - t3;

  const t4 = performance.now();
  const result = instance.exports.main();
  timings.execute = performance.now() - t4;
  timings.total = performance.now() - t0;

  if (options.timings) Object.assign(options.timings, timings);
  if (options.instance) options.instance.ref = instance;
  if (options.gcStats && gc) options.gcStats.ref = gc.getStats();

  return result;
}

export async function compileToInstance(input, options = {}) {
  const compiler = new WasmCompiler();
  const builder = compiler.compile(input);

  if (!builder || compiler.errors.length > 0) {
    throw new Error(`Compilation errors: ${compiler.errors.join(', ')}`);
  }

  const binary = builder.build();
  const module = await WebAssembly.compile(binary);

  const outputLines = options.outputLines || [];
  const memoryRef = { memory: null };
  const imports = createWasmImports(outputLines, memoryRef);

  const instance = await WebAssembly.instantiate(module, imports);
  memoryRef.memory = instance.exports.memory;

  return instance;
}

// Pre-compile a WASM module, returning a fast run function
// Usage: const run = await precompile(source); const result = await run();
export async function precompile(input) {
  const compiler = new WasmCompiler();
  compiler.compile(input);

  if (compiler.errors.length > 0) {
    throw new Error(`Compilation errors: ${compiler.errors.join(', ')}`);
  }

  const binary = compiler.builder.build();
  const module = await WebAssembly.compile(binary);

  // Return a fast run function that only instantiates + executes
  return async function run() {
    const outputLines = [];
    const memoryRef = { memory: null };
    const imports = createWasmImports(outputLines, memoryRef);
    const instance = await WebAssembly.instantiate(module, imports);
    memoryRef.memory = instance.exports.memory;
    return instance.exports.main();
  };
}
