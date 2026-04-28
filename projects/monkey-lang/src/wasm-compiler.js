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
//   Arrays: pointer to heap object [TAG_ARRAY:i32][length:i32][capacity:i32][elem0:i32][elem1:i32]...
//   Null: 0
//
// Heap object tags:
const TAG_STRING = 1;
const TAG_ARRAY = 2;
const ARRAY_HEADER = 12; // TAG(4) + length(4) + capacity(4)
const TAG_CLOSURE = 3;
const TAG_HASH = 4;
const TAG_FLOAT = 5;

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

  // Mark a variable as captured from a closure environment (needs write-back on mutation)
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
    this._currentClassName = null; // set during class method compilation

    // Box/cell tracking for mutable closure captures
    this._boxedVars = new Map(); // scopeId → Set<varName> — filled by _analyzeBoxedVariables
    this._scopeIdStack = ['top']; // tracks current scope ID for box lookups
    this._boxedLocals = new Map(); // varName → localIdx of box pointer (per current scope)

    // Compilation statistics
    this.stats = {
      constantsFolded: 0,
      functionsCompiled: 0,
      closuresCreated: 0,
      stringsAllocated: 0,
      arraysAllocated: 0,
      directArith: 0,     // direct i32 arithmetic (fast path)
      hostArith: 0,       // host import arithmetic (slow path)
      directCalls: 0,     // direct function calls
      indirectCalls: 0,   // call_indirect via table
      knownIntVars: 0,    // variables with knownInt flag
    };

    // Add 1 page of memory for strings/arrays
    this.builder.addMemory(64, 256); // 64 pages initial (4MB), max 256 pages (16MB)
    
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

    // Pass 0: Analyze which variables need boxing (heap-allocated cells)
    // A variable needs boxing if it is:
    //   (a) captured by a closure AND mutated (by closure or enclosing scope)
    //   (b) captured by multiple closures (shared state)
    //   (c) a self-referencing closure (let f = fn() { f(...) } where f captures itself)
    this._boxedVars = this._analyzeBoxedVariables(program);

    // First pass: collect top-level function names to know what's global
    const topLevelFuncNames = new Set();
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement &&
          (stmt.value instanceof ast.FunctionLiteral)) {
        topLevelFuncNames.add(stmt.name.value);
      }
    }

    // Second pass: register non-capturing functions
    // Skip functions that need boxing — they must go through the closure path
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement &&
          (stmt.value instanceof ast.FunctionLiteral)) {
        // Don't register as direct function if it needs boxing
        const topBoxed = this._boxedVars.get('top');
        if (topBoxed && topBoxed.has(stmt.name.value)) {
          continue; // will be compiled as a boxed closure via compileLetStatement
        }
        const params = new Set(stmt.value.parameters.map(p => p.value || p.token?.literal));
        const hasFreeVars = this._hasFreeVariables(stmt.value, params, topLevelFuncNames, stmt.name.value);
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

    // Infer return types BEFORE compiling main body,
    // so returnsInt/returnsIntClosure are available during main body compilation
    this._inferReturnTypes();

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
    // (Return types already inferred before main body compilation)
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
      const tableIdx = this.builder.addTable(ValType.funcref, tableSize, tableSize);
      // Map function indices by their assigned table slot, not insertion order
      const funcIndices = new Array(tableSize);
      for (const cf of this.closureFuncs) {
        funcIndices[cf.tableIndex] = cf.wasmFuncIndex;
      }
      this.builder.addElement(0, 0, funcIndices);
      // Export the table so host imports (map/filter/reduce) can call closures
      this.builder.addExport('__indirect_function_table', ExportKind.Table, tableIdx);
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

    // String method host imports
    const strSplitIdx = this.builder.addImport('env', '__str_split', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strSplit = strSplitIdx;

    const strTrimIdx = this.builder.addImport('env', '__str_trim', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strTrim = strTrimIdx;

    const strReplaceIdx = this.builder.addImport('env', '__str_replace', [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strReplace = strReplaceIdx;

    const strIndexOfIdx = this.builder.addImport('env', '__str_indexOf', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strIndexOf = strIndexOfIdx;

    const strStartsWithIdx = this.builder.addImport('env', '__str_startsWith', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strStartsWith = strStartsWithIdx;

    const strEndsWithIdx = this.builder.addImport('env', '__str_endsWith', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strEndsWith = strEndsWithIdx;

    const strUpperIdx = this.builder.addImport('env', '__str_toUpper', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strUpper = strUpperIdx;

    const strLowerIdx = this.builder.addImport('env', '__str_toLower', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strLower = strLowerIdx;

    const strSubstringIdx = this.builder.addImport('env', '__str_substring', [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.strSubstring = strSubstringIdx;

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

    // Utility builtins
    const absIdx = this.builder.addImport('env', '__abs', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.abs = absIdx;
    this.globalScope.define('abs', absIdx, 'func');

    const maxIdx = this.builder.addImport('env', '__max', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.max = maxIdx;

    const minIdx = this.builder.addImport('env', '__min', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.min = minIdx;

    const rangeIdx = this.builder.addImport('env', '__range', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.range = rangeIdx;

    const joinIdx = this.builder.addImport('env', '__join', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.join = joinIdx;

    const keysIdx = this.builder.addImport('env', '__keys', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.keys = keysIdx;

    const valuesIdx = this.builder.addImport('env', '__values', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.values = valuesIdx;

    const containsIdx = this.builder.addImport('env', '__contains', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.contains = containsIdx;

    const reverseIdx = this.builder.addImport('env', '__reverse', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.reverse = reverseIdx;

    // Higher-order function imports: map/filter/reduce/find/any/every
    // These take (arr_ptr, closure_ptr) and call back into WASM via exported table
    const mapIdx = this.builder.addImport('env', '__map', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.map = mapIdx;

    const filterIdx = this.builder.addImport('env', '__filter', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.filter = filterIdx;

    // __reduce(arr_ptr, closure_ptr, initial_value) → i32
    const reduceIdx = this.builder.addImport('env', '__reduce', [ValType.i32, ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.reduce = reduceIdx;

    const findIdx = this.builder.addImport('env', '__find', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.find = findIdx;

    const anyIdx = this.builder.addImport('env', '__any', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.any = anyIdx;

    const everyIdx = this.builder.addImport('env', '__every', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.every = everyIdx;

    // sort(arr) or sort(arr, cmpFn) — sort takes optional comparator closure
    const sortIdx = this.builder.addImport('env', '__sort', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.sort = sortIdx;

    // forEach(arr, fn) — call fn for each element, returns 0 (null)
    const forEachIdx = this.builder.addImport('env', '__forEach', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.forEach = forEachIdx;

    // flatMap(arr, fn) — map + flatten one level
    const flatMapIdx = this.builder.addImport('env', '__flatMap', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.flatMap = flatMapIdx;

    // zip(arr1, arr2) — pair elements from two arrays
    const zipIdx = this.builder.addImport('env', '__zip', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.zip = zipIdx;

    // enumerate(arr) — pair each element with its index
    const enumerateIdx = this.builder.addImport('env', '__enumerate', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.enumerate = enumerateIdx;

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

    // Float support: create float from two i32 halves (lo, hi of f64 bits)
    const floatNewIdx = this.builder.addImport('env', '__float_new', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.floatNew = floatNewIdx;

    // Arithmetic host imports for mixed int/float
    const subIdx = this.builder.addImport('env', '__sub', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.sub = subIdx;

    const mulIdx = this.builder.addImport('env', '__mul', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.mul = mulIdx;

    const divIdx = this.builder.addImport('env', '__div', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.div = divIdx;

    const modIdx = this.builder.addImport('env', '__mod', [ValType.i32, ValType.i32], [ValType.i32]);
    this._runtimeFuncs.mod = modIdx;

    const negIdx = this.builder.addImport('env', '__neg', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.neg = negIdx;

    // Float conversion: __to_float(i32) → float_ptr
    const toFloatIdx = this.builder.addImport('env', '__to_float', [ValType.i32], [ValType.i32]);
    this._runtimeFuncs.toFloat = toFloatIdx;

    // __alloc(size) → pointer — bump allocator with memory growth
    const { index: allocIdx, body: allocBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    allocBody.addLocal(ValType.i32); // local[1] = ptr
    allocBody.addLocal(ValType.i32); // local[2] = new_heap_ptr
    allocBody
      .globalGet(this.heapPtr) // ptr = heap_ptr
      .localTee(1)
      .localGet(0)             // size
      .emit(Op.i32_add)        // new_heap_ptr = heap_ptr + size
      .localTee(2);
    // Check if we need to grow memory
    allocBody
      .emit(Op.memory_size, 0x00)  // memory_size in pages (memory 0)
      .i32Const(16)
      .emit(Op.i32_shl)            // current_mem_bytes = pages * 65536
      .emit(Op.i32_gt_u);          // new_heap_ptr > current_mem_bytes?
    allocBody.if_();                // if need growth
    // Grow by needed pages + 16 extra pages for headroom
    allocBody
      .localGet(2)                  // new_heap_ptr
      .emit(Op.memory_size, 0x00)
      .i32Const(16)
      .emit(Op.i32_shl)
      .emit(Op.i32_sub)            // bytes_over = new_heap_ptr - current_bytes
      .i32Const(16)
      .emit(Op.i32_shr_u)          // pages_over = bytes_over / 65536
      .i32Const(17)                 // + 16 + 1 for headroom
      .emit(Op.i32_add)
      .emit(Op.memory_grow, 0x00)  // grow by pages_over + 17
      .emit(Op.drop);              // drop result
    allocBody.end();                // end if

    allocBody
      .localGet(2)
      .globalSet(this.heapPtr)      // heap_ptr = new_heap_ptr
      .localGet(1)                  // ptr
      .localGet(0)                  // size
      .call(gcRegisterIdx);         // __gc_register(ptr, size)
    allocBody.localGet(1);          // return old heap_ptr
    this._runtimeFuncs.alloc = allocIdx;
    this.builder.addExport('__alloc', ExportKind.Func, allocIdx);

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
      .i32Const(ARRAY_HEADER)
      .emit(Op.i32_add)      // skip tag + length + capacity
      .localGet(1)           // index
      .i32Const(4)
      .emit(Op.i32_mul)      // index * 4
      .emit(Op.i32_add)      // arr_ptr + ARRAY_HEADER + index*4
      .i32Load();            // load element
    this._runtimeFuncs.arrayGet = arrGetIdx;

    // __array_set(arr_ptr, index, value) → void
    const { index: arrSetIdx, body: arrSetBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32, ValType.i32], []
    );
    arrSetBody
      .localGet(0)           // arr_ptr
      .i32Const(ARRAY_HEADER)
      .emit(Op.i32_add)
      .localGet(1)           // index
      .i32Const(4)
      .emit(Op.i32_mul)
      .emit(Op.i32_add)      // addr = arr_ptr + ARRAY_HEADER + index*4
      .localGet(2)           // value
      .i32Store();           // store value
    this._runtimeFuncs.arraySet = arrSetIdx;

    // __make_array(length) → ptr — allocate an array with given length, capacity = max(length, 4)
    const { index: makeArrIdx, body: makeArrBody } = this.builder.addFunction(
      [ValType.i32], [ValType.i32]
    );
    makeArrBody.addLocal(ValType.i32); // local[1] = ptr
    makeArrBody.addLocal(ValType.i32); // local[2] = capacity
    makeArrBody
      // capacity = max(length, 4)
      .localGet(0).localSet(2) // capacity = length
      .localGet(2).i32Const(4).emit(Op.i32_lt_s)
      .if_(ValType.void)
        .i32Const(4).localSet(2) // capacity = 4 if length < 4
      .end()
      // Allocate: ARRAY_HEADER + capacity*4 bytes
      .localGet(2).i32Const(4).emit(Op.i32_mul).i32Const(ARRAY_HEADER).emit(Op.i32_add)
      .call(allocIdx)
      .localTee(1)
      // Store tag
      .i32Const(TAG_ARRAY)
      .i32Store()
      // Store length
      .localGet(1).i32Const(4).emit(Op.i32_add)
      .localGet(0)
      .i32Store()
      // Store capacity
      .localGet(1).i32Const(8).emit(Op.i32_add)
      .localGet(2)
      .i32Store();
    makeArrBody.localGet(1); // return ptr
    this._runtimeFuncs.makeArray = makeArrIdx;

    // __push(arr_ptr, value) → arr_ptr — append element to array
    // If capacity > length: in-place O(1) append (returns same pointer)
    // If capacity == length: allocate new array with 2x capacity, copy, append
    const { index: pushIdx, body: pushBody } = this.builder.addFunction(
      [ValType.i32, ValType.i32], [ValType.i32]
    );
    pushBody.addLocal(ValType.i32); // local[2] = old_len
    pushBody.addLocal(ValType.i32); // local[3] = capacity
    pushBody.addLocal(ValType.i32); // local[4] = new_arr (or reused arr)
    pushBody.addLocal(ValType.i32); // local[5] = i
    pushBody
      // old_len = i32.load(arr + 4)
      .localGet(0).i32Const(4).emit(Op.i32_add).i32Load().localSet(2)
      // capacity = i32.load(arr + 8)
      .localGet(0).i32Const(8).emit(Op.i32_add).i32Load().localSet(3)
      // if (old_len < capacity) → in-place append
      .localGet(2).localGet(3).emit(Op.i32_lt_s)
      .if_(ValType.void)
        // In-place: arr[old_len] = value
        .localGet(0).localGet(2).localGet(1).call(arrSetIdx)
        // length++
        .localGet(0).i32Const(4).emit(Op.i32_add)
        .localGet(2).i32Const(1).emit(Op.i32_add)
        .i32Store()
        // return same arr
        .localGet(0).localSet(4)
      .else_()
        // Need to grow: new_capacity = capacity * 2
        // new_arr = make_array(capacity * 2) — this sets length = capacity*2
        .localGet(3).i32Const(2).emit(Op.i32_mul).call(makeArrIdx).localSet(4)
        // Fix length to old_len + 1 (make_array sets it to capacity*2)
        .localGet(4).i32Const(4).emit(Op.i32_add)
        .localGet(2).i32Const(1).emit(Op.i32_add)
        .i32Store()
        // Copy elements
        .i32Const(0).localSet(5)
        .block().loop()
          .localGet(5).localGet(2).emit(Op.i32_ge_s).brIf(1)
          .localGet(4).localGet(5)
          .localGet(0).localGet(5).call(arrGetIdx)
          .call(arrSetIdx)
          .localGet(5).i32Const(1).emit(Op.i32_add).localSet(5)
          .br(0)
        .end().end()
        // Set new element at old_len
        .localGet(4).localGet(2).localGet(1).call(arrSetIdx)
      .end();
    pushBody.localGet(4); // return array pointer (same or new)
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
  // Infer return types: if all return paths of a function return integers, mark it
  // Also detect functions that return integer-returning closures
  _inferReturnTypes() {
    const funcNames = new Set(this.functions.map(f => f.name));
    
    // Fixed-point iteration for recursive functions
    for (const func of this.functions) {
      func.returnsInt = true; // optimistic assumption
    }
    
    for (let iteration = 0; iteration < 3; iteration++) {
      const returnIntFuncs = new Set(
        this.functions.filter(f => f.returnsInt).map(f => f.name)
      );
      
      for (const func of this.functions) {
        func.returnsInt = this._allReturnPathsInt(func.funcLit.body, func.funcLit.parameters, returnIntFuncs);
      }
    }
    
    // Detect functions that return integer-returning closures
    // e.g., let adder = fn(x) { fn(y) { x + y } } → adder.returnsIntClosure = true
    for (const func of this.functions) {
      if (!func.returnsInt) {
        // Check if the function returns a FunctionLiteral whose body returns int
        const returnedClosure = this._getReturnedClosure(func.funcLit.body);
        if (returnedClosure) {
          // Include both the closure's own params and the outer function's params
          // (outer params are captured variables that are also integers)
          const outerParams = func.funcLit.parameters || [];
          const closureParams = returnedClosure.parameters || [];
          const allParams = [...closureParams, ...outerParams];
          const closureReturnsInt = this._allReturnPathsInt(
            returnedClosure.body, allParams,
            new Set(this.functions.filter(f => f.returnsInt).map(f => f.name))
          );
          func.returnsIntClosure = closureReturnsInt;
        }
      }
    }
  }
  
  // Check if all return paths in a block produce integer values
  _allReturnPathsInt(body, params, returnIntFuncs) {
    if (!body || !body.statements || body.statements.length === 0) return false;
    
    const paramNames = new Set((params || []).map(p => p.value || p.token?.literal));
    
    const isIntExpr = (node) => {
      if (!node) return false;
      if (node instanceof ast.IntegerLiteral) return true;
      if (node instanceof ast.BooleanLiteral) return true;
      if (node instanceof ast.Identifier) return paramNames.has(node.value);
      if (node instanceof ast.InfixExpression) {
        // Comparison operators always return int (boolean)
        if (['<', '>', '<=', '>=', '==', '!='].includes(node.operator)) return true;
        // Arithmetic operators return int only if both operands are int
        if (['-', '*', '/', '%'].includes(node.operator)) {
          return isIntExpr(node.left) && isIntExpr(node.right);
        }
        if (node.operator === '+') return isIntExpr(node.left) && isIntExpr(node.right);
        return false;
      }
      if (node instanceof ast.PrefixExpression) return true;
      if (node instanceof ast.IfExpression) {
        // Both branches must return int
        const consInt = node.consequence ? isIntBlock(node.consequence) : false;
        const altInt = node.alternative ? isIntBlock(node.alternative) : false;
        return consInt && altInt;
      }
      if (node instanceof ast.CallExpression) {
        // Known function with int return
        if (node.function instanceof ast.Identifier && returnIntFuncs.has(node.function.value)) {
          return true;
        }
        return false;
      }
      if (node instanceof ast.BlockStatement) return isIntBlock(node);
      return false;
    };
    
    const isIntBlock = (block) => {
      if (!block || !block.statements || block.statements.length === 0) return false;
      const last = block.statements[block.statements.length - 1];
      if (last instanceof ast.ExpressionStatement) return isIntExpr(last.expression);
      if (last instanceof ast.ReturnStatement) return isIntExpr(last.returnValue);
      return false;
    };
    
    return isIntBlock(body);
  }

  _declareFunction(name, funcLit) {
    const params = funcLit.parameters.map(() => ValType.i32);
    const results = [ValType.i32]; // all functions return i32 for now

    const { index, body } = this.builder.addFunction(params, results);
    this.builder.addExport(name, ExportKind.Func, index);

    this.functions.push({
      name, index, body, funcLit, params, returnsInt: false,
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

      // Push scope ID for box analysis lookup
      const parentScopeId = this._scopeIdStack[this._scopeIdStack.length - 1];
      const paramNames = func.funcLit.parameters.map(p => p.value || p.token?.literal).join(',') || 'anon';
      this._scopeIdStack.push(parentScopeId + '/' + paramNames);

      this.currentBody = func.body;
      this.blockDepth = 0;
      this.currentFunc = func;
      this.currentScope = new Scope(this.globalScope);
      this.nextParamIndex = 0;
      this.nextLocalIndex = func.params.length;

      // Bind parameters — mark as knownInt if the function only uses them
      // in integer contexts (arithmetic, comparisons, calls to returnsInt functions)
      // Always run _inferIntParams, not just for returnsInt functions.
      // Functions returning closures may still have integer parameters
      // (e.g., let adder = fn(x) { fn(y) { x + y } } — x is an int)
      const intParams = this._inferIntParams(func.funcLit);
      for (const param of func.funcLit.parameters) {
        const name = param.value || param.token?.literal;
        this.currentScope.define(name, this.nextParamIndex, ValType.i32, intParams.has(name));
        this.nextParamIndex++;
      }

      // Compile function body (with tail-call optimization if applicable)
      const body = func.funcLit.body;
      const tailCallInfo = this._detectTailRecursion(func.name, func.funcLit);
      
      if (tailCallInfo) {
        // Tail-call optimization: wrap body in a loop
        // The tail call becomes: set params, branch to loop start
        this.currentFunc._tailCallEnabled = true;
        this.currentFunc._tailCallDepth = this.blockDepth;
        this.currentBody.loop(ValType.i32);  // loop (result i32)
        this.blockDepth++;
        this._compileBlockReturning(body);
        this.blockDepth--;
        this.currentBody.end();  // end loop
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
    
    // Check if this variable needs boxing (heap-allocated cell)
    if (this._isBoxedVar(name)) {
      // Allocate a 4-byte box on the heap
      this.currentBody.i32Const(4);
      this.currentBody.call(this._runtimeFuncs.alloc);
      this.currentBody.localSet(localIdx); // local holds box pointer
      
      // Mark as boxed in scope (so compileIdentifier/compileAssignExpression know)
      this.currentScope.define(name, localIdx, ValType.i32, isInt);
      this.currentScope.vars.get(name).boxed = true;
      
      if (stmt.value) {
        // Store value into the box: i32.store(box_ptr, value)
        // Stack order: [addr, value]
        this.currentBody.localGet(localIdx); // box_ptr (addr)
        this.compileNode(stmt.value);        // value
        this.currentBody.i32Store();
      }
    } else {
      this.currentScope.define(name, localIdx, ValType.i32, isInt);
      if (stmt.isConst) {
        if (!this._constVars) this._constVars = new Set();
        this._constVars.add(name);
      }

      // Track if the bound value is a call to a named function (for return type tracking)
      if (stmt.value instanceof ast.CallExpression && stmt.value.function instanceof ast.Identifier) {
        const binding = this.currentScope.resolve(name);
        if (binding) {
          binding._initCall = stmt.value.function.value;
          const calledFunc = this.functions.find(f => f.name === stmt.value.function.value);
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
    // Track source line for source map
    if (node?.token?.line && this.currentBody) {
      this.currentBody.setSourceLine(node.token.line);
    }
    if (node instanceof ast.IntegerLiteral) {
      this.currentBody.i32Const(node.value);
    } else if (node instanceof ast.FloatLiteral) {
      // Store float as heap object via host import
      // Split f64 into two i32 halves and call __float_new(lo, hi)
      const buf = new ArrayBuffer(8);
      const f64 = new Float64Array(buf);
      const i32 = new Int32Array(buf);
      f64[0] = node.value;
      this.currentBody.i32Const(i32[0]); // lo bits
      this.currentBody.i32Const(i32[1]); // hi bits
      this.currentBody.call(this._runtimeFuncs.floatNew);
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
      // But if 'self' is a regular variable (e.g., closure parameter named 'self'),
      // use the variable binding instead
      const binding = this.currentScope.resolve('self');
      if (binding && binding.index !== 0) {
        // Regular variable named 'self' (not class env_ptr)
        this.currentBody.localGet(binding.index);
      } else if (binding) {
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
      } else if (binding.boxed) {
        // Boxed variable: local holds a pointer to a 4-byte cell
        // Dereference: i32.load(local) → value
        this.currentBody.localGet(binding.index);
        this.currentBody.i32Load();
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
    switch (node.operator) {
      case '-':
        if (this._isDefinitelyInteger(node.right)) {
          // negate integer: 0 - value
          this.currentBody.i32Const(0);
          this.compileNode(node.right);
          this.currentBody.emit(Op.i32_sub);
        } else {
          // Runtime dispatch (handles floats)
          this.compileNode(node.right);
          this.currentBody.call(this._runtimeFuncs.neg);
        }
        break;
      case '!':
        this.compileNode(node.right);
        this.currentBody.emit(Op.i32_eqz);
        break;
      default:
        this.compileNode(node.right);
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
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.add);
          this.stats.hostArith++;
        }
        break;
      case '-':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_sub); this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.sub); this.stats.hostArith++;
        }
        break;
      case '*':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_mul); this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.mul); this.stats.hostArith++;
        }
        break;
      case '/':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_div_s); this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.div); this.stats.hostArith++;
        }
        break;
      case '%':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_rem_s); this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.mod); this.stats.hostArith++;
        }
        break;
      case '==':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_eq);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
          this.stats.hostArith++;
        }
        break;
      case '!=':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_ne);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.eq);
          this.currentBody.emit(Op.i32_eqz);
          this.stats.hostArith++;
        }
        break;
      case '<':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_lt_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.lt);
          this.stats.hostArith++;
        }
        break;
      case '>':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_gt_s);
          this.stats.directArith++;
        } else {
          this.currentBody.call(this._runtimeFuncs.gt);
          this.stats.hostArith++;
        }
        break;
      case '<=':
        if (this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right)) {
          this.currentBody.emit(Op.i32_le_s);
          this.stats.directArith++;
        } else {
          // a <= b === !(a > b)
          this.currentBody.call(this._runtimeFuncs.gt);
          this.stats.hostArith++;
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
    // Handle super.method(args) calls
    if (node.function instanceof ast.IndexExpression &&
        node.function.left instanceof ast.SuperExpression) {
      return this._compileSuperCall(node);
    }
    
    // Check for builtin functions first
    if (node.function instanceof ast.Identifier) {
      const name = node.function.value;

      // If the name is locally defined (user shadowed a builtin), use normal call path
      const isLocallyDefined = (this.currentScope && this.currentScope.vars.has(name)) ||
        this.functions.some(f => f.name === name);

      // Built-in: len(x)
      if (!isLocallyDefined && name === 'len' && node.arguments.length === 1) {
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

      // Higher-order builtins: map(arr, fn), filter(arr, fn), find(arr, fn), any(arr, fn), every(arr, fn)
      if (!isLocallyDefined && ['map', 'filter', 'find', 'any', 'every'].includes(name) && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]); // array
        this.compileNode(node.arguments[1]); // closure
        this.currentBody.call(this._runtimeFuncs[name]);
        return;
      }

      // Built-in: reduce(arr, fn, init) or reduce(arr, fn)
      if (!isLocallyDefined && name === 'reduce' && (node.arguments.length === 2 || node.arguments.length === 3)) {
        this.compileNode(node.arguments[0]); // array
        this.compileNode(node.arguments[1]); // closure
        if (node.arguments.length === 3) {
          this.compileNode(node.arguments[2]); // initial value
        } else {
          this.currentBody.i32Const(-2147483648); // sentinel: no initial value (MIN_INT)
        }
        this.currentBody.call(this._runtimeFuncs.reduce);
        return;
      }

      // Built-in: sort(arr) or sort(arr, cmpFn)
      if (!isLocallyDefined && name === 'sort' && (node.arguments.length === 1 || node.arguments.length === 2)) {
        this.compileNode(node.arguments[0]); // array
        if (node.arguments.length === 2) {
          this.compileNode(node.arguments[1]); // comparator closure
        } else {
          this.currentBody.i32Const(0); // 0 = no comparator (default sort)
        }
        this.currentBody.call(this._runtimeFuncs.sort);
        return;
      }

      // Built-in: forEach(arr, fn) — calls fn for each element
      if (!isLocallyDefined && name === 'forEach' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]); // array
        this.compileNode(node.arguments[1]); // closure
        this.currentBody.call(this._runtimeFuncs.forEach);
        return;
      }

      // flatMap(arr, fn)
      if (!isLocallyDefined && name === 'flatMap' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.flatMap);
        return;
      }

      // zip(arr1, arr2)
      if (!isLocallyDefined && name === 'zip' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.zip);
        return;
      }

      // enumerate(arr)
      if (!isLocallyDefined && name === 'enumerate' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.enumerate);
        return;
      }

      // String methods
      if (name === 'split' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strSplit);
        return;
      }
      if (name === 'trim' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strTrim);
        return;
      }
      if (name === 'replace' && node.arguments.length === 3) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.compileNode(node.arguments[2]);
        this.currentBody.call(this._runtimeFuncs.strReplace);
        return;
      }
      if (name === 'indexOf' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strIndexOf);
        return;
      }
      if (name === 'startsWith' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strStartsWith);
        return;
      }
      if (name === 'endsWith' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.strEndsWith);
        return;
      }
      if (name === 'toUpper' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strUpper);
        return;
      }
      if (name === 'toLower' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.strLower);
        return;
      }
      if (name === 'substring' && (node.arguments.length === 2 || node.arguments.length === 3)) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        if (node.arguments.length === 3) {
          this.compileNode(node.arguments[2]);
        } else {
          this.currentBody.i32Const(-1); // sentinel for "to end"
        }
        this.currentBody.call(this._runtimeFuncs.strSubstring);
        return;
      }

      // Utility builtins
      if (name === 'max' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.max);
        return;
      }
      if (name === 'min' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.min);
        return;
      }
      if (name === 'range' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.range);
        return;
      }
      if (name === 'join' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.join);
        return;
      }
      if (name === 'keys' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.keys);
        return;
      }
      if (name === 'values' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.values);
        return;
      }
      if (name === 'contains' && node.arguments.length === 2) {
        this.compileNode(node.arguments[0]);
        this.compileNode(node.arguments[1]);
        this.currentBody.call(this._runtimeFuncs.contains);
        return;
      }
      if (name === 'reverse' && node.arguments.length === 1) {
        this.compileNode(node.arguments[0]);
        this.currentBody.call(this._runtimeFuncs.reverse);
        return;
      }
    }

    // Find function
    if (node.function instanceof ast.Identifier) {
      const name = node.function.value;
      const binding = this.currentScope.resolve(name);
      if (binding && binding.type === 'func') {
        // Check for tail-call optimization: if calling ourselves in tail position
        if (this.currentFunc?._tailCallEnabled && name === this.currentFunc.name) {
          // Tail call optimization: set parameters and branch to loop start
          // Compile all arguments onto the stack, then set params in reverse
          // (to avoid overwriting params that are used in later arg expressions)
          const paramCount = node.arguments.length;
          for (const arg of node.arguments) {
            this.compileNode(arg);
          }
          // Set params in reverse order (stack is LIFO)
          for (let i = paramCount - 1; i >= 0; i--) {
            this.currentBody.localSet(i);
          }
          // Branch to loop start
          const loopDepth = this.blockDepth - this.currentFunc._tailCallDepth - 1;
          this.currentBody.br(loopDepth);
          // After br, need a dummy value for the block type (unreachable code)
          this.currentBody.i32Const(0);
          return;
        }
        
        // Direct function call
        for (const arg of node.arguments) {
          this.compileNode(arg);
        }
        this.currentBody.call(binding.index);
      } else if (binding) {
        // Variable holding a closure — indirect call
        // If boxed, dereference the box to get the closure pointer
        if (binding.boxed) {
          this._emitClosureCall(node, () => {
            this.currentBody.localGet(binding.index);
            this.currentBody.i32Load(); // dereference box → closure ptr
          });
        } else {
          this._emitClosureCall(node, () => this.currentBody.localGet(binding.index));
        }
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

    // Bind loop variable — knownInt if iterating over a numeric range
    const varLocal = this.nextLocalIndex++;
    this.currentBody.addLocal(ValType.i32);
    const isNumericRange = node.iterable instanceof ast.RangeExpression;
    this.currentScope.define(node.variable, varLocal, ValType.i32, isNumericRange);

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
      if (binding.boxed) {
        // Boxed variable: store through the box pointer
        // Stack for i32.store: [addr, value] (addr pushed first)
        // We also need to leave the new value on stack (assign is an expression)
        this.currentBody.localGet(binding.index); // push box_ptr (addr)
        this.compileNode(node.value);             // push value
        // Save value before store consumes it
        const tmpLocal = this.nextLocalIndex++;
        this.currentBody.addLocal(ValType.i32);
        this.currentBody.localTee(tmpLocal);      // save value, leave on stack
        this.currentBody.i32Store();              // store(addr=box_ptr, value) — consumes both
        this.currentBody.localGet(tmpLocal);      // push value back for expression result
      } else {
        this.compileNode(node.value);
        this.currentBody.localTee(binding.index); // assign and leave value on stack
      }
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

    // Collect knownInt status and boxed status from outer scope before we switch
    const captureKnownInt = captures.map(name => {
      const binding = this.currentScope.resolve(name);
      return binding ? !!binding.knownInt : false;
    });
    const captureBoxed = captures.map(name => {
      const binding = this.currentScope.resolve(name);
      return binding ? !!binding.boxed : false;
    });

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

    // Push scope ID for box analysis lookup
    const parentScopeId = this._scopeIdStack[this._scopeIdStack.length - 1];
    const paramNames = node.parameters.map(p => p.value || p.token?.literal).join(',') || 'anon';
    this._scopeIdStack.push(parentScopeId + '/' + paramNames);

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
    const intParams = this._inferIntParams(node);
    for (let i = 0; i < node.parameters.length; i++) {
      const name = node.parameters[i].value || node.parameters[i].token?.literal;
      const isInt = intParams.has(name);
      this.currentScope.define(name, i + 1, ValType.i32, isInt);
    }

    // Bind captured variables — read them from the environment
    // Propagate knownInt and boxed status from outer scope through captures
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
      this.currentScope.define(captures[i], localIdx, ValType.i32, captureKnownInt[i]);
      // If the outer variable was boxed, this capture holds a box pointer too
      if (captureBoxed[i]) {
        this.currentScope.vars.get(captures[i]).boxed = true;
      }
    }

    // Compile function body
    this._compileBlockReturning(node.body);

    // Restore state
    this._scopeIdStack.pop();
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
    let envLocal;
    if (captures.length > 0) {
      // Allocate environment: [num_captures:i32][cap0:i32][cap1:i32]...
      const envSize = 4 + captures.length * 4;
      this.currentBody.i32Const(envSize);
      this.currentBody.call(this._runtimeFuncs.alloc);

      envLocal = this.nextLocalIndex++;
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
    }
    // else: 0 captures — skip environment allocation, use env_ptr=0

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

    // Store env_ptr (0 for non-capturing closures)
    this.currentBody.localGet(closureLocal);
    this.currentBody.i32Const(8);
    this.currentBody.emit(Op.i32_add);
    if (captures.length > 0) {
      this.currentBody.localGet(envLocal);
    } else {
      this.currentBody.i32Const(0);
    }
    this.currentBody.i32Store();

    // Leave closure pointer on stack
    this.currentBody.localGet(closureLocal);
  }

  // Check if a function literal has free variables (references to non-param, non-global names)
  _hasFreeVariables(funcLit, params, topLevelFuncNames = new Set(), selfName = null) {
    let hasFree = false;
    const locals = new Set(params); // Track locally-defined names
    if (selfName) locals.add(selfName); // Self-reference in recursive functions is not free
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
    const result = new Map(); // scopeId → Set<varName>
    
    // We do a recursive scope-aware walk. For each scope, we track:
    //   - which variables are defined (let bindings)
    //   - which variables are assigned (appear on LHS of =)
    //   - which variables are captured by inner functions, and how many functions capture each
    //   - which variables are self-referencing (let X = fn(){...X...})
    
    const analyzeScope = (statements, scopeId, outerDefs) => {
      const defs = new Set(outerDefs || []); // variables defined in this scope
      const assigns = new Set(); // variables assigned in this scope
      const capturedBy = new Map(); // varName → count of closures that capture it
      const selfRefs = new Set(); // variables that are self-referencing closures
      
      // First: collect all let bindings in this scope
      for (const stmt of statements) {
        if (stmt instanceof ast.LetStatement && stmt.name) {
          defs.add(stmt.name.value);
        } else if (stmt instanceof ast.ExpressionStatement && stmt.expression instanceof ast.LetStatement) {
          defs.add(stmt.expression.name.value);
        }
      }
      
      // Collect assignments and captures
      const walkExpr = (node, currentScopeDefs) => {
        if (!node) return;
        
        // Assignment expression: mark variable as assigned
        if (node instanceof ast.AssignExpression) {
          const name = node.name?.value || node.name;
          if (name && typeof name === 'string') {
            assigns.add(name);
          }
          walkExpr(node.value, currentScopeDefs);
          return;
        }
        
        // Function literal: analyze captures
        if (node instanceof ast.FunctionLiteral) {
          const params = new Set(node.parameters.map(p => p.value || p.token?.literal));
          const innerDefs = new Set(params);
          const captures = new Set();
          
          // Collect inner let bindings
          const collectInnerDefs = (n) => {
            if (!n) return;
            if (n instanceof ast.LetStatement && n.name) {
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
          
          // Find identifiers referenced in the closure that are from the outer scope
          const findCaptures = (n) => {
            if (!n) return;
            if (n instanceof ast.FunctionLiteral) {
              // Don't recurse into nested functions for capture analysis at this level
              // But DO check their bodies for references to our scope's vars
              const nestedParams = new Set(n.parameters.map(p => p.value || p.token?.literal));
              const findNestedCaptures = (nn) => {
                if (!nn) return;
                if (nn instanceof ast.Identifier) {
                  const name = nn.value;
                  if (!nestedParams.has(name) && !innerDefs.has(name) && defs.has(name)) {
                    captures.add(name);
                  }
                }
                if (nn instanceof ast.FunctionLiteral) return; // stop at deeper nesting
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
              };
              if (n.body && n.body.statements) {
                for (const s of n.body.statements) findNestedCaptures(s);
              }
              return;
            }
            if (n instanceof ast.Identifier) {
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
          };
          
          if (node.body && node.body.statements) {
            for (const s of node.body.statements) findCaptures(s);
          }
          
          // Also check for assignments inside the closure body
          const findInnerAssigns = (n) => {
            if (!n) return;
            if (n instanceof ast.AssignExpression) {
              const name = n.name?.value || n.name;
              if (name && typeof name === 'string' && defs.has(name)) {
                assigns.add(name);
              }
            }
            if (n instanceof ast.FunctionLiteral) return; // don't cross function boundaries
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
          };
          if (node.body && node.body.statements) {
            for (const s of node.body.statements) findInnerAssigns(s);
          }
          
          // Record captures
          for (const name of captures) {
            capturedBy.set(name, (capturedBy.get(name) || 0) + 1);
          }
          
          // Recurse into the function body as a new scope
          if (node.body && node.body.statements) {
            analyzeScope(node.body.statements, scopeId + '/' + (node.parameters.map(p => p.value || p.token?.literal).join(',') || 'anon'), defs);
          }
          return;
        }
        
        // Walk all child nodes
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
        if (node.value && !(node instanceof ast.LetStatement)) walkExpr(node.value, currentScopeDefs);
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
      };
      
      const walkStmt = (stmt, currentScopeDefs) => {
        if (stmt instanceof ast.LetStatement) {
          // Check for self-referencing: let f = fn(){...f...}
          if (stmt.value instanceof ast.FunctionLiteral) {
            const name = stmt.name.value;
            const params = new Set(stmt.value.parameters.map(p => p.value || p.token?.literal));
            // Check if the function body references 'name'
            const refsSelf = this._astReferencesName(stmt.value.body, name, params);
            if (refsSelf) {
              selfRefs.add(name);
            }
          }
          if (stmt.value) walkExpr(stmt.value, currentScopeDefs);
        } else if (stmt instanceof ast.ExpressionStatement) {
          if (stmt.expression) walkExpr(stmt.expression, currentScopeDefs);
        } else if (stmt instanceof ast.ReturnStatement) {
          if (stmt.returnValue) walkExpr(stmt.returnValue, currentScopeDefs);
        } else {
          walkExpr(stmt, currentScopeDefs);
        }
      };
      
      for (const stmt of statements) {
        walkStmt(stmt, defs);
      }
      
      // Determine which variables need boxing in this scope
      const boxed = new Set();
      for (const [name, count] of capturedBy) {
        // (a) captured AND assigned anywhere
        if (assigns.has(name)) {
          boxed.add(name);
        }
        // (b) captured by 2+ closures
        if (count >= 2) {
          boxed.add(name);
        }
      }
      // (c) self-referencing closures that also have OTHER captures
      // Pure self-recursion (only captures itself) works fine as direct function.
      // But self-ref with other captures needs boxing so the captures can access the function.
      for (const name of selfRefs) {
        if (capturedBy.has(name)) {
          // Check if there are other captures besides the self-reference
          const otherCaptures = [...capturedBy.keys()].filter(k => k !== name);
          if (otherCaptures.length > 0) {
            boxed.add(name);
          }
        }
      }
      
      if (boxed.size > 0) {
        result.set(scopeId, boxed);
      }
    };
    
    analyzeScope(program.statements, 'top', new Set());
    return result;
  }
  
  // Helper: check if an AST node references a name (excluding params)
  _astReferencesName(node, name, excludeParams) {
    if (!node) return false;
    if (node instanceof ast.Identifier) {
      return node.value === name && !excludeParams?.has(name);
    }
    if (node instanceof ast.FunctionLiteral) {
      // Don't cross into nested function definitions to check for references
      // But DO check the body for references to the name
      const innerParams = new Set(node.parameters.map(p => p.value || p.token?.literal));
      if (innerParams.has(name)) return false; // shadowed by param
      return this._astReferencesName(node.body, name, innerParams);
    }
    // Check all children
    const children = [node.left, node.right, node.condition, node.consequence, 
                      node.alternative, node.expression, node.value, node.returnValue,
                      node.index, node.function];
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
    return false;
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
      // SelfExpression: treat 'self' like a regular identifier for capture purposes
      if (node instanceof ast.SelfExpression) {
        if (!params.has('self') && this.currentScope.resolve('self') &&
            this.currentScope.resolve('self').type !== 'func') {
          captures.add('self');
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
    const prevClassName = this._currentClassName;
    this._currentClassName = className;
    this._currentSuperClass = stmt.superClass || null;
    
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
    
    this._currentClassName = prevClassName;
    this._currentSuperClass = null;
    
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
    
    const parentMethod = parentInfo.methods.find(m => m.name === methodName);
    if (!parentMethod && parentInfo.initMethod?.name === methodName) {
      // Calling super.init()
      const initMethod = parentInfo.initMethod;
      // Push self
      const selfBinding = this.currentScope.resolve('self');
      if (selfBinding) {
        this.currentBody.localGet(selfBinding.index);
      } else {
        this.currentBody.i32Const(0);
      }
      // Push args
      for (const arg of node.arguments || []) {
        this.compileNode(arg);
      }
      // Call via table
      const paramTypes = [ValType.i32, ...(node.arguments || []).map(() => ValType.i32)];
      const typeIdx = this.builder.addType(paramTypes, [ValType.i32]);
      this.currentBody.i32Const(initMethod.tableSlot);
      this.currentBody.callIndirect(typeIdx);
      return;
    }
    
    if (!parentMethod) {
      this.errors.push(`Method '${methodName}' not found in parent class '${parentName}'`);
      this.currentBody.i32Const(0);
      return;
    }
    
    // Push self
    const selfBinding = this.currentScope.resolve('self');
    if (selfBinding) {
      this.currentBody.localGet(selfBinding.index);
    } else {
      this.currentBody.i32Const(0);
    }
    // Push arguments
    for (const arg of node.arguments || []) {
      this.compileNode(arg);
    }
    // Call parent method via table (self + args)
    const paramTypes = [ValType.i32, ...(node.arguments || []).map(() => ValType.i32)];
    const typeIdx = this.builder.addType(paramTypes, [ValType.i32]);
    this.currentBody.i32Const(parentMethod.tableSlot);
    this.currentBody.callIndirect(typeIdx);
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

  // Get the FunctionLiteral returned by a function body (if it directly returns a closure)
  _getReturnedClosure(body) {
    if (!body || !body.statements || body.statements.length === 0) return null;
    const last = body.statements[body.statements.length - 1];
    const expr = last instanceof ast.ExpressionStatement ? last.expression :
                 last instanceof ast.ReturnStatement ? last.returnValue : null;
    if (expr instanceof ast.FunctionLiteral) return expr;
    // Check if the return is from an if/else where both branches return closures
    if (expr instanceof ast.IfExpression) {
      const thenClosure = this._getReturnedClosure(expr.consequence);
      if (thenClosure) return thenClosure; // use first found
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
      (funcLit.parameters || []).map(p => p.value || p.token?.literal)
    );
    const nonIntParams = new Set();

    const checkNode = (node) => {
      if (!node) return;

      if (node instanceof ast.CallExpression) {
        // Check if the called function is a builtin that expects non-int args
        if (node.function instanceof ast.Identifier) {
          const name = node.function.value;
          // Builtins that accept non-integer arguments
          const nonIntBuiltins = ['len', 'push', 'first', 'last', 'rest', 'puts', 'str',
            'map', 'filter', 'reduce', 'sort', 'reverse', 'join', 'split', 'contains',
            'keys', 'values', 'type', 'range', 'zip', 'flat', 'any', 'all', 'find',
            'count', 'sum', 'max', 'min', 'slice', 'insert', 'remove', 'concat',
            'unique', 'groupBy', 'sortBy', 'chunks'];
          if (nonIntBuiltins.includes(name) && !paramNames.has(name)) {
            // If a parameter is passed as argument to a non-int builtin, it's not int
            for (const arg of node.arguments || []) {
              if (arg instanceof ast.Identifier && paramNames.has(arg.value)) {
                nonIntParams.add(arg.value);
              }
            }
          }
        }
        // Check arguments recursively
        for (const arg of node.arguments || []) checkNode(arg);
        checkNode(node.function);
        return;
      }

      // If a param is used in arithmetic with a float literal, it's not int
      if (node instanceof ast.InfixExpression) {
        const hasFloat = (n) => n instanceof ast.FloatLiteral;
        if (hasFloat(node.left) || hasFloat(node.right)) {
          // If a param appears in an expression with floats, mark it non-int
          if (node.left instanceof ast.Identifier && paramNames.has(node.left.value)) {
            nonIntParams.add(node.left.value);
          }
          if (node.right instanceof ast.Identifier && paramNames.has(node.right.value)) {
            nonIntParams.add(node.right.value);
          }
          // Also check nested: 3.14 * r * r → the outer * has left=(3.14*r), right=r
          const checkForParam = (n) => {
            if (n instanceof ast.Identifier && paramNames.has(n.value)) {
              nonIntParams.add(n.value);
            }
            if (n instanceof ast.InfixExpression) {
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

      if (node instanceof ast.IndexExpression) {
        // If a param is used as the object of an index expression, it's not int
        if (node.left instanceof ast.Identifier && paramNames.has(node.left.value)) {
          nonIntParams.add(node.left.value);
        }
        checkNode(node.left);
        checkNode(node.index);
        return;
      }

      if (node instanceof ast.IfExpression) {
        checkNode(node.condition);
        if (node.consequence) checkBlock(node.consequence);
        if (node.alternative) checkBlock(node.alternative);
        return;
      }

      if (node instanceof ast.InfixExpression) {
        checkNode(node.left);
        checkNode(node.right);
        return;
      }

      if (node instanceof ast.PrefixExpression) {
        checkNode(node.right);
        return;
      }

      if (node instanceof ast.LetStatement) {
        checkNode(node.value);
        return;
      }

      if (node instanceof ast.ExpressionStatement) {
        checkNode(node.expression);
        return;
      }

      if (node instanceof ast.ReturnStatement) {
        checkNode(node.returnValue);
        return;
      }

      if (node instanceof ast.WhileExpression || node instanceof ast.DoWhileExpression) {
        checkNode(node.condition);
        if (node.body) checkBlock(node.body);
        return;
      }

      if (node instanceof ast.ForExpression) {
        checkNode(node.init);
        checkNode(node.condition);
        checkNode(node.update);
        if (node.body) checkBlock(node.body);
        return;
      }

      if (node instanceof ast.BlockStatement) {
        checkBlock(node);
        return;
      }
    };

    const checkBlock = (block) => {
      for (const stmt of (block.statements || [])) checkNode(stmt);
    };

    if (funcLit.body) checkBlock(funcLit.body);

    // Return the set of params that are NOT in nonIntParams
    const intParams = new Set();
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
    
    // Check if a node contains any non-tail recursive calls to funcName
    const checkForNonTailCalls = (node) => {
      if (!node) return;
      
      if (node instanceof ast.CallExpression) {
        if (node.function instanceof ast.Identifier && node.function.value === funcName) {
          hasNonTailCalls = true;
        }
        // Also check arguments for recursive calls
        for (const arg of node.arguments || []) {
          checkForNonTailCalls(arg);
        }
        return;
      }
      
      if (node instanceof ast.InfixExpression) {
        checkForNonTailCalls(node.left);
        checkForNonTailCalls(node.right);
        return;
      }
      
      if (node instanceof ast.PrefixExpression) {
        checkForNonTailCalls(node.right);
        return;
      }
      
      if (node instanceof ast.IndexExpression) {
        checkForNonTailCalls(node.left);
        checkForNonTailCalls(node.index);
        return;
      }
      
      if (node instanceof ast.AssignExpression) {
        checkForNonTailCalls(node.value);
        return;
      }
    };
    
    // Check tail position recursively
    const checkTail = (node) => {
      if (!node) return;
      
      // Direct tail call
      if (node instanceof ast.CallExpression) {
        if (node.function instanceof ast.Identifier && node.function.value === funcName) {
          hasTailCalls = true;
          // Check if ANY argument contains a recursive call (which wouldn't be tail)
          for (const arg of node.arguments || []) {
            checkForNonTailCalls(arg);
          }
          return;
        }
        // Not a self-call in tail position — check if it contains recursive calls
        checkForNonTailCalls(node);
        return;
      }
      
      // If/else: check both branches for tail calls
      if (node instanceof ast.IfExpression) {
        // The condition is NOT in tail position
        checkForNonTailCalls(node.condition);
        if (node.consequence) checkTail(this._lastExpr(node.consequence));
        if (node.alternative) checkTail(this._lastExpr(node.alternative));
        // Also check non-last statements for non-tail calls
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
      
      // Any other node — check for non-tail calls
      checkForNonTailCalls(node);
    };
    
    checkTail(this._lastExpr(funcLit.body));
    
    // Also check non-last statements of the body
    if (funcLit.body && funcLit.body.statements) {
      for (let i = 0; i < funcLit.body.statements.length - 1; i++) {
        checkForNonTailCalls(funcLit.body.statements[i]);
      }
    }
    
    // Only enable TCO if there are tail calls and NO non-tail calls
    return (hasTailCalls && !hasNonTailCalls) ? { funcName } : null;
  }
  
  // Get the last expression from a block (the return value)
  _lastExpr(block) {
    if (!block || !block.statements || block.statements.length === 0) return null;
    const last = block.statements[block.statements.length - 1];
    if (last instanceof ast.ExpressionStatement) return last.expression;
    if (last instanceof ast.ReturnStatement) return last.returnValue;
    return last;
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
    if (node instanceof ast.CallExpression) {
      // Check if the called function is a known direct function with int return type
      if (node.function instanceof ast.Identifier) {
        const func = this.functions?.find(f => f.name === node.function.value);
        if (func && func.returnsInt) return true;
        // Check if the variable is bound to a function that returns int (e.g., closures)
        const binding = this.currentScope?.resolve(node.function.value);
        if (binding && binding.callReturnsInt) return true;
        // Check if the variable was assigned from calling a returnsIntClosure function
        // This handles: let f = adder(10); f(5) — f returns int because adder returns int-closure
        if (binding && binding._initCall) {
          const initFunc = this.functions?.find(f => f.name === binding._initCall);
          if (initFunc?.returnsIntClosure) return true;
        }
      }
      return false;
    }
    if (node instanceof ast.InfixExpression) {
      const op = node.operator;
      // Comparison operators always return boolean (int)
      if (['==', '!=', '<', '>', '<=', '>='].includes(op)) return true;
      // Arithmetic operators return int only if both operands are int
      if (['-', '*', '/', '%'].includes(op)) {
        return this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right);
      }
      if (op === '+') return this._isDefinitelyInteger(node.left) && this._isDefinitelyInteger(node.right);
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

  // Unified allocator: uses WASM alloc if available, falls back to JS heap
  function hostAlloc(size) {
    size = (size + 3) & ~3; // align to 4 bytes
    if (memoryRef.alloc) {
      return memoryRef.alloc(size);
    }
    // Fallback: JS-side bump allocator
    if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
    const ptr = memoryRef.jsHeapPtr;
    memoryRef.jsHeapPtr += size;
    // Grow memory if needed (each page = 64KB)
    const mem = memoryRef.memory;
    if (mem && memoryRef.jsHeapPtr > mem.buffer.byteLength) {
      const needed = Math.ceil((memoryRef.jsHeapPtr - mem.buffer.byteLength) / 65536);
      try {
        mem.grow(needed);
      } catch (e) {
        // Memory growth failed — OOM
        throw new Error(`WASM heap exhausted: needed ${memoryRef.jsHeapPtr} bytes, have ${mem.buffer.byteLength}`);
      }
    }
    return ptr;
  }

  function writeFloat(value) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const view = new DataView(mem.buffer);
    const ptr = hostAlloc(12); // TAG_FLOAT(4) + f64(8)
    view.setInt32(ptr, TAG_FLOAT, true);
    view.setFloat64(ptr + 4, value, true);
    return ptr;
  }

  // Resolve a value to a JS number (handles both ints and float pointers)
  function toNumber(v) {
    if (isFloatPtr(v)) return readFloat(v);
    return v;
  }

  // Return a result as int if it's whole, or float pointer if it has decimals
  function fromNumber(n) {
    if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) return n;
    return writeFloat(n);
  }

  // Helper to write string into WASM memory (bump allocator via global[0])
  function writeString(str) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    const size = 8 + bytes.length; // [TAG_STRING:i32][length:i32][bytes...]
    const ptr = hostAlloc(size);
    const view = new DataView(mem.buffer);

    // Write: [TAG_STRING:i32][length:i32][bytes...]
    view.setInt32(ptr, TAG_STRING, true);
    view.setInt32(ptr + 4, bytes.length, true);
    new Uint8Array(mem.buffer).set(bytes, ptr + 8);

    return ptr;
  }

  function writeArray(elements) {
    const mem = memoryRef.memory;
    if (!mem) return 0;
    const capacity = Math.max(elements.length, 4);
    const size = ARRAY_HEADER + capacity * 4; // [TAG_ARRAY:i32][length:i32][capacity:i32][elems...]
    const ptr = hostAlloc(size);
    const view = new DataView(mem.buffer);

    view.setInt32(ptr, TAG_ARRAY, true);
    view.setInt32(ptr + 4, elements.length, true);
    view.setInt32(ptr + 8, capacity, true);
    for (let i = 0; i < elements.length; i++) {
      view.setInt32(ptr + ARRAY_HEADER + i * 4, elements[i], true);
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
      __str_split(strPtr, sepPtr) {
        const s = readString(strPtr);
        const sep = readString(sepPtr);
        const parts = s.split(sep);
        // Build an array of string pointers
        return writeArray(parts.map(p => writeString(p)));
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
        if (!mem) return writeString('');
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || arrPtr + 8 > view.byteLength) return writeString('');
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY) return writeString('');
        const len = view.getInt32(arrPtr + 4, true);
        const sep = readString(sepPtr);
        const parts = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
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
        const numEntries = view.getInt32(hashPtr + 4, true);
        const capacity = view.getInt32(hashPtr + 8, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const keys = [];
        for (let i = 0; i < capacity; i++) {
          const entryAddr = entriesPtr + i * 12;
          const status = view.getInt32(entryAddr, true);
          if (status === 1) { // OCCUPIED
            keys.push(view.getInt32(entryAddr + 4, true)); // key pointer
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
        const numEntries = view.getInt32(hashPtr + 4, true);
        const capacity = view.getInt32(hashPtr + 8, true);
        const entriesPtr = view.getInt32(hashPtr + 12, true);
        const vals = [];
        for (let i = 0; i < capacity; i++) {
          const entryAddr = entriesPtr + i * 12;
          const status = view.getInt32(entryAddr, true);
          if (status === 1) { // OCCUPIED
            vals.push(view.getInt32(entryAddr + 8, true)); // value
          }
        }
        return writeArray(vals);
      },
      __contains(arrPtr, elem) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || arrPtr + 8 > view.byteLength) return 0;
        const tag = view.getInt32(arrPtr, true);
        if (tag === TAG_STRING) {
          // String contains
          const s = readString(arrPtr);
          const search = readString(elem);
          return s.includes(search) ? 1 : 0;
        }
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        for (let i = 0; i < len; i++) {
          if (view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true) === elem) return 1;
        }
        return 0;
      },
      __reverse(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16) return 0;
        const tag = view.getInt32(arrPtr, true);
        if (tag === TAG_STRING) {
          return writeString(readString(arrPtr).split('').reverse().join(''));
        }
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const elems = [];
        for (let i = len - 1; i >= 0; i--) {
          elems.push(view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true));
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
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const results = [];
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer); // refresh after potential growth
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          results.push(fn(envPtr, elem));
        }
        return writeArray(results);
      },

      __filter(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
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
          if (fn(envPtr, elem)) results.push(elem);
        }
        return writeArray(results);
      },

      __reduce(arrPtr, closurePtr, initValue) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        const sentinel = -2147483648; // MIN_INT sentinel = no initial value
        let acc;
        let startIdx;
        if (initValue !== sentinel) {
          acc = initValue;
          startIdx = 0;
        } else {
          if (len === 0) return 0;
          acc = view.getInt32(arrPtr + ARRAY_HEADER, true);
          startIdx = 1;
        }
        for (let i = startIdx; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          acc = fn(envPtr, acc, elem);
        }
        return acc;
      },

      __find(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          if (fn(envPtr, elem)) return elem;
        }
        return 0; // null
      },

      __any(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          if (fn(envPtr, elem)) return 1;
        }
        return 0;
      },

      __every(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
          if (!fn(envPtr, elem)) return 0;
        }
        return 1;
      },

      __sort(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        // Read elements
        const elems = [];
        for (let i = 0; i < len; i++) {
          elems.push(view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true));
        }
        if (closurePtr > 0 && view.getInt32(closurePtr, true) === TAG_CLOSURE) {
          // Custom comparator
          const table = memoryRef.table;
          if (table) {
            const tableIdx = view.getInt32(closurePtr + 4, true);
            const envPtr = view.getInt32(closurePtr + 8, true);
            const cmpFn = table.get(tableIdx);
            elems.sort((a, b) => cmpFn(envPtr, a, b));
          }
        } else {
          // Default ascending integer sort
          elems.sort((a, b) => a - b);
        }
        return writeArray(elems);
      },

      __forEach(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const table = memoryRef.table;
        if (!table) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const tableIdx = view.getInt32(closurePtr + 4, true);
        const envPtr = view.getInt32(closurePtr + 8, true);
        const fn = table.get(tableIdx);
        for (let i = 0; i < len; i++) {
          view = new DataView(mem.buffer);
          fn(envPtr, view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true));
        }
        return 0; // null
      },

      __flatMap(arrPtr, closurePtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        let view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
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
          const subResult = fn(envPtr, elem);
          view = new DataView(mem.buffer);
          // If subResult is an array, flatten it
          if (subResult > 0 && view.getInt32(subResult, true) === TAG_ARRAY) {
            const subLen = view.getInt32(subResult + 4, true);
            for (let j = 0; j < subLen; j++) {
              results.push(view.getInt32(subResult + ARRAY_HEADER + j * 4, true));
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
        if (arrAPtr < 16 || view.getInt32(arrAPtr, true) !== TAG_ARRAY) return 0;
        if (arrBPtr < 16 || view.getInt32(arrBPtr, true) !== TAG_ARRAY) return 0;
        const lenA = view.getInt32(arrAPtr + 4, true);
        const lenB = view.getInt32(arrBPtr + 4, true);
        const len = Math.min(lenA, lenB);
        const pairs = [];
        for (let i = 0; i < len; i++) {
          const a = view.getInt32(arrAPtr + ARRAY_HEADER + i * 4, true);
          const b = view.getInt32(arrBPtr + ARRAY_HEADER + i * 4, true);
          pairs.push(writeArray([a, b]));
        }
        return writeArray(pairs);
      },

      __enumerate(arrPtr) {
        const mem = memoryRef.memory;
        if (!mem) return 0;
        const view = new DataView(mem.buffer);
        if (arrPtr < 16 || view.getInt32(arrPtr, true) !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        const pairs = [];
        for (let i = 0; i < len; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + i * 4, true);
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
            if (tag !== TAG_STRING) return false;
            const len = view.getInt32(v + 4, true);
            return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
          };
          try {
            // Float handling
            if (isFloatPtr(a) || isFloatPtr(b)) {
              return fromNumber(toNumber(a) + toNumber(b));
            }
            if (isStrPtr(a) || isStrPtr(b)) {
              const sA = isStrPtr(a) ? readString(a) : String(a);
              const sB = isStrPtr(b) ? readString(b) : String(b);
              return writeString(sA + sB);
            }
          } catch (e) {}
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
              if (tag !== TAG_STRING) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) === readString(b) ? 1 : 0;
            }
          }
        } catch (e) {}
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
              if (tag !== TAG_STRING) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) < readString(b) ? 1 : 0;
            }
          }
        } catch (e) {}
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
              if (tag !== TAG_STRING) return false;
              const len = view.getInt32(v + 4, true);
              return len >= 0 && len < 1000000 && v + 8 + len <= view.byteLength;
            };
            if (isStrPtr(a) && isStrPtr(b)) {
              return readString(a) > readString(b) ? 1 : 0;
            }
          }
        } catch (e) {}
        return a > b ? 1 : 0;
      },
      // Float arithmetic host imports
      __float_new(lo, hi) {
        // Create a float from two i32 halves (lo, hi of f64 IEEE 754 bits)
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
          // Float division by zero → Infinity/-Infinity/NaN
          if (isFloatPtr(a) || isFloatPtr(b)) return fromNumber(toNumber(a) / nb);
          return 0; // Integer division by zero → 0 (graceful)
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
        
        const lenA = (arrA > 0 && view.getInt32(arrA, true) === TAG_ARRAY) ? view.getInt32(arrA + 4, true) : 0;
        const lenB = (arrB > 0 && view.getInt32(arrB, true) === TAG_ARRAY) ? view.getInt32(arrB + 4, true) : 0;
        const newLen = lenA + lenB;
        const newCap = Math.max(newLen, 4);
        
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += ARRAY_HEADER + newCap * 4;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;
        
        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
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
        const tag = view.getInt32(arrPtr, true);
        if (tag !== TAG_ARRAY) return 0;
        const len = view.getInt32(arrPtr + 4, true);
        if (len <= 0) return 0;

        // Allocate new array with len-1 elements
        const newLen = len - 1;
        const newCap = Math.max(newLen, 4);
        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        const newSize = ARRAY_HEADER + newCap * 4;
        memoryRef.jsHeapPtr += newSize;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;

        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + (i + 1) * 4, true);
          view.setInt32(newPtr + ARRAY_HEADER + i * 4, elem, true);
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
        const newCap = Math.max(newLen, 4);

        if (!memoryRef.jsHeapPtr) memoryRef.jsHeapPtr = 1048576;
        const newPtr = memoryRef.jsHeapPtr;
        memoryRef.jsHeapPtr += ARRAY_HEADER + newCap * 4;
        memoryRef.jsHeapPtr = (memoryRef.jsHeapPtr + 3) & ~3;

        view.setInt32(newPtr, TAG_ARRAY, true);
        view.setInt32(newPtr + 4, newLen, true);
        view.setInt32(newPtr + 8, newCap, true);
        for (let i = 0; i < newLen; i++) {
          const elem = view.getInt32(arrPtr + ARRAY_HEADER + (start + i) * 4, true);
          view.setInt32(newPtr + ARRAY_HEADER + i * 4, elem, true);
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
        return view.getInt32(obj + ARRAY_HEADER + key * 4, true);
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
        view.setInt32(obj + ARRAY_HEADER + key * 4, value, true);
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
      if (tag === TAG_FLOAT) {
        const f = dataView.getFloat64(value + 4, true);
        // Format: remove trailing zeros but keep at least one decimal
        return Number.isInteger(f) ? f.toFixed(1) : String(f);
      }
      if (tag === TAG_ARRAY) {
        const len = dataView.getInt32(value + 4, true);
        if (len >= 0 && len < 100000) {
          const elems = [];
          for (let i = 0; i < len; i++) {
            const elem = dataView.getInt32(value + ARRAY_HEADER + i * 4, true);
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

// Module cache: source string → { module: WebAssembly.Module, binary: Uint8Array, warnings }
const _moduleCache = new Map();
const _MODULE_CACHE_MAX = 64;

function _hashString(str) {
  // Simple FNV-1a hash for cache keying
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) | 0;
  }
  return hash >>> 0; // unsigned
}

export async function compileAndRun(input, options = {}) {
  const timings = {};
  const t0 = performance.now();

  // Check module cache (skip compile+encode+wasmCompile on hit)
  const useCache = options.cache !== false; // enabled by default
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
    module = await WebAssembly.compile(binary);
    timings.wasmCompile = performance.now() - t2;

    // Store in cache
    if (useCache) {
      if (_moduleCache.size >= _MODULE_CACHE_MAX) {
        // Evict oldest entry
        const firstKey = _moduleCache.keys().next().value;
        _moduleCache.delete(firstKey);
      }
      _moduleCache.set(cacheKey, { module, warnings: compiler.warnings.slice() });
    }
  } // end if (!module)

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
  memoryRef.table = instance.exports.__indirect_function_table || null;
  memoryRef.alloc = instance.exports.__alloc || null;
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
  memoryRef.table = instance.exports.__indirect_function_table || null;
  memoryRef.alloc = instance.exports.__alloc || null;

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
    memoryRef.table = instance.exports.__indirect_function_table || null;
  memoryRef.alloc = instance.exports.__alloc || null;
    return instance.exports.main();
  };
}

export function clearModuleCache() {
  _moduleCache.clear();
}

export function getModuleCacheStats() {
  return { size: _moduleCache.size, maxSize: _MODULE_CACHE_MAX };
}
