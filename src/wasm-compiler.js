// wasm-compiler.js — Compile Monkey-Lang AST to WebAssembly
//
// Phase 1: Integer arithmetic + function definitions/calls
// Subset of monkey-lang that compiles to WASM:
//   - Integer literals and arithmetic (+, -, *, /, %)
//   - Let bindings (become WASM locals)
//   - Function definitions (become WASM functions)
//   - Function calls
//   - If/else (WASM block + br_if)
//   - Comparison operators (<, >, ==, !=)
//   - Return statements

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import * as ast from './ast.js';
import { WasmModule, WasmOp, WASM_TYPE, encodeSLEB128, encodeULEB128 } from './wasm.js';

/**
 * Compile monkey-lang source to a WASM binary module.
 * Only supports the integer/function subset.
 * @param {string} source - Monkey-lang source code
 * @param {{ useI64?: boolean }} [options]
 * @returns {Uint8Array} WASM binary
 */
export function compileToWasm(source, options = {}) {
  const lexer = new Lexer(source);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  
  if (parser.errors.length > 0) {
    throw new Error(`Parse errors: ${parser.errors.join(', ')}`);
  }
  
  const compiler = new WasmCompiler(options);
  return compiler.compile(program);
}

class WasmCompiler {
  constructor(options = {}) {
    this.module = new WasmModule();
    this.functions = new Map();
    this.globals = new Map(); // name → {index, mutable}
    this.stringConstants = new Map(); // string value → data segment offset
    this.currentLocals = null;
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    this.useI64 = options.useI64 || false;
    this.useF64 = options.useF64 || false;
    this.importSignatures = options.importSignatures || null;
    // (removed: _strConcatImport — now using internal WASM functions)
    this.varTypes = new Map(); // variable name → 'string' | 'int' | 'array' | 'unknown'
    this.currentVarTypes = null; // per-function local type map
    this._heapBaseGlobal = null; // global for heap pointer (bump allocator)
    this._allocFuncIdx = null; // lazily added __alloc function
    this._ensureCapFuncIdx = null; // lazily added __array_ensure_cap function
    this._strConcatFuncIdx = null; // lazily added __str_concat function
    this._strEqFuncIdx = null; // lazily added __str_eq function
    this._strCmpFuncIdx = null; // lazily added __str_cmp function
    this._indexOfFuncIdx = null; // lazily added __str_indexOf function
    this._intToStrFuncIdx = null; // lazily added __int_to_str function
    this._hashNewFuncIdx = null; // lazily added __hash_new function
    this._hashGetFuncIdx = null; // lazily added __hash_get function
    this._hashSetFuncIdx = null; // lazily added __hash_set function
    this._loopDepth = 0; // nesting depth for break/continue
    this._blockDepthInLoop = 0; // block nesting depth within current loop
    this._needsMemory = false; // set when arrays or dynamic allocation needed
    this._anonCounter = 0; // counter for anonymous function names
    this._anonMap = new Map(); // FunctionLiteral node → name string
    this._anonFunctions = []; // [{name, fnLit}] — anonymous functions to compile
  }

  // Count local (non-imported) functions in the map
  _localFunctionCount() {
    let count = 0;
    for (const [, info] of this.functions) {
      if (!info.imported) count++;
    }
    return count;
  }
  
  // Get the appropriate numeric type
  get numType() { return this.useF64 ? WASM_TYPE.F64 : this.useI64 ? WASM_TYPE.I64 : WASM_TYPE.I32; }
  
  // Get i32/i64 opcode by name
  iop(name) {
    const prefix = this.useF64 ? 'f64_' : this.useI64 ? 'i64_' : 'i32_';
    return WasmOp[prefix + name];
  }
  
  // Comparison op: f64 uses unsuffixed names (lt, gt), integers use _s suffix
  cop(name) {
    if (this.useF64) return WasmOp['f64_' + name];
    const prefix = this.useI64 ? 'i64_' : 'i32_';
    return WasmOp[prefix + name + '_s'];
  }
  
  // Emit a numeric constant (handles f64's 8-byte encoding and i64 BigInt)
  _emitConst(body, value) {
    if (this.useF64) {
      this._emitF64Const(body, value);
    } else {
      body.push(this.iop("const"), ...encodeSLEB128(value));
    }
  }
  
  compile(program) {
    // Pass 0: Process import statements (creates WASM imports)
    this._processImports(program.statements);

    // Pass 0.25: Scan for arrays/memory needs and set up allocator early
    if (this._programNeedsMemory(program)) {
      this._getAllocFunc(); // adds __alloc function before any user functions
      this._getArrayEnsureCapFunc(); // adds __array_ensure_cap before any user functions
      this._getStrConcatFunc(); // adds __str_concat before any user functions
      this._getStrEqFunc(); // adds __str_eq before any user functions
      this._getStrCmpFunc(); // adds __str_cmp before any user functions
      this._getIndexOfFunc(); // adds __str_indexOf before any user functions
      this._getIntToStringFunc(); // adds __int_to_str before any user functions
      this._getHashNewFunc(); // adds __hash_new before any user functions
      this._getHashSetFunc(); // adds __hash_set before any user functions
      this._getHashGetFunc(); // adds __hash_get before any user functions
    }

    // Pass 0.5: Process top-level let bindings as globals (non-function values)
    this._processGlobals(program.statements);

    // Pass 1: Collect all function definitions and their signatures
    this._collectFunctions(program.statements);
    
    // Pass 1.5: Infer function parameter types from call sites
    this._inferCallSiteTypes(program.statements);
    
    // Pass 2: Compile function bodies
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        this._compileFunction(stmt.name.value, stmt.value);
      }
    }
    
    // Pass 2.1: Compile anonymous function bodies
    for (const { name, fnLit } of this._anonFunctions) {
      this._compileFunction(name, fnLit);
    }
    
    // Pass 2.5: Initialize globals (compile init expressions into a start-like function)
    // Globals are now initialized inline in the main block (preserving execution order)
    // No separate init function needed
    
    // Collect non-import, non-function-def statements for main block (lets + expressions in order)
    const mainStatements = program.statements.filter(stmt =>
      !(stmt instanceof ast.ImportStatement) &&
      !(stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral)
    );
    if (mainStatements.length > 0) {
      this._compileMainBlock(mainStatements);
    }
    
    // Export memory if data segments were added (strings) or arrays used
    if (this.module.dataSegments.length > 0 || this._needsMemory) {
      this._ensureMemory();
      this.module.exportMemory();
    }
    
    return this.module.encode();
  }

  // Scan AST to see if any arrays are used (need memory + allocator)
  _programNeedsMemory(program) {
    const scan = (node) => {
      if (!node) return false;
      if (node instanceof ast.ArrayLiteral) return true;
      if (node instanceof ast.IndexExpression) return true;
      if (node instanceof ast.ForInExpression) return true;
      if (node instanceof ast.ArrayComprehension) return true;
      if (node instanceof ast.StringLiteral) return true;
      if (node instanceof ast.HashLiteral) return true;
      // Check common node types
      if (node.statements) return node.statements.some(s => scan(s));
      if (node.expression) return scan(node.expression);
      if (node.value) return scan(node.value);
      if (node.returnValue) return scan(node.returnValue);
      if (node.consequence) {
        if (scan(node.consequence)) return true;
      }
      if (node.alternative) {
        if (scan(node.alternative)) return true;
      }
      if (node.body) return scan(node.body);
      if (node.left) {
        if (scan(node.left)) return true;
      }
      if (node.right) {
        if (scan(node.right)) return true;
      }
      if (node.arguments) {
        if (node.arguments.some(a => scan(a))) return true;
      }
      if (node.elements) {
        if (node.elements.some(e => scan(e))) return true;
      }
      if (node.parameters) return false; // parameters are identifiers, skip
      if (node.condition) {
        if (scan(node.condition)) return true;
      }
      if (node.init) {
        if (scan(node.init)) return true;
      }
      if (node.update) {
        if (scan(node.update)) return true;
      }
      if (node.index) {
        if (scan(node.index)) return true;
      }
      return false;
    };
    return program.statements.some(s => scan(s));
  }

  // Lazily add the __str_concat import when string concatenation is first used
  // Get the __str_concat function index (lazily created as internal WASM function)
  // __str_concat(ptr1: i32, ptr2: i32) -> new_ptr: i32
  // Allocates new string buffer, copies both strings' bytes.
  // String layout: [len:i32][bytes...]
  _getStrConcatFunc() {
    if (this._strConcatFuncIdx !== null) return this._strConcatFuncIdx;
    
    const allocIdx = this._getAllocFunc();
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=ptr1, 1=ptr2. Locals: 2=len1, 3=len2, 4=newPtr, 5=i
    const body = [
      // len1 = load(ptr1 + 0)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2,
      
      // len2 = load(ptr2 + 0)
      WasmOp.local_get, 1,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3,
      
      // newPtr = __alloc(4 + len1 + len2)
      WasmOp.i32_const, 4,
      WasmOp.local_get, 2,
      WasmOp.i32_add,
      WasmOp.local_get, 3,
      WasmOp.i32_add,
      WasmOp.call, ...encodeULEB128(allocIdx),
      WasmOp.local_set, 4,
      
      // Store newLen at newPtr+0
      WasmOp.local_get, 4,
      WasmOp.local_get, 2,
      WasmOp.local_get, 3,
      WasmOp.i32_add,
      WasmOp.i32_store, 2, 0,
      
      // Copy first string bytes: ptr1+4 → newPtr+4, len1 bytes
      WasmOp.i32_const, 0,
      WasmOp.local_set, 5, // i = 0
      WasmOp.block, 0x40,
        WasmOp.loop, 0x40,
          WasmOp.local_get, 5,
          WasmOp.local_get, 2,
          WasmOp.i32_ge_u,
          WasmOp.br_if, 1,
          // newPtr[4+i] = ptr1[4+i]
          WasmOp.local_get, 4,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.local_get, 0,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.i32_store8, 0, 0,
          // i++
          WasmOp.local_get, 5,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 5,
          WasmOp.br, 0,
        WasmOp.end,
      WasmOp.end,
      
      // Copy second string bytes: ptr2+4 → newPtr+4+len1, len2 bytes
      WasmOp.i32_const, 0,
      WasmOp.local_set, 5, // i = 0
      WasmOp.block, 0x40,
        WasmOp.loop, 0x40,
          WasmOp.local_get, 5,
          WasmOp.local_get, 3,
          WasmOp.i32_ge_u,
          WasmOp.br_if, 1,
          // newPtr[4+len1+i] = ptr2[4+i]
          WasmOp.local_get, 4,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 2, // len1
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.local_get, 1,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.i32_store8, 0, 0,
          // i++
          WasmOp.local_get, 5,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 5,
          WasmOp.br, 0,
        WasmOp.end,
      WasmOp.end,
      
      // return newPtr
      WasmOp.local_get, 4,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 4, type: WASM_TYPE.I32 } // len1, len2, newPtr, i
    ], body);
    this._strConcatFuncIdx = funcIdx;
    return funcIdx;
  }

  // Get the __str_eq function index (lazily created)
  // __str_eq(ptr1: i32, ptr2: i32) -> i32 (0 or 1)
  _getStrEqFunc() {
    if (this._strEqFuncIdx !== null) return this._strEqFuncIdx;
    
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=ptr1, 1=ptr2. Locals: 2=len1, 3=len2, 4=i
    const body = [
      // len1 = load(ptr1)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2,
      
      // len2 = load(ptr2)
      WasmOp.local_get, 1,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3,
      
      // if len1 != len2, return 0
      WasmOp.local_get, 2,
      WasmOp.local_get, 3,
      WasmOp.i32_ne,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, 0,
        WasmOp.return_,
      WasmOp.end,
      
      // Compare bytes
      WasmOp.i32_const, 0,
      WasmOp.local_set, 4, // i = 0
      WasmOp.block, 0x40,
        WasmOp.loop, 0x40,
          WasmOp.local_get, 4,
          WasmOp.local_get, 2,
          WasmOp.i32_ge_u,
          WasmOp.br_if, 1, // all bytes matched
          // if ptr1[4+i] != ptr2[4+i], return 0
          WasmOp.local_get, 0,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 4,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.local_get, 1,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 4,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.i32_ne,
          WasmOp.if_, 0x40,
            WasmOp.i32_const, 0,
            WasmOp.return_,
          WasmOp.end,
          // i++
          WasmOp.local_get, 4,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 4,
          WasmOp.br, 0,
        WasmOp.end,
      WasmOp.end,
      
      // All bytes match
      WasmOp.i32_const, 1,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 3, type: WASM_TYPE.I32 } // len1, len2, i
    ], body);
    this._strEqFuncIdx = funcIdx;
    return funcIdx;
  }

  // __str_cmp(ptr1: i32, ptr2: i32) -> i32 (-1, 0, or 1)
  // Lexicographic comparison, like strcmp
  _getStrCmpFunc() {
    if (this._strCmpFuncIdx !== null) return this._strCmpFuncIdx;
    
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=ptr1, 1=ptr2. Locals: 2=len1, 3=len2, 4=minLen, 5=i, 6=b1, 7=b2
    const body = [
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2, // len1
      
      WasmOp.local_get, 1,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3, // len2
      
      // minLen = min(len1, len2)
      WasmOp.local_get, 2,
      WasmOp.local_get, 3,
      WasmOp.i32_lt_u,
      WasmOp.if_, 0x7F,
        WasmOp.local_get, 2,
      WasmOp.else_,
        WasmOp.local_get, 3,
      WasmOp.end,
      WasmOp.local_set, 4, // minLen
      
      // Compare bytes
      WasmOp.i32_const, 0,
      WasmOp.local_set, 5, // i = 0
      WasmOp.block, 0x40,
        WasmOp.loop, 0x40,
          WasmOp.local_get, 5,
          WasmOp.local_get, 4,
          WasmOp.i32_ge_u,
          WasmOp.br_if, 1,
          
          // b1 = ptr1[4+i]
          WasmOp.local_get, 0,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.local_set, 6,
          
          // b2 = ptr2[4+i]
          WasmOp.local_get, 1,
          WasmOp.i32_const, 4,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_add,
          WasmOp.i32_load8_u, 0, 0,
          WasmOp.local_set, 7,
          
          // if b1 < b2 return -1
          WasmOp.local_get, 6,
          WasmOp.local_get, 7,
          WasmOp.i32_lt_u,
          WasmOp.if_, 0x40,
            WasmOp.i32_const, ...encodeSLEB128(-1),
            WasmOp.return_,
          WasmOp.end,
          
          // if b1 > b2 return 1
          WasmOp.local_get, 6,
          WasmOp.local_get, 7,
          WasmOp.i32_gt_u,
          WasmOp.if_, 0x40,
            WasmOp.i32_const, 1,
            WasmOp.return_,
          WasmOp.end,
          
          WasmOp.local_get, 5,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 5,
          WasmOp.br, 0,
        WasmOp.end,
      WasmOp.end,
      
      // All compared bytes equal — compare lengths
      WasmOp.local_get, 2,
      WasmOp.local_get, 3,
      WasmOp.i32_lt_u,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, ...encodeSLEB128(-1),
        WasmOp.return_,
      WasmOp.end,
      WasmOp.local_get, 2,
      WasmOp.local_get, 3,
      WasmOp.i32_gt_u,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, 1,
        WasmOp.return_,
      WasmOp.end,
      
      WasmOp.i32_const, 0, // equal
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 6, type: WASM_TYPE.I32 }
    ], body);
    this._strCmpFuncIdx = funcIdx;
    return funcIdx;
  }

  // __str_indexOf(haystack: i32, needle: i32) -> i32 (index or -1)
  _getIndexOfFunc() {
    if (this._indexOfFuncIdx !== null) return this._indexOfFuncIdx;
    
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=haystack, 1=needle
    // Locals: 2=hLen, 3=nLen, 4=i, 5=j, 6=matched
    const body = [
      // hLen = load(haystack)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2,
      
      // nLen = load(needle)
      WasmOp.local_get, 1,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3,
      
      // if nLen == 0, return 0
      WasmOp.local_get, 3,
      WasmOp.i32_eqz,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, 0,
        WasmOp.return_,
      WasmOp.end,
      
      // if nLen > hLen, return -1
      WasmOp.local_get, 3,
      WasmOp.local_get, 2,
      WasmOp.i32_gt_u,
      WasmOp.if_, 0x40,
        ...encodeSLEB128(-1).flatMap(b => [WasmOp.i32_const, ...encodeSLEB128(-1)]),
      WasmOp.end,
    ];
    
    // Hmm, the -1 encoding is tricky. Let me use a simpler approach:
    // Actually let me rewrite this more carefully.
    
    // Rewrite with cleaner logic:
    const body2 = [
      // hLen = load(haystack)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2,
      
      // nLen = load(needle)
      WasmOp.local_get, 1,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3,
      
      // if nLen == 0, return 0
      WasmOp.local_get, 3,
      WasmOp.i32_eqz,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, 0,
        WasmOp.return_,
      WasmOp.end,
      
      // Outer loop: i = 0; while (i <= hLen - nLen)
      WasmOp.i32_const, 0,
      WasmOp.local_set, 4, // i = 0
      
      WasmOp.block, 0x40, // outer_break
        WasmOp.loop, 0x40, // outer_continue
          // if i > hLen - nLen, break
          WasmOp.local_get, 4,
          WasmOp.local_get, 2,
          WasmOp.local_get, 3,
          WasmOp.i32_sub,
          WasmOp.i32_gt_s,
          WasmOp.br_if, 1,
          
          // Inner loop: compare needle bytes
          WasmOp.i32_const, 0,
          WasmOp.local_set, 5, // j = 0
          WasmOp.i32_const, 1,
          WasmOp.local_set, 6, // matched = 1
          
          WasmOp.block, 0x40, // inner_break
            WasmOp.loop, 0x40, // inner_continue
              WasmOp.local_get, 5,
              WasmOp.local_get, 3,
              WasmOp.i32_ge_u,
              WasmOp.br_if, 1, // j >= nLen → break
              
              // Compare haystack[4+i+j] vs needle[4+j]
              WasmOp.local_get, 0, // haystack
              WasmOp.i32_const, 4,
              WasmOp.i32_add,
              WasmOp.local_get, 4, // i
              WasmOp.i32_add,
              WasmOp.local_get, 5, // j
              WasmOp.i32_add,
              WasmOp.i32_load8_u, 0, 0,
              
              WasmOp.local_get, 1, // needle
              WasmOp.i32_const, 4,
              WasmOp.i32_add,
              WasmOp.local_get, 5, // j
              WasmOp.i32_add,
              WasmOp.i32_load8_u, 0, 0,
              
              WasmOp.i32_ne,
              WasmOp.if_, 0x40,
                WasmOp.i32_const, 0,
                WasmOp.local_set, 6, // matched = 0
                WasmOp.br, 2, // break inner
              WasmOp.end,
              
              // j++
              WasmOp.local_get, 5,
              WasmOp.i32_const, 1,
              WasmOp.i32_add,
              WasmOp.local_set, 5,
              WasmOp.br, 0, // continue inner
            WasmOp.end,
          WasmOp.end,
          
          // if matched, return i
          WasmOp.local_get, 6,
          WasmOp.if_, 0x40,
            WasmOp.local_get, 4,
            WasmOp.return_,
          WasmOp.end,
          
          // i++
          WasmOp.local_get, 4,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 4,
          WasmOp.br, 0, // continue outer
        WasmOp.end,
      WasmOp.end,
      
      // Not found: return -1
      ...encodeSLEB128(-1).reduce((acc, _) => acc, []),
      WasmOp.i32_const, ...encodeSLEB128(-1),
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 5, type: WASM_TYPE.I32 } // hLen, nLen, i, j, matched
    ], body2);
    this._indexOfFuncIdx = funcIdx;
    return funcIdx;
  }

  // __int_to_str(n: i32) -> str_ptr: i32
  // Converts an integer to its string representation
  _getIntToStringFunc() {
    if (this._intToStrFuncIdx !== null) return this._intToStrFuncIdx;
    
    const allocIdx = this._getAllocFunc();
    const typeIdx = this.module.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=n. Locals: 1=isNeg, 2=abs, 3=digitCount, 4=temp, 5=newPtr, 6=i
    // Algorithm:
    //   1. Handle negative: isNeg = n < 0; abs = isNeg ? -n : n
    //   2. Count digits by dividing by 10
    //   3. Allocate string: 4 + digitCount + isNeg
    //   4. Fill digits from right to left
    //   5. Add '-' if negative
    const body = [
      // isNeg = (n < 0) ? 1 : 0
      WasmOp.local_get, 0,
      WasmOp.i32_const, 0,
      WasmOp.i32_lt_s,
      WasmOp.local_set, 1,
      
      // abs = isNeg ? (0 - n) : n
      WasmOp.local_get, 1,
      WasmOp.if_, 0x7F,
        WasmOp.i32_const, 0,
        WasmOp.local_get, 0,
        WasmOp.i32_sub,
      WasmOp.else_,
        WasmOp.local_get, 0,
      WasmOp.end,
      WasmOp.local_set, 2, // abs
      
      // Handle 0 specially
      WasmOp.local_get, 2,
      WasmOp.i32_eqz,
      WasmOp.if_, 0x40,
        // Allocate "0": [1, 0, 0, 0, '0']
        WasmOp.i32_const, 5,
        WasmOp.call, ...encodeULEB128(allocIdx),
        WasmOp.local_set, 5,
        WasmOp.local_get, 5,
        WasmOp.i32_const, 1,
        WasmOp.i32_store, 2, 0,
        WasmOp.local_get, 5,
        WasmOp.i32_const, ...encodeSLEB128(48), // '0'
        WasmOp.i32_store8, 0, 4,
        WasmOp.local_get, 5,
        WasmOp.return_,
      WasmOp.end,
      
      // Count digits
      WasmOp.i32_const, 0,
      WasmOp.local_set, 3, // digitCount = 0
      WasmOp.local_get, 2,
      WasmOp.local_set, 4, // temp = abs
      WasmOp.block, 0x40,
      WasmOp.loop, 0x40,
        WasmOp.local_get, 4,
        WasmOp.i32_eqz,
        WasmOp.br_if, 1,
        WasmOp.local_get, 3,
        WasmOp.i32_const, 1,
        WasmOp.i32_add,
        WasmOp.local_set, 3,
        WasmOp.local_get, 4,
        WasmOp.i32_const, 10,
        WasmOp.i32_div_u,
        WasmOp.local_set, 4,
        WasmOp.br, 0,
      WasmOp.end,
      WasmOp.end,
      
      // Total length = digitCount + isNeg
      // Allocate: 4 + totalLen
      WasmOp.local_get, 3,
      WasmOp.local_get, 1,
      WasmOp.i32_add,
      WasmOp.local_tee, 6, // total length
      WasmOp.i32_const, 4,
      WasmOp.i32_add,
      WasmOp.call, ...encodeULEB128(allocIdx),
      WasmOp.local_set, 5, // newPtr
      
      // Store string length
      WasmOp.local_get, 5,
      WasmOp.local_get, 6, // total length
      WasmOp.i32_store, 2, 0,
      
      // Fill digits from right to left
      // i = totalLen - 1
      WasmOp.local_get, 6,
      WasmOp.i32_const, 1,
      WasmOp.i32_sub,
      WasmOp.local_set, 6, // i = totalLen - 1
      WasmOp.local_get, 2,
      WasmOp.local_set, 4, // temp = abs
      WasmOp.block, 0x40,
      WasmOp.loop, 0x40,
        WasmOp.local_get, 4,
        WasmOp.i32_eqz,
        WasmOp.br_if, 1,
        // newPtr[4 + i] = '0' + (temp % 10)
        WasmOp.local_get, 5,
        WasmOp.i32_const, 4,
        WasmOp.i32_add,
        WasmOp.local_get, 6,
        WasmOp.i32_add,
        WasmOp.local_get, 4,
        WasmOp.i32_const, 10,
        WasmOp.i32_rem_u,
        WasmOp.i32_const, ...encodeSLEB128(48), // '0'
        WasmOp.i32_add,
        WasmOp.i32_store8, 0, 0,
        // temp /= 10
        WasmOp.local_get, 4,
        WasmOp.i32_const, 10,
        WasmOp.i32_div_u,
        WasmOp.local_set, 4,
        // i--
        WasmOp.local_get, 6,
        WasmOp.i32_const, 1,
        WasmOp.i32_sub,
        WasmOp.local_set, 6,
        WasmOp.br, 0,
      WasmOp.end,
      WasmOp.end,
      
      // If negative, add '-' at position 0
      WasmOp.local_get, 1,
      WasmOp.if_, 0x40,
        WasmOp.local_get, 5,
        WasmOp.i32_const, ...encodeSLEB128(45), // '-'
        WasmOp.i32_store8, 0, 4,
      WasmOp.end,
      
      // return newPtr
      WasmOp.local_get, 5,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 6, type: WASM_TYPE.I32 }
    ], body);
    this._intToStrFuncIdx = funcIdx;
    return funcIdx;
  }

  // __hash_new(capacity: i32) -> ptr: i32
  // Allocates a new hash map with given capacity (must be power of 2)
  // Layout: [capacity:i32][size:i32][entries: capacity * 16 bytes each]
  // Entry: [occupied:i32][key:i32][value:i32][pad:i32]
  _getHashNewFunc() {
    if (this._hashNewFuncIdx !== null) return this._hashNewFuncIdx;
    
    const allocIdx = this._getAllocFunc();
    const typeIdx = this.module.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=capacity. Locals: 1=ptr, 2=totalSize, 3=i
    const body = [
      // totalSize = 8 + capacity * 16
      WasmOp.local_get, 0,
      WasmOp.i32_const, 16,
      WasmOp.i32_mul,
      WasmOp.i32_const, 8,
      WasmOp.i32_add,
      WasmOp.local_set, 2,
      
      // ptr = __alloc(totalSize)
      WasmOp.local_get, 2,
      WasmOp.call, ...encodeULEB128(allocIdx),
      WasmOp.local_set, 1,
      
      // Store capacity
      WasmOp.local_get, 1,
      WasmOp.local_get, 0,
      WasmOp.i32_store, 2, 0,
      
      // Store size = 0
      WasmOp.local_get, 1,
      WasmOp.i32_const, 0,
      WasmOp.i32_store, 2, 4,
      
      // Zero all entries (set occupied=0 for each)
      WasmOp.i32_const, 0,
      WasmOp.local_set, 3,
      WasmOp.block, 0x40,
      WasmOp.loop, 0x40,
        WasmOp.local_get, 3,
        WasmOp.local_get, 0,
        WasmOp.i32_ge_u,
        WasmOp.br_if, 1,
        // entries[i].occupied = 0
        WasmOp.local_get, 1,
        WasmOp.i32_const, 8,
        WasmOp.i32_add,
        WasmOp.local_get, 3,
        WasmOp.i32_const, 16,
        WasmOp.i32_mul,
        WasmOp.i32_add,
        WasmOp.i32_const, 0,
        WasmOp.i32_store, 2, 0,
        WasmOp.local_get, 3,
        WasmOp.i32_const, 1,
        WasmOp.i32_add,
        WasmOp.local_set, 3,
        WasmOp.br, 0,
      WasmOp.end,
      WasmOp.end,
      
      // return ptr
      WasmOp.local_get, 1,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 3, type: WASM_TYPE.I32 }
    ], body);
    this._hashNewFuncIdx = funcIdx;
    return funcIdx;
  }

  // __hash_set(map_ptr: i32, key: i32, value: i32)
  // Inserts or updates a key-value pair. Uses integer keys with multiplicative hash.
  _getHashSetFunc() {
    if (this._hashSetFuncIdx !== null) return this._hashSetFuncIdx;
    
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32, WASM_TYPE.I32], []);
    
    // Params: 0=mapPtr, 1=key, 2=value
    // Locals: 3=capacity, 4=hash, 5=idx, 6=entryPtr, 7=occupied
    const body = [
      // capacity = load(mapPtr)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 3,
      
      // hash = key * 2654435769 (golden ratio hash)
      WasmOp.local_get, 1,
      WasmOp.i32_const, ...encodeSLEB128(0x9E3779B9 | 0), // signed encoding of 2654435769
      WasmOp.i32_mul,
      WasmOp.local_set, 4,
      
      // idx = (hash >>> 16) & (capacity - 1)
      WasmOp.local_get, 4,
      WasmOp.i32_const, 16,
      WasmOp.i32_shr_u,
      WasmOp.local_get, 3,
      WasmOp.i32_const, 1,
      WasmOp.i32_sub,
      WasmOp.i32_and,
      WasmOp.local_set, 5,
      
      // Linear probe loop
      WasmOp.block, 0x40,
      WasmOp.loop, 0x40,
        // entryPtr = mapPtr + 8 + idx * 16
        WasmOp.local_get, 0,
        WasmOp.i32_const, 8,
        WasmOp.i32_add,
        WasmOp.local_get, 5,
        WasmOp.i32_const, 16,
        WasmOp.i32_mul,
        WasmOp.i32_add,
        WasmOp.local_set, 6,
        
        // occupied = load(entryPtr)
        WasmOp.local_get, 6,
        WasmOp.i32_load, 2, 0,
        WasmOp.local_set, 7,
        
        // If empty (occupied == 0): insert here
        WasmOp.local_get, 7,
        WasmOp.i32_eqz,
        WasmOp.if_, 0x40,
          // Set occupied = 1
          WasmOp.local_get, 6,
          WasmOp.i32_const, 1,
          WasmOp.i32_store, 2, 0,
          // Set key
          WasmOp.local_get, 6,
          WasmOp.local_get, 1,
          WasmOp.i32_store, 2, 4,
          // Set value
          WasmOp.local_get, 6,
          WasmOp.local_get, 2,
          WasmOp.i32_store, 2, 8,
          // Increment size
          WasmOp.local_get, 0,
          WasmOp.local_get, 0,
          WasmOp.i32_load, 2, 4,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.i32_store, 2, 4,
          WasmOp.return_,
        WasmOp.end,
        
        // If occupied and key matches: update value
        WasmOp.local_get, 7,
        WasmOp.i32_const, 1,
        WasmOp.i32_eq,
        WasmOp.local_get, 6,
        WasmOp.i32_load, 2, 4, // stored key
        WasmOp.local_get, 1, // search key
        WasmOp.i32_eq,
        WasmOp.i32_and,
        WasmOp.if_, 0x40,
          WasmOp.local_get, 6,
          WasmOp.local_get, 2,
          WasmOp.i32_store, 2, 8,
          WasmOp.return_,
        WasmOp.end,
        
        // Else: linear probe — idx = (idx + 1) & (capacity - 1)
        WasmOp.local_get, 5,
        WasmOp.i32_const, 1,
        WasmOp.i32_add,
        WasmOp.local_get, 3,
        WasmOp.i32_const, 1,
        WasmOp.i32_sub,
        WasmOp.i32_and,
        WasmOp.local_set, 5,
        WasmOp.br, 0,
      WasmOp.end,
      WasmOp.end,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 5, type: WASM_TYPE.I32 }
    ], body);
    this._hashSetFuncIdx = funcIdx;
    return funcIdx;
  }

  // __hash_get(map_ptr: i32, key: i32) -> value: i32
  // Looks up a key. Returns 0 if not found.
  _getHashGetFunc() {
    if (this._hashGetFuncIdx !== null) return this._hashGetFuncIdx;
    
    const typeIdx = this.module.addType([WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Params: 0=mapPtr, 1=key
    // Locals: 2=capacity, 3=hash, 4=idx, 5=entryPtr, 6=occupied
    const body = [
      // capacity = load(mapPtr)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 2,
      
      // hash = key * golden_ratio
      WasmOp.local_get, 1,
      WasmOp.i32_const, ...encodeSLEB128(0x9E3779B9 | 0),
      WasmOp.i32_mul,
      WasmOp.local_set, 3,
      
      // idx = (hash >>> 16) & (capacity - 1)
      WasmOp.local_get, 3,
      WasmOp.i32_const, 16,
      WasmOp.i32_shr_u,
      WasmOp.local_get, 2,
      WasmOp.i32_const, 1,
      WasmOp.i32_sub,
      WasmOp.i32_and,
      WasmOp.local_set, 4,
      
      // Linear probe
      WasmOp.block, 0x40,
      WasmOp.loop, 0x40,
        WasmOp.local_get, 0,
        WasmOp.i32_const, 8,
        WasmOp.i32_add,
        WasmOp.local_get, 4,
        WasmOp.i32_const, 16,
        WasmOp.i32_mul,
        WasmOp.i32_add,
        WasmOp.local_set, 5,
        
        WasmOp.local_get, 5,
        WasmOp.i32_load, 2, 0,
        WasmOp.local_set, 6,
        
        // If empty: not found
        WasmOp.local_get, 6,
        WasmOp.i32_eqz,
        WasmOp.if_, 0x40,
          WasmOp.i32_const, 0,
          WasmOp.return_,
        WasmOp.end,
        
        // If occupied and key matches: return value
        WasmOp.local_get, 6,
        WasmOp.i32_const, 1,
        WasmOp.i32_eq,
        WasmOp.local_get, 5,
        WasmOp.i32_load, 2, 4,
        WasmOp.local_get, 1,
        WasmOp.i32_eq,
        WasmOp.i32_and,
        WasmOp.if_, 0x40,
          WasmOp.local_get, 5,
          WasmOp.i32_load, 2, 8,
          WasmOp.return_,
        WasmOp.end,
        
        // Linear probe
        WasmOp.local_get, 4,
        WasmOp.i32_const, 1,
        WasmOp.i32_add,
        WasmOp.local_get, 2,
        WasmOp.i32_const, 1,
        WasmOp.i32_sub,
        WasmOp.i32_and,
        WasmOp.local_set, 4,
        WasmOp.br, 0,
      WasmOp.end,
      WasmOp.end,
      
      // Unreachable (infinite loop guaranteed to find empty slot)
      WasmOp.i32_const, 0,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 5, type: WASM_TYPE.I32 }
    ], body);
    this._hashGetFuncIdx = funcIdx;
    return funcIdx;
  }

  // Ensure memory exists and heap pointer global is initialized
  _ensureMemory() {
    if (this._needsMemory) return;
    this._needsMemory = true;
    if (!this.module.memory) {
      this.module.addMemory(1); // 1 page = 64KB
    }
  }

  // Get the heap base global index (lazily created)
  _getHeapBaseGlobal() {
    if (this._heapBaseGlobal === null) {
      this._ensureMemory();
      // Heap starts at 4096 (leave room for data segments below)
      // We'll fix this up later based on actual data segment usage
      this._heapBaseGlobal = this.module.addGlobal(WASM_TYPE.I32, true, 4096);
    }
    return this._heapBaseGlobal;
  }

  // Get the __alloc function index (bump allocator)
  // __alloc(size: i32) -> ptr: i32
  // Bumps heap pointer by size (aligned to 4), returns old pointer
  _getAllocFunc() {
    if (this._allocFuncIdx !== null) return this._allocFuncIdx;
    
    const heapGlobal = this._getHeapBaseGlobal();
    const typeIdx = this.module.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Function body:
    //   local $ptr i32, $new_top i32
    //   ptr = heap_base
    //   new_top = align4(heap_base + size)
    //   // Grow memory if needed
    //   while (new_top > memory.size * 65536) { memory.grow(1) }
    //   heap_base = new_top
    //   return ptr
    const body = [
      // ptr = heap_base
      WasmOp.global_get, ...encodeULEB128(heapGlobal),
      WasmOp.local_set, 1, // local 1 = $ptr
      
      // new_top = align4(heap_base + size)
      WasmOp.global_get, ...encodeULEB128(heapGlobal),
      WasmOp.local_get, 0, // size param
      WasmOp.i32_add,
      WasmOp.i32_const, 3,
      WasmOp.i32_add,
      WasmOp.i32_const, ...encodeSLEB128(-4), // 0xFFFFFFFC
      WasmOp.i32_and,
      WasmOp.local_set, 2, // local 2 = $new_top
      
      // Grow memory loop: while (new_top > memory.size * 65536) { memory.grow(1) }
      WasmOp.block, 0x40,
        WasmOp.loop, 0x40,
          // if new_top <= memory.size * 65536, break
          WasmOp.local_get, 2,
          WasmOp.memory_size, 0, // memory.size (returns pages)
          WasmOp.i32_const, ...encodeSLEB128(65536),
          WasmOp.i32_mul,
          WasmOp.i32_le_u,
          WasmOp.br_if, 1, // break out of block
          
          // memory.grow(1) — grow by 1 page (64KB)
          WasmOp.i32_const, 1,
          WasmOp.memory_grow, 0,
          // If grow returns -1, we're out of memory — just continue and let it trap
          WasmOp.drop,
          
          WasmOp.br, 0, // continue loop
        WasmOp.end,
      WasmOp.end,
      
      // heap_base = new_top
      WasmOp.local_get, 2,
      WasmOp.global_set, ...encodeULEB128(heapGlobal),
      
      // return ptr
      WasmOp.local_get, 1,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [{ count: 2, type: WASM_TYPE.I32 }], body);
    this._allocFuncIdx = funcIdx;
    return funcIdx;
  }

  // Get the __array_ensure_cap function index (lazily created)
  // __array_ensure_cap(ptr: i32) -> new_ptr: i32
  // If len >= cap, allocates a new array with 2x capacity, copies data, returns new ptr.
  // Otherwise returns the original ptr unchanged.
  _getArrayEnsureCapFunc() {
    if (this._ensureCapFuncIdx !== null) return this._ensureCapFuncIdx;
    
    const allocIdx = this._getAllocFunc();
    const typeIdx = this.module.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    
    // Locals: param0=ptr, local1=len, local2=cap, local3=newCap, local4=newPtr, local5=i
    // Function body:
    //   len = i32.load(ptr)        // ptr+0 = length
    //   cap = i32.load(ptr, 4)     // ptr+4 = capacity
    //   if (len < cap) return ptr  // fast path: capacity available
    //   newCap = cap * 2
    //   if (newCap < 8) newCap = 8 // minimum capacity
    //   newPtr = __alloc(8 + newCap * 4)
    //   store len at newPtr+0, newCap at newPtr+4
    //   copy elements from ptr+8 to newPtr+8 (len * 4 bytes)
    //   return newPtr
    const body = [
      // len = load(ptr+0)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 0,
      WasmOp.local_set, 1,
      
      // cap = load(ptr+4)
      WasmOp.local_get, 0,
      WasmOp.i32_load, 2, 4,
      WasmOp.local_set, 2,
      
      // if (len < cap) return ptr (fast path)
      WasmOp.local_get, 1,
      WasmOp.local_get, 2,
      WasmOp.i32_lt_u,
      WasmOp.if_, 0x40, // void block
        WasmOp.local_get, 0,
        WasmOp.return_,
      WasmOp.end,
      
      // newCap = cap * 2
      WasmOp.local_get, 2,
      WasmOp.i32_const, 2,
      WasmOp.i32_mul,
      WasmOp.local_set, 3,
      
      // if (newCap < 8) newCap = 8
      WasmOp.local_get, 3,
      WasmOp.i32_const, 8,
      WasmOp.i32_lt_u,
      WasmOp.if_, 0x40,
        WasmOp.i32_const, 8,
        WasmOp.local_set, 3,
      WasmOp.end,
      
      // newPtr = __alloc(8 + newCap * 4)
      WasmOp.local_get, 3,
      WasmOp.i32_const, 4,
      WasmOp.i32_mul,
      WasmOp.i32_const, 8,
      WasmOp.i32_add,
      WasmOp.call, ...encodeULEB128(allocIdx),
      WasmOp.local_set, 4,
      
      // store len at newPtr+0
      WasmOp.local_get, 4,
      WasmOp.local_get, 1,
      WasmOp.i32_store, 2, 0,
      
      // store newCap at newPtr+4
      WasmOp.local_get, 4,
      WasmOp.local_get, 3,
      WasmOp.i32_store, 2, 4,
      
      // copy loop: i = 0; while (i < len) { newPtr[8+i*4] = ptr[8+i*4]; i++ }
      WasmOp.i32_const, 0,
      WasmOp.local_set, 5, // i = 0
      
      WasmOp.block, 0x40,  // outer block (break target)
        WasmOp.loop, 0x40, // loop
          // break if i >= len
          WasmOp.local_get, 5,
          WasmOp.local_get, 1,
          WasmOp.i32_ge_u,
          WasmOp.br_if, 1,
          
          // newPtr + 8 + i*4
          WasmOp.local_get, 4,
          WasmOp.i32_const, 8,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_const, 4,
          WasmOp.i32_mul,
          WasmOp.i32_add,
          
          // load from ptr + 8 + i*4
          WasmOp.local_get, 0,
          WasmOp.i32_const, 8,
          WasmOp.i32_add,
          WasmOp.local_get, 5,
          WasmOp.i32_const, 4,
          WasmOp.i32_mul,
          WasmOp.i32_add,
          WasmOp.i32_load, 2, 0,
          
          // store
          WasmOp.i32_store, 2, 0,
          
          // i++
          WasmOp.local_get, 5,
          WasmOp.i32_const, 1,
          WasmOp.i32_add,
          WasmOp.local_set, 5,
          
          WasmOp.br, 0, // continue loop
        WasmOp.end,
      WasmOp.end,
      
      // return newPtr
      WasmOp.local_get, 4,
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [
      { count: 5, type: WASM_TYPE.I32 } // len, cap, newCap, newPtr, i
    ], body);
    this._ensureCapFuncIdx = funcIdx;
    return funcIdx;
  }

  // Infer the type of an expression at compile time
  _inferExprType(expr) {
    if (!expr) return 'unknown';
    if (expr instanceof ast.StringLiteral) return 'string';
    if (expr instanceof ast.IntegerLiteral) return 'int';
    if (expr instanceof ast.FloatLiteral) return 'int'; // treated as numeric
    if (expr instanceof ast.BooleanLiteral) return 'int';
    if (expr instanceof ast.ArrayLiteral) return 'array';
    if (expr instanceof ast.ArrayComprehension) return 'array';
    if (expr instanceof ast.HashLiteral) return 'hash';
    if (expr instanceof ast.Identifier) {
      // Check local type map first, then global
      const localType = this.currentVarTypes?.get(expr.value);
      if (localType) return localType;
      const globalType = this.varTypes.get(expr.value);
      if (globalType) return globalType;
      return 'unknown';
    }
    if (expr instanceof ast.InfixExpression) {
      if (expr.operator === '+') {
        const leftType = this._inferExprType(expr.left);
        const rightType = this._inferExprType(expr.right);
        if (leftType === 'string' || rightType === 'string') return 'string';
        return 'int';
      }
      // Comparison operators return int
      if ('== != < > <= >='.includes(expr.operator)) return 'int';
      return 'int';
    }
    if (expr instanceof ast.CallExpression) {
      // Built-in functions that return known types
      if (expr.function instanceof ast.Identifier) {
        const name = expr.function.value;
        if (name === 'len') return 'int';
        if (name === 'push') return 'int';
        if (name === 'indexOf') return 'int';
        if (name === 'map' || name === 'filter' || name === 'split') return 'array';
        if (name === 'charAt' || name === 'substring' || name === 'toUpperCase' || name === 'toLowerCase' || name === 'replace' || name === 'trim' || name === 'intToString') return 'string';
      }
      return 'unknown';
    }
    if (expr instanceof ast.IfExpression) {
      // Could be either type — check consequence
      if (expr.consequence?.statements?.length > 0) {
        const lastStmt = expr.consequence.statements[expr.consequence.statements.length - 1];
        if (lastStmt.expression) return this._inferExprType(lastStmt.expression);
      }
      return 'unknown';
    }
    return 'unknown';
  }

  // Check if an expression is known to produce a string value
  _isStringExpr(expr) {
    return this._inferExprType(expr) === 'string';
  }

  // Heuristic type inference for function parameters.
  // Scans the function body for patterns that reveal parameter types.
  _inferParamTypes(fnLit) {
    const paramNames = new Set(fnLit.parameters.map(p => p.value));
    if (paramNames.size === 0) return;
    
    const self = this;
    function scan(node) {
      if (!node) return;
      
      // Pattern: param + "string" or "string" + param → param is string
      if (node instanceof ast.InfixExpression && node.operator === '+') {
        if (node.left instanceof ast.Identifier && paramNames.has(node.left.value) &&
            self._inferExprType(node.right) === 'string') {
          self.currentVarTypes.set(node.left.value, 'string');
        }
        if (node.right instanceof ast.Identifier && paramNames.has(node.right.value) &&
            self._inferExprType(node.left) === 'string') {
          self.currentVarTypes.set(node.right.value, 'string');
        }
      }
      
      // Pattern: param == "string" or "string" == param → param is string
      if (node instanceof ast.InfixExpression && (node.operator === '==' || node.operator === '!=')) {
        if (node.left instanceof ast.Identifier && paramNames.has(node.left.value) &&
            self._inferExprType(node.right) === 'string') {
          self.currentVarTypes.set(node.left.value, 'string');
        }
        if (node.right instanceof ast.Identifier && paramNames.has(node.right.value) &&
            self._inferExprType(node.left) === 'string') {
          self.currentVarTypes.set(node.right.value, 'string');
        }
      }
      
      // Recursively scan all child nodes
      for (const key of Object.keys(node)) {
        if (key === 'token') continue; // skip token objects
        const val = node[key];
        if (val && typeof val === 'object') {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object') scan(item);
            }
          } else if (val.constructor && !val.constructor.name.startsWith('Token')) {
            scan(val);
          }
        }
      }
    }
    
    scan(fnLit.body);
  }

  // Infer function parameter types from call sites in the program.
  // If greet(a, b) is called and a is known to be string, mark greet's first param as string.
  _inferCallSiteTypes(statements) {
    // Map function names to their parameter lists
    const funcParams = new Map(); // funcName → [paramName, ...]
    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        funcParams.set(stmt.name.value, stmt.value.parameters.map(p => p.value));
      }
    }
    
    // Scan all statements for call expressions
    const self = this;
    function scanForCalls(node) {
      if (!node) return;
      
      if (node instanceof ast.CallExpression && node.function instanceof ast.Identifier) {
        const funcName = node.function.value;
        const params = funcParams.get(funcName);
        if (params && node.arguments) {
          for (let i = 0; i < Math.min(params.length, node.arguments.length); i++) {
            const argType = self._inferExprType(node.arguments[i]);
            if (argType === 'string') {
              // Store inferred parameter type on the function's info
              if (!self._funcParamTypes) self._funcParamTypes = new Map();
              const key = `${funcName}:${params[i]}`;
              self._funcParamTypes.set(key, 'string');
            }
          }
        }
      }
      
      // Recurse
      for (const key of Object.keys(node)) {
        if (key === 'token') continue;
        const val = node[key];
        if (val && typeof val === 'object') {
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object') scanForCalls(item);
            }
          } else {
            scanForCalls(val);
          }
        }
      }
    }
    
    for (const stmt of statements) {
      scanForCalls(stmt);
    }
  }

  _processGlobals(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && !(stmt.value instanceof ast.FunctionLiteral)) {
        const name = stmt.name.value;
        // Create a mutable global for this variable
        const idx = this.module.addGlobal(this.numType, true, 0);
        this.globals.set(name, { index: idx, mutable: true });
        // Pre-record variable type for call-site analysis
        const inferredType = this._inferExprType(stmt.value);
        this.varTypes.set(name, inferredType);
      }
    }
  }

  _initializeGlobals(statements) {
    const initBody = [];
    let hasInits = false;

    // Set up context for expression compilation
    this.currentLocals = new Map();
    this.currentVarTypes = new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;

    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && !(stmt.value instanceof ast.FunctionLiteral)) {
        const name = stmt.name.value;
        const global = this.globals.get(name);
        if (global) {
          this._compileExpr(stmt.value, initBody);
          initBody.push(WasmOp.global_set, ...encodeULEB128(global.index));
          hasInits = true;
        }
      }
    }

    if (hasInits) {
      const typeIdx = this.module.addType([], []);
      const locals = this.currentExtraLocals > 0
        ? [{ count: this.currentExtraLocals, type: this.numType }]
        : [];
      const funcIdx = this.module.addFunction(typeIdx, locals, initBody);
      this._initFuncIdx = funcIdx;
    }
    
    this.currentLocals = null;
  }
  
  _processImports(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ast.ImportStatement) {
        const moduleName = stmt.moduleName;
        if (stmt.bindings) {
          // import "math" for add, multiply;
          // Each binding becomes a WASM import: (import "math" "add" (func ...))
          // We assume each imported function takes numType params and returns numType
          // The caller can override via import metadata later
          for (const binding of stmt.bindings) {
            // Default: assume single-param, single-result (overridable via importSignatures)
            const sig = (this.importSignatures && this.importSignatures[`${moduleName}.${binding}`]) ||
                        { params: [this.numType], results: [this.numType] };
            const funcIdx = this.module.addImport(moduleName, binding, sig.params, sig.results);
            this.functions.set(binding, { index: funcIdx, params: sig.params.length, imported: true });
          }
        } else if (stmt.alias) {
          // import "math" as math; — namespace import (store module name for qualified calls)
          // Not directly supported in WASM linking, skip for now
        }
      }
    }
  }

  _collectFunctions(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        const name = stmt.name.value;
        const fn = stmt.value;
        const paramCount = fn.parameters.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        // Reserve function index: imports + internal funcs (__alloc etc) + user funcs so far
        const funcIdx = this.module.imports.length + this.module.functions.length + this._localFunctionCount();
        // Add to table for indirect calling (higher-order functions)
        const tableIdx = this.module.addTableElement(funcIdx);
        this.functions.set(name, { index: funcIdx, params: paramCount, typeIdx, tableIdx });
      }
    }
    
    // Scan all statements for inline FunctionLiteral nodes (not assigned to let)
    this._scanForAnonymousFunctions(statements);
  }
  
  _scanForAnonymousFunctions(nodes) {
    const scan = (node) => {
      if (!node) return;
      if (node instanceof ast.FunctionLiteral && !this._anonMap.has(node)) {
        // Check if this is already a named function (assigned via let)
        // Named functions are handled above, so we only catch inline ones
        const name = `__anon_${this._anonCounter++}`;
        const paramCount = node.parameters.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        const funcIdx = this.module.imports.length + this.module.functions.length + this._localFunctionCount();
        const tableIdx = this.module.addTableElement(funcIdx);
        this.functions.set(name, { index: funcIdx, params: paramCount, typeIdx, tableIdx });
        this._anonMap.set(node, name);
        this._anonFunctions.push({ name, fnLit: node });
        
        // Also scan inside the anonymous function body
        if (node.body) scan(node.body);
        return;
      }
      // Recursively scan child nodes
      if (node.statements) node.statements.forEach(s => scan(s));
      if (node.expression) scan(node.expression);
      if (node.value) scan(node.value);
      if (node.returnValue) scan(node.returnValue);
      if (node.consequence) scan(node.consequence);
      if (node.alternative) scan(node.alternative);
      if (node.body) scan(node.body);
      if (node.left) scan(node.left);
      if (node.right) scan(node.right);
      if (node.arguments) node.arguments.forEach(a => scan(a));
      if (node.elements) node.elements.forEach(e => scan(e));
      if (node.condition) scan(node.condition);
      if (node.init) scan(node.init);
      if (node.update) scan(node.update);
      if (node.index) scan(node.index);
      if (node.function) scan(node.function);
    };
    for (const node of nodes) scan(node);
  }
  
  _compileFunction(name, fnLit) {
    const info = this.functions.get(name);
    
    // Set up local scope
    this.currentLocals = new Map();
    this.currentVarTypes = new Map();
    this.currentLocalCount = fnLit.parameters.length;
    this.currentExtraLocals = 0;
    
    // Parameters are locals 0..N-1
    for (let i = 0; i < fnLit.parameters.length; i++) {
      this.currentLocals.set(fnLit.parameters[i].value, i);
    }
    
    // Heuristic type inference for parameters:
    // 1. From call-site analysis (pass 1.5)
    if (this._funcParamTypes) {
      for (let i = 0; i < fnLit.parameters.length; i++) {
        const paramName = fnLit.parameters[i].value;
        const key = `${name}:${paramName}`;
        if (this._funcParamTypes.has(key)) {
          this.currentVarTypes.set(paramName, this._funcParamTypes.get(key));
        }
      }
    }
    // 2. From body usage patterns (heuristic scan)
    this._inferParamTypes(fnLit);
    
    // Compile function body
    const body = [];
    const stmts = fnLit.body.statements;
    
    if (stmts.length === 0) {
      // Empty body: return 0 (null equivalent)
      this._emitConst(body, 0);
    } else {
      for (let i = 0; i < stmts.length; i++) {
        const isLast = i === stmts.length - 1;
        this._compileStatement(stmts[i], body, isLast);
      }
    }
    
    // Build locals declaration
    const locals = this.currentExtraLocals > 0
      ? [{ count: this.currentExtraLocals, type: this.numType }]
      : [];
    
    // Add to module
    this.module.addFunction(info.typeIdx, locals, body);
    this.module.exportFunction(name, info.index);
    
    this.currentLocals = null;
  }
  
  _compileMainBlock(statements) {
    const typeIdx = this.module.addType([], [this.numType]);
    this.currentLocals = new Map();
    this.currentVarTypes = new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    
    const body = [];
    
    for (let i = 0; i < statements.length; i++) {
      const isLast = i === statements.length - 1;
      this._compileStatement(statements[i], body, isLast);
    }
    
    const locals = this.currentExtraLocals > 0
      ? [{ count: this.currentExtraLocals, type: this.numType }]
      : [];
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, locals, body);
    this.module.exportFunction('main', funcIdx);
  }
  
  _compileStatement(stmt, body, isLast) {
    if (stmt instanceof ast.ReturnStatement) {
      this._compileExpr(stmt.returnValue, body);
      body.push(WasmOp.return_);
    } else if (stmt instanceof ast.LetStatement) {
      const name = stmt.name.value;
      // Track variable type
      const inferredType = this._inferExprType(stmt.value);
      if (this.globals.has(name)) {
        this.varTypes.set(name, inferredType);
      } else if (this.currentVarTypes) {
        this.currentVarTypes.set(name, inferredType);
      }
      // Check if this is a global variable (top-level let)
      if (this.globals.has(name)) {
        this._compileExpr(stmt.value, body);
        body.push(WasmOp.global_set, ...encodeULEB128(this.globals.get(name).index));
        if (isLast) {
          body.push(WasmOp.global_get, ...encodeULEB128(this.globals.get(name).index));
        }
      } else {
        // Allocate a local for this variable (inside a function)
        const localIdx = this.currentLocalCount + this.currentExtraLocals;
        this.currentExtraLocals++;
        this.currentLocals.set(name, localIdx);
        
        this._compileExpr(stmt.value, body);
        body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
        
        // If this is the last statement and we need a return value, push the local
        if (isLast) {
          body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
        }
      }
    } else if (stmt instanceof ast.BreakStatement) {
      // Break: exit the loop's outer block
      // depth 0 = current nesting, +1 for each if/block, +1 more for outer block
      body.push(WasmOp.br, ...encodeULEB128(this._blockDepthInLoop + 1));
    } else if (stmt instanceof ast.ContinueStatement) {
      // Continue: go to loop header
      body.push(WasmOp.br, ...encodeULEB128(this._blockDepthInLoop));
    } else if (stmt instanceof ast.SetStatement) {
      // Array/indexed assignment: set arr[i] = value
      if (stmt.name instanceof ast.IndexExpression) {
        // Detect hash map vs array
        const leftType = this._inferExprType(stmt.name.left);
        if (leftType === 'hash') {
          // Hash set: __hash_set(map, key, value)
          const hashSetIdx = this._getHashSetFunc();
          this._compileExpr(stmt.name.left, body);
          if (this.useI64) body.push(WasmOp.i32_wrap_i64);
          this._compileExpr(stmt.name.index, body);
          if (this.useI64) body.push(WasmOp.i32_wrap_i64);
          this._compileExpr(stmt.value, body);
          if (this.useI64) body.push(WasmOp.i32_wrap_i64);
          body.push(WasmOp.call, ...encodeULEB128(hashSetIdx));
          if (isLast) {
            this._compileExpr(stmt.value, body);
          }
          return;
        }
        
        // Array set: addr = ptr + 8 + idx * 4, then i32.store
        this._compileExpr(stmt.name.left, body);  // array pointer
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_const, 8); // skip header
        body.push(WasmOp.i32_add);
        this._compileExpr(stmt.name.index, body);  // index
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_const, 4);
        body.push(WasmOp.i32_mul);
        body.push(WasmOp.i32_add);
        // Value to store
        this._compileExpr(stmt.value, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_store, 2, 0);
        if (isLast) {
          // Return the stored value
          this._compileExpr(stmt.value, body);
        }
        return;
      }
      
      // Variable reassignment: set x = value
      const name = stmt.name?.value || (stmt.target?.left?.value);
      const localIdx = this.currentLocals?.get(name);
      if (localIdx !== undefined) {
        this._compileExpr(stmt.value, body);
        body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
        if (isLast) {
          body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
        }
      } else if (this.globals.has(name)) {
        this._compileExpr(stmt.value, body);
        const globalIdx = this.globals.get(name).index;
        body.push(WasmOp.global_set, ...encodeULEB128(globalIdx));
        if (isLast) {
          body.push(WasmOp.global_get, ...encodeULEB128(globalIdx));
        }
      } else {
        throw new Error(`Undefined variable in WASM set: ${name}`);
      }
    } else if (stmt instanceof ast.ExpressionStatement) {
      this._compileExpr(stmt.expression, body);
      // If not the last statement, drop the value
      if (!isLast) {
        body.push(WasmOp.drop);
      }
    }
  }
  
  _emitZero(body) {
    if (this.useF64) {
      this._emitF64Const(body, 0.0);
    } else {
      this._emitConst(body, 0);
    }
  }

  _emitF64Const(body, value) {
    body.push(WasmOp.f64_const);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true); // little-endian
    const bytes = new Uint8Array(buf);
    for (const b of bytes) body.push(b);
  }

  _compileWhile(condition, loopBody, body) {
    body.push(WasmOp.block, 0x40);    // block with void type
    body.push(WasmOp.loop, 0x40);     // loop with void type
    
    // Condition — convert to i32 for br_if
    this._compileExpr(condition, body);
    if (this.useF64) {
      // f64: compare with 0.0, then invert
      this._emitF64Const(body, 0.0);
      body.push(WasmOp.f64_eq);  // produces i32: 1 if condition==0 (false), 0 if non-zero (true)
    } else {
      body.push(this.iop("eqz")); // invert: 1 if condition is 0/false
    }
    body.push(WasmOp.br_if, 1);       // br_if to outer block (break)
    
    // Body
    if (loopBody) {
      const stmts = loopBody.statements;
      for (let i = 0; i < stmts.length; i++) {
        this._compileStatement(stmts[i], body, false);
      }
    }
    
    body.push(WasmOp.br, 0);          // br to loop start (continue)
    body.push(WasmOp.end);            // end loop
    body.push(WasmOp.end);            // end block
  }

  // intToString(n) → converts integer to string representation
  _compileIntToString(numExpr, body) {
    const intToStrIdx = this._getIntToStringFunc();
    
    this._compileExpr(numExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.call, ...encodeULEB128(intToStrIdx));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // replace(str, search, replacement) → new string with first occurrence replaced
  // Uses indexOf to find, then concatenates: prefix + replacement + suffix
  _compileReplace(strExpr, searchExpr, replExpr, body) {
    const allocIdx = this._getAllocFunc();
    const indexOfIdx = this._getIndexOfFunc();
    const concatIdx = this._getStrConcatFunc();
    
    const strLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const searchLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const replLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const posLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const prefixLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const suffixLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const tmpLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const strLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const searchLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    // Evaluate args
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strLocal));
    
    this._compileExpr(searchExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(searchLocal));
    
    this._compileExpr(replExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(replLocal));
    
    // pos = indexOf(str, search)
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(searchLocal));
    body.push(WasmOp.call, ...encodeULEB128(indexOfIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(posLocal));
    
    // If pos < 0, return original string
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_lt_s);
    body.push(WasmOp.if_, 0x40);
      body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      body.push(WasmOp.return_);
    body.push(WasmOp.end);
    
    // Read string and search lengths
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(strLenLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(searchLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(searchLenLocal));
    
    // Create prefix: substring(str, 0, pos)
    // Allocate and copy manually (inline substring)
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(prefixLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(prefixLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_store, 2, 0);
    // Copy bytes
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(prefixLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Create suffix: substring(str, pos+searchLen, strLen)
    // suffixLen = strLen - pos - searchLen
    body.push(WasmOp.local_get, ...encodeULEB128(strLenLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.local_get, ...encodeULEB128(searchLenLocal));
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.local_tee, ...encodeULEB128(tmpLocal)); // suffixLen
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(suffixLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(suffixLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_store, 2, 0);
    // Copy suffix bytes
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(tmpLocal));
    // Compute suffix start offset
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(searchLenLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(strLenLocal)); // reuse as srcStart
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(suffixLocal));
    body.push(WasmOp.i32_load, 2, 0); // suffixLen
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(suffixLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strLenLocal)); // srcStart
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(tmpLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Result = concat(concat(prefix, replacement), suffix)
    body.push(WasmOp.local_get, ...encodeULEB128(prefixLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(replLocal));
    body.push(WasmOp.call, ...encodeULEB128(concatIdx));
    body.push(WasmOp.local_get, ...encodeULEB128(suffixLocal));
    body.push(WasmOp.call, ...encodeULEB128(concatIdx));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // trim(str) — removes leading/trailing ASCII whitespace (space, tab, newline)
  _compileTrim(strExpr, body) {
    const allocIdx = this._getAllocFunc();
    
    const strLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const lenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const startLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const endLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const iLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const byteLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strLocal));
    
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(lenLocal));
    
    // Find start: skip leading whitespace
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(startLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(byteLocal));
    // Check if byte is whitespace (32=' ', 9='\t', 10='\n', 13='\r')
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 32);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 9);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 10);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 13);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.i32_eqz); // NOT whitespace → break
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(startLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Find end: skip trailing whitespace (end = len, work backwards)
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.local_set, ...encodeULEB128(endLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(endLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_le_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(endLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(byteLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 32);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 9);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 10);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_const, 13);
    body.push(WasmOp.i32_eq);
    body.push(WasmOp.i32_or);
    body.push(WasmOp.i32_eqz);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(endLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.local_set, ...encodeULEB128(endLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // newLen = end - start
    body.push(WasmOp.local_get, ...encodeULEB128(endLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.local_set, ...encodeULEB128(newLenLocal));
    
    // Allocate new string
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_store, 2, 0);
    
    // Copy bytes
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // split(str, delim) → array of substrings
  // Implementation: walk through str, find delim positions, extract substrings
  _compileSplit(strExpr, delimExpr, body) {
    const allocIdx = this._getAllocFunc();
    const ensureCapIdx = this._getArrayEnsureCapFunc();
    const indexOfIdx = this._getIndexOfFunc();
    
    // Allocate temp locals
    const strPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const delimPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const strLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const delimLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const arrPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const posLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const startLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const subPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const subLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const arrLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const copyIdx = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    // Evaluate string and delimiter
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strPtrLocal));
    
    this._compileExpr(delimExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(delimPtrLocal));
    
    // Read lengths
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(strLenLocal));
    
    body.push(WasmOp.local_get, ...encodeULEB128(delimPtrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(delimLenLocal));
    
    // Allocate result array: capacity 8, empty
    body.push(WasmOp.i32_const, ...encodeSLEB128(8 * 4 + 8)); // 8 elements capacity
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_store, 2, 0); // len = 0
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_store, 2, 4); // cap = 8
    
    // Initialize: start = 0, pos = 0, arrLen = 0
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(arrLenLocal));
    
    // Main loop: search for delimiter starting from 'start'
    body.push(WasmOp.block, 0x40); // outer break
    body.push(WasmOp.loop, 0x40);  // outer continue
    
    // if start > strLen, break
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(strLenLocal));
    body.push(WasmOp.i32_gt_s);
    body.push(WasmOp.br_if, 1);
    
    // Create a temporary substring from 'start' to search within
    // Actually, use a simpler approach: manually scan for delimiter
    // Find delimiter at current position using byte comparison
    
    // pos = start
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.local_set, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_const, ...encodeSLEB128(-1)); // found = -1
    body.push(WasmOp.local_set, ...encodeULEB128(subLenLocal)); // reuse as "found position"
    
    // Inner loop: search for delimiter from pos
    body.push(WasmOp.block, 0x40); // inner break
    body.push(WasmOp.loop, 0x40);  // inner continue
    
    // if pos + delimLen > strLen, break
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(delimLenLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strLenLocal));
    body.push(WasmOp.i32_gt_s);
    body.push(WasmOp.br_if, 1);
    
    // Check if delimiter matches at pos
    // Compare delimLen bytes starting at str[pos] vs delim[0]
    body.push(WasmOp.i32_const, 1); // assume match
    body.push(WasmOp.local_set, ...encodeULEB128(copyIdx)); // reuse as match flag
    
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(subPtrLocal)); // reuse as j
    
    // byte comparison loop
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal)); // j
    body.push(WasmOp.local_get, ...encodeULEB128(delimLenLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    
    // if str[4+pos+j] != delim[4+j], set match=0 and break
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    
    body.push(WasmOp.local_get, ...encodeULEB128(delimPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    
    body.push(WasmOp.i32_ne);
    body.push(WasmOp.if_, 0x40);
      body.push(WasmOp.i32_const, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(copyIdx)); // match = 0
      body.push(WasmOp.br, 2); // break comparison loop
    body.push(WasmOp.end);
    
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(subPtrLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // If match, record found position and break search
    body.push(WasmOp.local_get, ...encodeULEB128(copyIdx));
    body.push(WasmOp.if_, 0x40);
      body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
      body.push(WasmOp.local_set, ...encodeULEB128(subLenLocal)); // found = pos
      body.push(WasmOp.br, 2); // break inner search
    body.push(WasmOp.end);
    
    // pos++
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(posLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end); // end inner loop
    body.push(WasmOp.end); // end inner block
    
    // At this point, subLenLocal = found position (or -1 if not found)
    // Create substring from start to found (or start to strLen if not found)
    
    // Determine end position
    body.push(WasmOp.local_get, ...encodeULEB128(subLenLocal)); // found
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_lt_s); // found < 0?
    body.push(WasmOp.if_, 0x7F); // i32 result
      body.push(WasmOp.local_get, ...encodeULEB128(strLenLocal)); // use strLen
    body.push(WasmOp.else_);
      body.push(WasmOp.local_get, ...encodeULEB128(subLenLocal)); // use found
    body.push(WasmOp.end);
    // Stack: endPos
    
    // subLen = endPos - start
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_sub);
    // Stack: subLen (could be 0)
    
    // Allocate substring: 4 + subLen bytes
    body.push(WasmOp.local_tee, ...encodeULEB128(subPtrLocal)); // save subLen temporarily
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(copyIdx)); // newSubPtr
    
    // Store subLen
    body.push(WasmOp.local_get, ...encodeULEB128(copyIdx));
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal)); // subLen
    body.push(WasmOp.i32_store, 2, 0);
    
    // Copy bytes: str[4+start..4+start+subLen] → newSub[4..]
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(posLocal)); // reuse pos as copy i
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(subPtrLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(copyIdx)); // newSub
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(posLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(posLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Push substring pointer into result array
    // Ensure capacity
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.call, ...encodeULEB128(ensureCapIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(arrPtrLocal));
    
    // arr[8 + arrLen*4] = newSubPtr
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(arrLenLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(copyIdx)); // newSubPtr
    body.push(WasmOp.i32_store, 2, 0);
    
    // arrLen++
    body.push(WasmOp.local_get, ...encodeULEB128(arrLenLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(arrLenLocal));
    
    // Update array length header
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(arrLenLocal));
    body.push(WasmOp.i32_store, 2, 0);
    
    // If delimiter was found, advance start past delimiter and continue
    body.push(WasmOp.local_get, ...encodeULEB128(subLenLocal));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_lt_s); // found < 0?
    body.push(WasmOp.br_if, 1); // break outer — no more delimiters
    
    // start = found + delimLen
    body.push(WasmOp.local_get, ...encodeULEB128(subLenLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(delimLenLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(startLocal));
    
    body.push(WasmOp.br, 0); // continue outer
    body.push(WasmOp.end); // end outer loop
    body.push(WasmOp.end); // end outer block
    
    // Return array pointer
    body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // toUpperCase/toLowerCase(str) → returns new string with case converted
  // For ASCII only: a-z ↔ A-Z (add/subtract 32)
  _compileCaseConvert(strExpr, body, toUpper) {
    const allocIdx = this._getAllocFunc();
    
    const strPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const lenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const iLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const byteLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    // Evaluate string
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strPtrLocal));
    
    // Read length
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(lenLocal));
    
    // Allocate new string
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(newPtrLocal));
    
    // Store length
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_store, 2, 0);
    
    // Copy + convert: loop i = 0..len
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    
    // Read byte
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(byteLocal));
    
    if (toUpper) {
      // If byte >= 'a' (97) and byte <= 'z' (122), subtract 32
      body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(97)); // 'a'
      body.push(WasmOp.i32_ge_u);
      body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(122)); // 'z'
      body.push(WasmOp.i32_le_u);
      body.push(WasmOp.i32_and);
      body.push(WasmOp.if_, 0x40);
        body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
        body.push(WasmOp.i32_const, 32);
        body.push(WasmOp.i32_sub);
        body.push(WasmOp.local_set, ...encodeULEB128(byteLocal));
      body.push(WasmOp.end);
    } else {
      // If byte >= 'A' (65) and byte <= 'Z' (90), add 32
      body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(65)); // 'A'
      body.push(WasmOp.i32_ge_u);
      body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(90)); // 'Z'
      body.push(WasmOp.i32_le_u);
      body.push(WasmOp.i32_and);
      body.push(WasmOp.if_, 0x40);
        body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
        body.push(WasmOp.i32_const, 32);
        body.push(WasmOp.i32_add);
        body.push(WasmOp.local_set, ...encodeULEB128(byteLocal));
      body.push(WasmOp.end);
    }
    
    // Store converted byte
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(byteLocal));
    body.push(WasmOp.i32_store8, 0, 0);
    
    // i++
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Return new string pointer
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // indexOf(haystack, needle) → returns first index of needle in haystack, or -1
  // Uses a naive O(n*m) algorithm — sufficient for reasonable string sizes
  _compileIndexOf(haystackExpr, needleExpr, body) {
    const indexOfIdx = this._getIndexOfFunc();
    
    // Evaluate haystack ptr
    this._compileExpr(haystackExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    
    // Evaluate needle ptr
    this._compileExpr(needleExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    
    // Call __str_indexOf(haystack, needle)
    body.push(WasmOp.call, ...encodeULEB128(indexOfIdx));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // charAt(str, idx) → returns a new 1-character string
  _compileCharAt(strExpr, idxExpr, body) {
    const allocIdx = this._getAllocFunc();
    
    // Temp locals
    const strPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const idxLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    // Evaluate string pointer
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strPtrLocal));
    
    // Evaluate index
    this._compileExpr(idxExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
    
    // Allocate new string: 4 (len header) + 1 (byte)
    body.push(WasmOp.i32_const, 5);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(newPtrLocal));
    
    // Store length = 1
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_store, 2, 0);
    
    // Copy byte: newPtr[4] = strPtr[4 + idx]
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    
    // Return new string pointer
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }
  
  // substring(str, start, end) → returns new string from start to end (exclusive)
  _compileSubstring(strExpr, startExpr, endExpr, body) {
    const allocIdx = this._getAllocFunc();
    
    // Temp locals
    const strPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const startLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const endLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newPtrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const newLenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const iLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    
    // Evaluate args
    this._compileExpr(strExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(strPtrLocal));
    
    this._compileExpr(startExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(startLocal));
    
    this._compileExpr(endExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(endLocal));
    
    // newLen = end - start
    body.push(WasmOp.local_get, ...encodeULEB128(endLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_sub);
    body.push(WasmOp.local_set, ...encodeULEB128(newLenLocal));
    
    // Allocate: 4 + newLen
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(newPtrLocal));
    
    // Store length
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_store, 2, 0);
    
    // Copy bytes: loop i = 0..newLen
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(newLenLocal));
    body.push(WasmOp.i32_ge_u);
    body.push(WasmOp.br_if, 1);
    
    // newPtr[4+i] = strPtr[4+start+i]
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(strPtrLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(startLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load8_u, 0, 0);
    body.push(WasmOp.i32_store8, 0, 0);
    
    body.push(WasmOp.local_get, ...encodeULEB128(iLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(iLocal));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    
    // Return new string pointer
    body.push(WasmOp.local_get, ...encodeULEB128(newPtrLocal));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // Compile push(array, value) — with reallocation support
  // Calls __array_ensure_cap to grow array if needed, then stores the value.
  // Returns new length
  _compileArrayPush(arrExpr, valExpr, body) {
    // Get array pointer into a temp local
    const ptrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const lenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;

    // Load array pointer
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(ptrLocal));

    // Call __array_ensure_cap(ptr) — returns possibly-new ptr
    const ensureCapIdx = this._getArrayEnsureCapFunc();
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.call, ...encodeULEB128(ensureCapIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(ptrLocal)); // update ptr to new location

    // Also update the variable holding the array if it's a simple identifier
    // This ensures subsequent pushes use the new pointer
    if (arrExpr instanceof ast.Identifier) {
      const name = arrExpr.value;
      const localIdx = this.currentLocals?.get(name);
      if (localIdx !== undefined) {
        body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
        if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
      } else if (this.globals.has(name)) {
        body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
        if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        body.push(WasmOp.global_set, ...encodeULEB128(this.globals.get(name).index));
      }
    }

    // Read current length
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(lenLocal));

    // Store value at ptr + 8 + len * 4
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    // Value to store
    this._compileExpr(valExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.i32_store, 2, 0);

    // Increment length: store len+1 at ptr+0
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_store, 2, 0);

    // Return new length
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // map(arr, fn) — create new array, apply fn to each element
  _compileArrayMap(arrExpr, fnExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const dstPtr = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;

    // Load source array
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));

    // Get source length
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));

    // Allocate destination array: __alloc(8 + srcLen * 4)
    const allocIdx = this._getAllocFunc();
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(dstPtr));

    // Set dst len and cap = srcLen
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 4);

    // Load function index
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));

    // Type index for fn(i32) -> i32
    const typeIdx = this.module.addType([this.numType], [this.numType]);

    // i = 0
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    // Loop: while (i < srcLen)
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);

    // Break if i >= srcLen
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);

    // dst[i] = fn(src[i])
    // Compute dst addr
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);

    // Load src[i]
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);

    // call_indirect fn(src[i])
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0x00);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);

    // Store result
    body.push(WasmOp.i32_store, 2, 0);

    // i++
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);

    // Return dst pointer
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // filter(arr, fn) — create new array with elements where fn returns truthy
  _compileArrayFilter(arrExpr, fnExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const dstPtr = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const elemVar = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;

    // Load source array
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));

    // Get source length
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));

    // Allocate destination array (max size = srcLen)
    const allocIdx = this._getAllocFunc();
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(dstPtr));

    // Set dst len = 0, cap = srcLen
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 4);

    // Load function index
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));

    const typeIdx = this.module.addType([this.numType], [this.numType]);

    // i = 0
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    // Loop
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);

    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);

    // elem = src[i]
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(elemVar));

    // if fn(elem) != 0, push to dst
    body.push(WasmOp.local_get, ...encodeULEB128(elemVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0x00);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);

    body.push(WasmOp.if_, 0x40); // void if — we manually handle the push
    {
      // Get dst current length
      const dstLenTemp = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.i32_load, 2, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(dstLenTemp));

      // dst[dstLen] = elem
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenTemp));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(elemVar));
      body.push(WasmOp.i32_store, 2, 0);

      // dst len = dstLen + 1
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenTemp));
      body.push(WasmOp.i32_const, 1);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_store, 2, 0);
    }
    body.push(WasmOp.end); // end if

    // i++
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);

    // Return dst pointer
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  // reduce(arr, fn, init) — fold array: fn(fn(...fn(init, a[0]), a[1])..., a[n-1])
  _compileArrayReduce(arrExpr, fnExpr, initExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;
    const accVar = this.currentLocalCount + this.currentExtraLocals; this.currentExtraLocals++;

    // Load source array
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));

    // Get source length
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));

    // Load function index
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));

    // acc = init
    this._compileExpr(initExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(accVar));

    // Type index for fn(i32, i32) -> i32
    const typeIdx = this.module.addType([this.numType, this.numType], [this.numType]);

    // i = 0
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    // Loop
    body.push(WasmOp.block, 0x40);
    body.push(WasmOp.loop, 0x40);

    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);

    // acc = fn(acc, src[i])
    body.push(WasmOp.local_get, ...encodeULEB128(accVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);

    // Load src[i]
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);

    // call_indirect fn(acc, elem)
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0x00);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(accVar));

    // i++
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));

    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);

    // Return acc
    body.push(WasmOp.local_get, ...encodeULEB128(accVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }

  _compileExpr(expr, body) {
    if (!expr) {
      this._emitConst(body, 0);
      return;
    }
    
    // Integer literal
    if (expr instanceof ast.IntegerLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value);
      } else {
        body.push(this.iop("const"), ...encodeSLEB128(expr.value));
      }
      return;
    }
    
    // Float literal
    if (expr instanceof ast.FloatLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value);
      } else {
        // Convert float to int (truncate) for i32/i64 mode
        body.push(this.iop("const"), ...encodeSLEB128(Math.trunc(expr.value)));
      }
      return;
    }
    
    // String literal — store in data segment, push pointer
    if (expr instanceof ast.StringLiteral) {
      const str = expr.value;
      if (!this.stringConstants.has(str)) {
        const { offset } = this.module.addStringConstant(str);
        this.stringConstants.set(str, offset);
      }
      const ptr = this.stringConstants.get(str);
      body.push(WasmOp.i32_const, ...encodeSLEB128(ptr));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }

    // Boolean literal
    if (expr instanceof ast.BooleanLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value ? 1.0 : 0.0);
      } else {
        body.push(this.iop("const"), ...encodeSLEB128(expr.value ? 1 : 0));
      }
      return;
    }
    
    // Identifier (variable reference)
    if (expr instanceof ast.Identifier) {
      const localIdx = this.currentLocals?.get(expr.value);
      if (localIdx !== undefined) {
        body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
      } else if (this.globals.has(expr.value)) {
        body.push(WasmOp.global_get, ...encodeULEB128(this.globals.get(expr.value).index));
      } else if (this.functions.has(expr.value)) {
        // Function reference — push table index as a value
        const funcInfo = this.functions.get(expr.value);
        this._emitConst(body, funcInfo.tableIdx);
      } else {
        throw new Error(`Undefined variable in WASM compilation: ${expr.value}`);
      }
      return;
    }
    
    // Infix expression (binary operations)
    if (expr instanceof ast.InfixExpression) {
      // Constant folding: if both operands are integer literals, compute at compile time
      if (expr.left instanceof ast.IntegerLiteral && expr.right instanceof ast.IntegerLiteral && !this.useF64) {
        const l = expr.left.value;
        const r = expr.right.value;
        let result;
        switch (expr.operator) {
          case '+': result = l + r; break;
          case '-': result = l - r; break;
          case '*': result = l * r; break;
          case '/': result = r !== 0 ? Math.trunc(l / r) : 0; break;
          case '%': result = r !== 0 ? l % r : 0; break;
          case '<': result = l < r ? 1 : 0; break;
          case '>': result = l > r ? 1 : 0; break;
          case '<=': result = l <= r ? 1 : 0; break;
          case '>=': result = l >= r ? 1 : 0; break;
          case '==': result = l === r ? 1 : 0; break;
          case '!=': result = l !== r ? 1 : 0; break;
          default: result = undefined;
        }
        if (result !== undefined) {
          this._emitConst(body, result);
          return;
        }
      }

      this._compileExpr(expr.left, body);
      this._compileExpr(expr.right, body);
      
      switch (expr.operator) {
        case '+': {
          // If either operand is a string, use string concatenation
          if (this._isStringExpr(expr.left) || this._isStringExpr(expr.right)) {
            this._ensureMemory();
            const concatIdx = this._getStrConcatFunc();
            // Both operands are on stack as i32 pointers
            if (this.useI64) {
              // Need i32 pointers for the function call
              // Re-emit operands as i32
              const tmpRight = this.currentLocalCount + this.currentExtraLocals;
              this.currentExtraLocals++;
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_set, ...encodeULEB128(tmpRight));
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_get, ...encodeULEB128(tmpRight));
            }
            body.push(WasmOp.call, ...encodeULEB128(concatIdx));
            if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          } else {
            body.push(this.iop("add"));
          }
          break;
        }
        case '-': body.push(this.iop("sub")); break;
        case '*': body.push(this.iop("mul")); break;
        case '/': body.push(this.useF64 ? WasmOp.f64_div : this.iop("div_s")); break;
        case '%': if (this.useF64) throw new Error('WASM f64 does not support %'); body.push(this.iop("rem_s")); break;
        case '<': body.push(this.cop("lt")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
        case '>': body.push(this.cop("gt")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
        case '==': {
          if (this._isStringExpr(expr.left) || this._isStringExpr(expr.right)) {
            // String comparison: call __str_eq
            this._ensureMemory();
            const eqIdx = this._getStrEqFunc();
            if (this.useI64) {
              const tmpR = this.currentLocalCount + this.currentExtraLocals;
              this.currentExtraLocals++;
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_set, ...encodeULEB128(tmpR));
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_get, ...encodeULEB128(tmpR));
            }
            body.push(WasmOp.call, ...encodeULEB128(eqIdx));
            if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
            if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          } else {
            body.push(this.iop("eq"));
            if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
            if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          }
          break;
        }
        case '!=': {
          if (this._isStringExpr(expr.left) || this._isStringExpr(expr.right)) {
            // String comparison: call __str_eq and negate
            this._ensureMemory();
            const eqIdx = this._getStrEqFunc();
            if (this.useI64) {
              const tmpR = this.currentLocalCount + this.currentExtraLocals;
              this.currentExtraLocals++;
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_set, ...encodeULEB128(tmpR));
              body.push(WasmOp.i32_wrap_i64);
              body.push(WasmOp.local_get, ...encodeULEB128(tmpR));
            }
            body.push(WasmOp.call, ...encodeULEB128(eqIdx));
            body.push(WasmOp.i32_eqz); // negate
            if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
            if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          } else {
            body.push(this.iop("ne"));
            if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
            if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          }
          break;
        }
        case '<=': body.push(this.cop("le")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
        case '>=': body.push(this.cop("ge")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
        default: throw new Error(`Unsupported operator in WASM: ${expr.operator}`);
      }
      return;
    }
    
    // Prefix expression
    if (expr instanceof ast.PrefixExpression) {
      // Constant folding for prefix expressions
      if (expr.right instanceof ast.IntegerLiteral && !this.useF64) {
        if (expr.operator === '-') {
          this._emitConst(body, -expr.right.value);
          return;
        }
        if (expr.operator === '!') {
          this._emitConst(body, expr.right.value === 0 ? 1 : 0);
          return;
        }
      }
      if (expr.operator === '-') {
        if (this.useF64) {
          this._compileExpr(expr.right, body);
          body.push(WasmOp.f64_neg);
        } else {
          this._emitConst(body, 0); // push 0
          this._compileExpr(expr.right, body);
          body.push(this.iop("sub")); // 0 - x = -x
        }
      } else if (expr.operator === '!') {
        this._compileExpr(expr.right, body);
        if (this.useF64) {
          this._emitF64Const(body, 0.0);
          body.push(WasmOp.f64_eq); // 1 if value==0 (i32 result)
          body.push(WasmOp.f64_convert_i32_s); // convert back to f64
        } else {
          body.push(this.iop("eqz"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        }
      } else {
        throw new Error(`Unsupported prefix operator in WASM: ${expr.operator}`);
      }
      return;
    }
    
    // Call expression
    if (expr instanceof ast.CallExpression) {
      const funcName = expr.function.value;
      
      // Built-in: len(array) — read length from array header
      if (funcName === 'len' && expr.arguments.length === 1) {
        this._compileExpr(expr.arguments[0], body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_load, 2, 0); // load len at offset 0
        if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        return;
      }

      // Built-in: push(array, value) — append value, return new length
      if (funcName === 'push' && expr.arguments.length === 2) {
        this._compileArrayPush(expr.arguments[0], expr.arguments[1], body);
        return;
      }

      // Built-in: map(array, fn) — returns new array with fn applied to each element
      if (funcName === 'map' && expr.arguments.length === 2) {
        this._compileArrayMap(expr.arguments[0], expr.arguments[1], body);
        return;
      }

      // Built-in: filter(array, fn) — returns new array with elements where fn returns truthy
      if (funcName === 'filter' && expr.arguments.length === 2) {
        this._compileArrayFilter(expr.arguments[0], expr.arguments[1], body);
        return;
      }

      // Built-in: reduce(array, fn, init) — fold array with fn(acc, elem) starting from init
      if (funcName === 'reduce' && expr.arguments.length === 3) {
        this._compileArrayReduce(expr.arguments[0], expr.arguments[1], expr.arguments[2], body);
        return;
      }
      
      // Built-in: charAt(string, index) — returns single-character string
      if (funcName === 'charAt' && expr.arguments.length === 2) {
        this._compileCharAt(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      
      // Built-in: substring(string, start, end) — returns substring
      if (funcName === 'substring' && expr.arguments.length === 3) {
        this._compileSubstring(expr.arguments[0], expr.arguments[1], expr.arguments[2], body);
        return;
      }
      
      // Built-in: indexOf(string, target) — returns first index of target, or -1
      if (funcName === 'indexOf' && expr.arguments.length === 2) {
        this._compileIndexOf(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      
      // Built-in: toUpperCase(string) — returns new uppercase string
      if (funcName === 'toUpperCase' && expr.arguments.length === 1) {
        this._compileCaseConvert(expr.arguments[0], body, true);
        return;
      }
      
      // Built-in: toLowerCase(string) — returns new lowercase string
      if (funcName === 'toLowerCase' && expr.arguments.length === 1) {
        this._compileCaseConvert(expr.arguments[0], body, false);
        return;
      }
      
      // Built-in: split(string, delimiter) — returns array of strings
      if (funcName === 'split' && expr.arguments.length === 2) {
        this._compileSplit(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      
      // Built-in: replace(string, search, replacement) — replaces first occurrence
      if (funcName === 'replace' && expr.arguments.length === 3) {
        this._compileReplace(expr.arguments[0], expr.arguments[1], expr.arguments[2], body);
        return;
      }
      
      // Built-in: trim(string) — removes leading/trailing whitespace
      if (funcName === 'trim' && expr.arguments.length === 1) {
        this._compileTrim(expr.arguments[0], body);
        return;
      }
      
      // Built-in: intToString(n) — converts integer to string
      if (funcName === 'intToString' && expr.arguments.length === 1) {
        this._compileIntToString(expr.arguments[0], body);
        return;
      }
      
      const funcInfo = this.functions.get(funcName);
      
      if (funcInfo) {
        // Direct call — known function
        for (const arg of expr.arguments) {
          this._compileExpr(arg, body);
        }
        body.push(WasmOp.call, ...encodeULEB128(funcInfo.index));
      } else {
        // Indirect call — function passed as parameter/variable
        // Push arguments first, then the table index (from variable), then call_indirect
        for (const arg of expr.arguments) {
          this._compileExpr(arg, body);
        }
        // Push the function reference (table index) from the variable
        this._compileExpr(expr.function, body);
        // Need type index for the expected signature
        const paramCount = expr.arguments.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        if (this.useI64) body.push(WasmOp.i32_wrap_i64); // table index must be i32
        body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0x00);
      }
      return;
    }
    
    // If expression
    if (expr instanceof ast.IfExpression) {
      this._compileExpr(expr.condition, body);
      // if_ expects i32 on stack; in i64/f64 mode, convert condition to i32
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      if (this.useF64) { this._emitF64Const(body, 0.0); body.push(WasmOp.f64_ne); }
      body.push(WasmOp.if_, this.numType); // if with numType result
      
      // Consequence
      if (expr.consequence) {
        const stmts = expr.consequence.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, i === stmts.length - 1);
        }
      } else {
        this._emitConst(body, 0);
      }
      
      body.push(WasmOp.else_);
      
      // Alternative
      if (expr.alternative) {
        if (expr.alternative instanceof ast.BlockStatement) {
          const stmts = expr.alternative.statements;
          for (let i = 0; i < stmts.length; i++) {
            this._compileStatement(stmts[i], body, i === stmts.length - 1);
          }
        } else {
          // else-if chain
          this._compileExpr(expr.alternative, body);
        }
      } else {
        this._emitConst(body, 0);
      }
      
      body.push(WasmOp.end);
      return;
    }

    // Inline function literal — uses pre-registered anonymous function
    if (expr instanceof ast.FunctionLiteral) {
      // Look up the pre-registered entry for this function literal
      const anonKey = this._anonMap.get(expr);
      if (anonKey) {
        const info = this.functions.get(anonKey);
        this._emitConst(body, info.tableIdx);
      } else {
        throw new Error('Anonymous function not pre-registered (should not happen)');
      }
      return;
    }
    
    // While expression
    if (expr instanceof ast.WhileExpression) {
      this._compileWhile(expr.condition, expr.body, body);
      this._emitConst(body, 0); // while returns 0 (null)
      return;
    }

    // Do-while expression: do { body } while (condition)
    if (expr instanceof ast.DoWhileExpression) {
      body.push(WasmOp.loop, 0x40);     // loop with void type
      
      // Body (executes at least once)
      if (expr.body) {
        const stmts = expr.body.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, false);
        }
      }
      
      // Condition — if true, branch back to loop start
      this._compileExpr(expr.condition, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      if (this.useF64) { this._emitF64Const(body, 0.0); body.push(WasmOp.f64_ne); }
      body.push(WasmOp.br_if, 0);       // br_if to loop start if condition true
      
      body.push(WasmOp.end);            // end loop
      this._emitConst(body, 0); // do-while returns 0
      return;
    }

    // For expression (C-style: for (init; condition; update) { body })
    if (expr instanceof ast.ForExpression) {
      // Compile init statement (usually let i = 0)
      if (expr.init) {
        this._compileStatement(expr.init, body, false);
      }
      // Compile as while loop: while (condition) { body; update; }
      const augmentedStmts = expr.body ? [...expr.body.statements] : [];
      if (expr.update) {
        // Add update as the last statement of the loop body
        // update can be a SetStatement or an ExpressionStatement
        if (expr.update instanceof ast.SetStatement) {
          augmentedStmts.push(expr.update);
        } else {
          augmentedStmts.push(new ast.ExpressionStatement(
            { type: 'IDENT', literal: '' },
            expr.update
          ));
        }
      }
      this._compileWhile(expr.condition, { statements: augmentedStmts }, body);
      this._emitConst(body, 0); // for returns 0
      return;
    }

    // for-in loop: for (x in arr) { body }
    // Compiles to: ptr = arr, len = load(ptr), i = 0; while (i < len) { x = load(ptr+8+i*4); body; i++ }
    if (expr instanceof ast.ForInExpression) {
      // Allocate temp locals: arrPtr, arrLen, idxVar, elemVar
      const arrPtrLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const arrLenLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const idxLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      
      // The loop variable — register as a named local
      const elemLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      this.currentLocals.set(expr.variable, elemLocal);
      
      // Evaluate iterable → array pointer
      this._compileExpr(expr.iterable, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.local_set, ...encodeULEB128(arrPtrLocal));
      
      // Load array length
      body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
      body.push(WasmOp.i32_load, 2, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(arrLenLocal));
      
      // i = 0
      body.push(WasmOp.i32_const, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
      
      // while (i < len)
      body.push(WasmOp.block, 0x40);
      body.push(WasmOp.loop, 0x40);
      
      // break if i >= len
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.local_get, ...encodeULEB128(arrLenLocal));
      body.push(WasmOp.i32_ge_s);
      body.push(WasmOp.br_if, 1);
      
      // elem = arr[i] → load from ptr + 8 + i * 4
      body.push(WasmOp.local_get, ...encodeULEB128(arrPtrLocal));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_load, 2, 0);
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      body.push(WasmOp.local_set, ...encodeULEB128(elemLocal));
      
      // Compile body
      if (expr.body) {
        const stmts = expr.body.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, false);
        }
      }
      
      // i++
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.i32_const, 1);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
      
      body.push(WasmOp.br, 0); // continue loop
      body.push(WasmOp.end);   // end loop
      body.push(WasmOp.end);   // end block
      
      this._emitConst(body, 0); // for-in returns 0
      return;
    }

    // Array comprehension: [body for var in iterable if condition]
    // Creates a new array with elements generated from iterating the source array
    if (expr instanceof ast.ArrayComprehension) {
      const allocIdx = this._getAllocFunc();
      const ensureCapIdx = this._getArrayEnsureCapFunc();
      
      // Temp locals
      const srcPtrLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const srcLenLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const idxLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const dstPtrLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      const dstLenLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      
      // Loop variable
      const varName = typeof expr.variable === 'string' ? expr.variable : expr.variable.value;
      const elemLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      this.currentLocals.set(varName, elemLocal);
      
      // Evaluate source iterable
      this._compileExpr(expr.iterable, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.local_set, ...encodeULEB128(srcPtrLocal));
      
      // Read source length
      body.push(WasmOp.local_get, ...encodeULEB128(srcPtrLocal));
      body.push(WasmOp.i32_load, 2, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(srcLenLocal));
      
      // Allocate result array with capacity = source length (or min 8)
      // Size: 8 + max(srcLen, 8) * 4
      body.push(WasmOp.local_get, ...encodeULEB128(srcLenLocal));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_gt_s);
      body.push(WasmOp.if_, 0x7F); // if -> i32
        body.push(WasmOp.local_get, ...encodeULEB128(srcLenLocal));
      body.push(WasmOp.else_);
        body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.end);
      // Stack: capacity
      // Compute 8 + capacity * 4
      const capLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      body.push(WasmOp.local_tee, ...encodeULEB128(capLocal));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.call, ...encodeULEB128(allocIdx));
      body.push(WasmOp.local_set, ...encodeULEB128(dstPtrLocal));
      
      // Store initial length 0 and capacity
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      body.push(WasmOp.i32_const, 0);
      body.push(WasmOp.i32_store, 2, 0); // len = 0
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      body.push(WasmOp.local_get, ...encodeULEB128(capLocal));
      body.push(WasmOp.i32_store, 2, 4); // cap = srcLen or 8
      
      // i = 0
      body.push(WasmOp.i32_const, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
      
      // dstLen = 0
      body.push(WasmOp.i32_const, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(dstLenLocal));
      
      // Loop: while (i < srcLen)
      body.push(WasmOp.block, 0x40);
      body.push(WasmOp.loop, 0x40);
      
      // break if i >= srcLen
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.local_get, ...encodeULEB128(srcLenLocal));
      body.push(WasmOp.i32_ge_s);
      body.push(WasmOp.br_if, 1);
      
      // elem = src[i]
      body.push(WasmOp.local_get, ...encodeULEB128(srcPtrLocal));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_load, 2, 0);
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      body.push(WasmOp.local_set, ...encodeULEB128(elemLocal));
      
      // Optional condition check
      if (expr.condition) {
        this._compileExpr(expr.condition, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        if (this.useF64) {
          this._emitF64Const(body, 0.0);
          body.push(WasmOp.f64_eq);
        } else {
          body.push(WasmOp.i32_eqz);
        }
        // If condition is false (eqz → 1), skip this element
        body.push(WasmOp.if_, 0x40);
          // Skip: just increment i and continue
          body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
          body.push(WasmOp.i32_const, 1);
          body.push(WasmOp.i32_add);
          body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
          body.push(WasmOp.br, 1); // continue loop
        body.push(WasmOp.end);
      }
      
      // Ensure capacity on result array
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      body.push(WasmOp.call, ...encodeULEB128(ensureCapIdx));
      body.push(WasmOp.local_set, ...encodeULEB128(dstPtrLocal));
      
      // Evaluate body expression
      this._compileExpr(expr.body, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      
      // Store result: dst[dstLen] = body_value
      // Address: dstPtr + 8 + dstLen * 4
      const valLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      body.push(WasmOp.local_set, ...encodeULEB128(valLocal));
      
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenLocal));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(valLocal));
      body.push(WasmOp.i32_store, 2, 0);
      
      // dstLen++
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenLocal));
      body.push(WasmOp.i32_const, 1);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_set, ...encodeULEB128(dstLenLocal));
      
      // Update dst array length header
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenLocal));
      body.push(WasmOp.i32_store, 2, 0);
      
      // i++
      body.push(WasmOp.local_get, ...encodeULEB128(idxLocal));
      body.push(WasmOp.i32_const, 1);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_set, ...encodeULEB128(idxLocal));
      
      body.push(WasmOp.br, 0); // continue loop
      body.push(WasmOp.end);   // end loop
      body.push(WasmOp.end);   // end block
      
      // Return result array pointer (as numType)
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtrLocal));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }

    // Hash literal: {key1: val1, key2: val2, ...}
    // Allocates a hash map, inserts all pairs
    if (expr instanceof ast.HashLiteral) {
      const hashNewIdx = this._getHashNewFunc();
      const hashSetIdx = this._getHashSetFunc();
      
      // Determine capacity: next power of 2 >= max(16, pairs.size * 2)
      let cap = 16;
      while (cap < expr.pairs.size * 2 + 2) cap *= 2;
      
      const mapLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      
      // Allocate hash map
      body.push(WasmOp.i32_const, ...encodeSLEB128(cap));
      body.push(WasmOp.call, ...encodeULEB128(hashNewIdx));
      body.push(WasmOp.local_set, ...encodeULEB128(mapLocal));
      
      // Insert each pair
      for (const [keyExpr, valExpr] of expr.pairs) {
        body.push(WasmOp.local_get, ...encodeULEB128(mapLocal));
        this._compileExpr(keyExpr, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        this._compileExpr(valExpr, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.call, ...encodeULEB128(hashSetIdx));
      }
      
      // Return map pointer
      body.push(WasmOp.local_get, ...encodeULEB128(mapLocal));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }

    // Array literal: [expr1, expr2, ...]
    // Memory layout: [len:i32][cap:i32][elem0:i32][elem1:i32]...
    // Returns pointer to the array header
    if (expr instanceof ast.ArrayLiteral) {
      const len = expr.elements.length;
      const cap = Math.max(len, len === 0 ? 256 : len * 2); // empty arrays get large capacity for push()
      const headerSize = 8; // len (4) + cap (4)
      const totalSize = headerSize + cap * 4;
      
      // Allocate: __alloc(totalSize)
      const allocIdx = this._getAllocFunc();
      body.push(WasmOp.i32_const, ...encodeSLEB128(totalSize));
      body.push(WasmOp.call, ...encodeULEB128(allocIdx));
      
      // Save pointer in a temp local
      const ptrLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      body.push(WasmOp.local_set, ...encodeULEB128(ptrLocal));
      
      // Store length at ptr+0
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(len));
      body.push(WasmOp.i32_store, 2, 0); // align=4, offset=0
      
      // Store capacity at ptr+4
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(cap));
      body.push(WasmOp.i32_store, 2, 4); // align=4, offset=4
      
      // Store each element at ptr+8+i*4
      for (let i = 0; i < len; i++) {
        body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
        this._compileExpr(expr.elements[i], body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        if (this.useF64) { /* TODO: f64 arrays need f64_store */ }
        body.push(WasmOp.i32_store, 2, ...encodeULEB128(8 + i * 4)); // align=4, offset=8+i*4
      }
      
      // Push pointer as the result
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }

    // Index expression: arr[idx]
    // Reads from memory: i32.load(ptr + 8 + idx * 4)
    if (expr instanceof ast.IndexExpression) {
      // Detect hash map vs array
      const leftType = this._inferExprType(expr.left);
      if (leftType === 'hash') {
        // Hash map access: __hash_get(map, key)
        const hashGetIdx = this._getHashGetFunc();
        this._compileExpr(expr.left, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        this._compileExpr(expr.index, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.call, ...encodeULEB128(hashGetIdx));
        if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        return;
      }
      
      // Array access: ptr + 8 + idx * 4
      this._compileExpr(expr.left, body);  // array pointer
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.i32_const, 8); // skip header (len + cap)
      body.push(WasmOp.i32_add);
      this._compileExpr(expr.index, body); // index
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_load, 2, 0); // align=4, offset=0
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }
    
    throw new Error(`Unsupported expression in WASM compilation: ${expr.constructor.name}`);
  }
}
