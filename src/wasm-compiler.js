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
    this._strConcatImport = null; // lazily added on first string concat
    this._heapBaseGlobal = null; // global for heap pointer (bump allocator)
    this._allocFuncIdx = null; // lazily added __alloc function
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
    }

    // Pass 0.5: Process top-level let bindings as globals (non-function values)
    this._processGlobals(program.statements);

    // Pass 1: Collect all function definitions and their signatures
    this._collectFunctions(program.statements);
    
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
    this._initializeGlobals(program.statements);
    
    // Collect non-let, non-function, non-import statements for main block
    const mainStatements = program.statements.filter(stmt =>
      !(stmt instanceof ast.LetStatement) &&
      !(stmt instanceof ast.ImportStatement)
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
  _getStrConcatImport() {
    if (this._strConcatImport === null) {
      this._strConcatImport = this.module.addImport(
        'env', '__str_concat',
        [WASM_TYPE.I32, WASM_TYPE.I32], [WASM_TYPE.I32]
      );
    }
    return this._strConcatImport;
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
    //   local $ptr i32
    //   global.get $heap_base    ;; ptr = heap_base
    //   local.set $ptr
    //   global.get $heap_base
    //   local.get 0              ;; size param
    //   i32.add
    //   i32.const 3
    //   i32.add
    //   i32.const -4             ;; ~3 = 0xFFFFFFFC
    //   i32.and                  ;; align to 4 bytes
    //   global.set $heap_base
    //   local.get $ptr           ;; return old pointer
    const body = [
      WasmOp.global_get, ...encodeULEB128(heapGlobal),
      WasmOp.local_set, 1, // local 1 = $ptr (local 0 is the size param)
      WasmOp.global_get, ...encodeULEB128(heapGlobal),
      WasmOp.local_get, 0, // size
      WasmOp.i32_add,
      WasmOp.i32_const, 3,
      WasmOp.i32_add,
      WasmOp.i32_const, ...encodeSLEB128(-4), // 0xFFFFFFFC
      WasmOp.i32_and,
      WasmOp.global_set, ...encodeULEB128(heapGlobal),
      WasmOp.local_get, 1, // return ptr
    ];
    
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [{ count: 1, type: WASM_TYPE.I32 }], body);
    this._allocFuncIdx = funcIdx;
    return funcIdx;
  }

  _processGlobals(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && !(stmt.value instanceof ast.FunctionLiteral)) {
        const name = stmt.name.value;
        // Create a mutable global for this variable
        const idx = this.module.addGlobal(this.numType, true, 0);
        this.globals.set(name, { index: idx, mutable: true });
      }
    }
  }

  _initializeGlobals(statements) {
    const initBody = [];
    let hasInits = false;

    // Set up context for expression compilation
    this.currentLocals = new Map();
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
    this.currentLocalCount = fnLit.parameters.length;
    this.currentExtraLocals = 0;
    
    // Parameters are locals 0..N-1
    for (let i = 0; i < fnLit.parameters.length; i++) {
      this.currentLocals.set(fnLit.parameters[i].value, i);
    }
    
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
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    
    const body = [];
    if (this._initFuncIdx !== undefined) {
      body.push(WasmOp.call, ...encodeULEB128(this._initFuncIdx));
    }
    
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
      // Allocate a local for this variable
      const localIdx = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      this.currentLocals.set(stmt.name.value, localIdx);
      
      this._compileExpr(stmt.value, body);
      body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
      
      // If this is the last statement and we need a return value, push the local
      if (isLast) {
        body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
      }
    } else if (stmt instanceof ast.SetStatement) {
      // Array/indexed assignment: set arr[i] = value
      if (stmt.name instanceof ast.IndexExpression) {
        // Compute: addr = ptr + 8 + idx * 4, then i32.store
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

  // Compile push(array, value) — inline, no reallocation (uses pre-allocated capacity)
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
          if (expr.left instanceof ast.StringLiteral || expr.right instanceof ast.StringLiteral) {
            const concatIdx = this._getStrConcatImport();
            // Both operands already on stack as i32 pointers
            if (this.useI64) {
              // Wrap to i32 for the import call
              body.push(WasmOp.i32_wrap_i64); // right
              // Need to swap — but WASM doesn't have swap. Use locals.
              // Actually, arguments are already on stack in order: left, right
              // So we need left to be i32 too. Recompile with wraps.
              body.length -= 1; // remove the wrap we just added
              // Recompile left as i32
              // This is getting complex — for now, only support i32 mode for strings
            }
            body.push(WasmOp.call, ...encodeULEB128(concatIdx));
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
        case '==': body.push(this.iop("eq")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
        case '!=': body.push(this.iop("ne")); if (this.useI64) body.push(WasmOp.i64_extend_i32_s); if (this.useF64) body.push(WasmOp.f64_convert_i32_s); break;
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

    // Array literal: [expr1, expr2, ...]
    // Memory layout: [len:i32][cap:i32][elem0:i32][elem1:i32]...
    // Returns pointer to the array header
    if (expr instanceof ast.ArrayLiteral) {
      const len = expr.elements.length;
      const cap = Math.max(len, 4); // minimum capacity of 4
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
      // Compute base address: ptr + 8 + idx * 4
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
