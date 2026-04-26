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
 * @returns {Uint8Array} WASM binary
 */
export function compileToWasm(source) {
  const lexer = new Lexer(source);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  
  if (parser.errors.length > 0) {
    throw new Error(`Parse errors: ${parser.errors.join(', ')}`);
  }
  
  const compiler = new WasmCompiler();
  return compiler.compile(program);
}

class WasmCompiler {
  constructor() {
    this.module = new WasmModule();
    this.functions = new Map();  // funcName → { index, params, localCount }
    this.currentLocals = null;   // Map<string, localIndex> during function compilation
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0; // Extra locals beyond params
  }
  
  compile(program) {
    // Two passes:
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
  
  _collectFunctions(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        const name = stmt.name.value;
        const fn = stmt.value;
        const paramCount = fn.parameters.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(WASM_TYPE.I32),
          [WASM_TYPE.I32]
        );
        // Reserve function index (body filled in pass 2)
        const funcIdx = this.functions.size;
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
    
    for (let i = 0; i < stmts.length; i++) {
      const isLast = i === stmts.length - 1;
      this._compileStatement(stmts[i], body, isLast);
    }
    
    // Build locals declaration
    const locals = this.currentExtraLocals > 0
      ? [{ count: this.currentExtraLocals, type: WASM_TYPE.I32 }]
      : [];
    
    // Add to module
    this.module.addFunction(info.typeIdx, locals, body);
    this.module.exportFunction(name, info.index);
    
    this.currentLocals = null;
  }
  
  _compileMainExpression(expr) {
    // Compile a standalone expression as a no-arg function "main"
    const typeIdx = this.module.addType([], [WASM_TYPE.I32]);
    
    this.currentLocals = new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    
    const body = [];
    this._compileExpr(expr, body);
    
    const locals = this.currentExtraLocals > 0
      ? [{ count: this.currentExtraLocals, type: WASM_TYPE.I32 }]
      : [];
    
    const funcIdx = this.functions.size;
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
  
  _compileWhile(condition, loopBody, body) {
    body.push(WasmOp.block, 0x40);    // block with void type
    body.push(WasmOp.loop, 0x40);     // loop with void type
    
    // Condition
    this._compileExpr(condition, body);
    body.push(WasmOp.i32_eqz);       // invert: break if condition is false
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
      body.push(WasmOp.i32_const, 0);
      return;
    }
    
    // Integer literal
    if (expr instanceof ast.IntegerLiteral) {
      body.push(WasmOp.i32_const, ...encodeSLEB128(expr.value));
      return;
    }
    
    // Boolean literal
    if (expr instanceof ast.BooleanLiteral) {
      body.push(WasmOp.i32_const, ...encodeSLEB128(expr.value ? 1 : 0));
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
        case '+': body.push(WasmOp.i32_add); break;
        case '-': body.push(WasmOp.i32_sub); break;
        case '*': body.push(WasmOp.i32_mul); break;
        case '/': body.push(WasmOp.i32_div_s); break;
        case '%': body.push(WasmOp.i32_rem_s); break;
        case '<': body.push(WasmOp.i32_lt_s); break;
        case '>': body.push(WasmOp.i32_gt_s); break;
        case '==': body.push(WasmOp.i32_eq); break;
        case '!=': body.push(WasmOp.i32_ne); break;
        case '<=': body.push(WasmOp.i32_le_s); break;
        case '>=': body.push(WasmOp.i32_ge_s); break;
        default: throw new Error(`Unsupported operator in WASM: ${expr.operator}`);
      }
      return;
    }
    
    // Prefix expression
    if (expr instanceof ast.PrefixExpression) {
      if (expr.operator === '-') {
        body.push(WasmOp.i32_const, 0); // push 0
        this._compileExpr(expr.right, body);
        body.push(WasmOp.i32_sub); // 0 - x = -x
      } else if (expr.operator === '!') {
        this._compileExpr(expr.right, body);
        body.push(WasmOp.i32_eqz);
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
      body.push(WasmOp.if_, WASM_TYPE.I32); // if with i32 result
      
      // Consequence
      if (expr.consequence) {
        const stmts = expr.consequence.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, i === stmts.length - 1);
        }
      } else {
        body.push(WasmOp.i32_const, 0);
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
        body.push(WasmOp.i32_const, 0);
      }
      
      body.push(WasmOp.end);
      return;
    }
    
    // While expression
    if (expr instanceof ast.WhileExpression) {
      this._compileWhile(expr.condition, expr.body, body);
      body.push(WasmOp.i32_const, 0); // while returns 0 (null)
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
      body.push(WasmOp.i32_const, 0); // for returns 0
      return;
    }
    
    throw new Error(`Unsupported expression in WASM compilation: ${expr.constructor.name}`);
  }
}
