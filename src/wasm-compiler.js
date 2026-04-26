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
    this.currentLocals = null;
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    this.useI64 = options.useI64 || false;
    this.useF64 = options.useF64 || false;
    this.importSignatures = options.importSignatures || null;
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
    // Two passes:
    // Pass 0: Process import statements (creates WASM imports)
    this._processImports(program.statements);

    // Pass 1: Collect all function definitions and their signatures
    this._collectFunctions(program.statements);
    
    // Pass 2: Compile function bodies
    for (const stmt of program.statements) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        this._compileFunction(stmt.name.value, stmt.value);
      }
    }
    
    // Find and compile a "main" function (last expression statement) if any
    const lastStmt = program.statements[program.statements.length - 1];
    if (lastStmt instanceof ast.ExpressionStatement) {
      this._compileMainExpression(lastStmt.expression);
    }
    
    return this.module.encode();
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
        // Reserve function index (body filled in pass 2)
        // addFunction accounts for imports in the index space
        const funcIdx = this.module.imports.length + this._localFunctionCount();
        this.functions.set(name, { index: funcIdx, params: paramCount, typeIdx });
      }
    }
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
  
  _compileMainExpression(expr) {
    // Compile a standalone expression as a no-arg function "main"
    const typeIdx = this.module.addType([], [this.numType]);
    
    this.currentLocals = new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    
    const body = [];
    this._compileExpr(expr, body);
    
    const locals = this.currentExtraLocals > 0
      ? [{ count: this.currentExtraLocals, type: this.numType }]
      : [];
    
    const funcIdx = this.module.imports.length + this._localFunctionCount();
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
      // Variable reassignment: set x = value
      const localIdx = this.currentLocals?.get(stmt.name.value);
      if (localIdx === undefined) throw new Error(`Undefined variable in WASM set: ${stmt.name.value}`);
      this._compileExpr(stmt.value, body);
      body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
      
      if (isLast) {
        body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
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
      } else {
        throw new Error(`Undefined variable in WASM compilation: ${expr.value}`);
      }
      return;
    }
    
    // Infix expression (binary operations)
    if (expr instanceof ast.InfixExpression) {
      this._compileExpr(expr.left, body);
      this._compileExpr(expr.right, body);
      
      switch (expr.operator) {
        case '+': body.push(this.iop("add")); break;
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
      const funcInfo = this.functions.get(funcName);
      if (!funcInfo) throw new Error(`Undefined function in WASM: ${funcName}`);
      
      for (const arg of expr.arguments) {
        this._compileExpr(arg, body);
      }
      body.push(WasmOp.call, ...encodeULEB128(funcInfo.index));
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
    
    // While expression
    if (expr instanceof ast.WhileExpression) {
      this._compileWhile(expr.condition, expr.body, body);
      this._emitConst(body, 0); // while returns 0 (null)
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
    
    throw new Error(`Unsupported expression in WASM compilation: ${expr.constructor.name}`);
  }
}
