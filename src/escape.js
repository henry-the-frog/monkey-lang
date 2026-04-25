/**
 * Escape Analysis for monkey-lang
 * 
 * Determines whether variables/values "escape" their defining scope:
 * - Stack-allocatable: value is only used within the creating function
 * - Heap-required: value escapes via return, closure capture, or assignment to escaped location
 * 
 * Uses:
 * - Stack allocation of closures/arrays/hashes (major GC pressure reduction)
 * - Inlining decisions
 * - Memory optimization
 * 
 * Escape reasons:
 * 1. Returned from function
 * 2. Captured by a closure that escapes
 * 3. Stored in an escaped container (array, hash)
 * 4. Passed to an unknown function (conservative: assume escape)
 */

import * as ast from './ast.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

// ============================================================
// Escape State
// ============================================================

const STACK = 'stack';     // Does not escape — can be stack-allocated
const HEAP = 'heap';       // Escapes — must be heap-allocated
const UNKNOWN = 'unknown'; // Not yet determined

// ============================================================
// Escape Analyzer
// ============================================================

class EscapeAnalyzer {
  constructor() {
    this.variables = new Map();  // varName → {state, reasons}
    this.functions = new Map();  // funcName → {params, returns, captures}
  }

  /**
   * Analyze a program for escape information
   */
  analyze(program) {
    // First pass: collect all let bindings and function definitions
    this._collectBindings(program.statements, null);
    
    // Second pass: analyze escape
    this._analyzeStatements(program.statements, null, false);
    
    // Default anything still unknown to stack
    for (const [name, info] of this.variables) {
      if (info.state === UNKNOWN) info.state = STACK;
    }

    return {
      variables: new Map(this.variables),
      functions: new Map(this.functions),
      stackAllocatable: this._getStackAllocatable(),
      heapRequired: this._getHeapRequired()
    };
  }

  /**
   * Analyze from source
   */
  analyzeSource(source) {
    const lexer = new Lexer(source);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    return this.analyze(program);
  }

  _collectBindings(stmts, currentFunc) {
    for (const stmt of stmts) {
      if (stmt instanceof ast.LetStatement) {
        this.variables.set(stmt.name.value, {
          state: UNKNOWN,
          reasons: [],
          definedIn: currentFunc,
          isClosure: stmt.value instanceof ast.FunctionLiteral,
          isArray: stmt.value instanceof ast.ArrayLiteral,
          isHash: stmt.value instanceof ast.HashLiteral,
        });
        
        if (stmt.value instanceof ast.FunctionLiteral) {
          this.functions.set(stmt.name.value, {
            params: (stmt.value.parameters || []).map(p => p.value),
            captures: new Set(),
            returnsEscaping: false,
          });
          // Recurse into function body
          this._collectBindings(stmt.value.body?.statements || [], stmt.name.value);
        }
      }
    }
  }

  _analyzeStatements(stmts, currentFunc, inEscapingPosition) {
    for (const stmt of stmts) {
      this._analyzeStatement(stmt, currentFunc, inEscapingPosition);
    }
  }

  _analyzeStatement(stmt, currentFunc, inEscapingPosition) {
    if (stmt instanceof ast.LetStatement) {
      this._analyzeExpression(stmt.value, currentFunc, false);
      
      // If this is a function, analyze its body
      if (stmt.value instanceof ast.FunctionLiteral) {
        const bodyStmts = stmt.value.body?.statements || [];
        // The last expression in the body is the implicit return value (escaping position)
        for (let i = 0; i < bodyStmts.length; i++) {
          const isLast = i === bodyStmts.length - 1;
          const isImplicitReturn = isLast && bodyStmts[i] instanceof ast.ExpressionStatement;
          this._analyzeStatement(bodyStmts[i], stmt.name.value, isImplicitReturn);
        }
        
        // Check for captured variables
        const freeVars = this._findFreeVars(stmt.value.body, 
          new Set((stmt.value.parameters || []).map(p => p.value)));
        
        const funcInfo = this.functions.get(stmt.name.value);
        if (funcInfo) {
          for (const fv of freeVars) {
            funcInfo.captures.add(fv);
            // If this closure escapes, all captured vars escape too
            const closureInfo = this.variables.get(stmt.name.value);
            if (closureInfo?.state === HEAP) {
              this._markEscaped(fv, `captured by escaping closure ${stmt.name.value}`);
            }
          }
        }
      }
    } else if (stmt instanceof ast.ReturnStatement) {
      // Returned values escape
      if (stmt.returnValue) {
        this._analyzeExpression(stmt.returnValue, currentFunc, true);
        this._markExprEscaped(stmt.returnValue, 'returned from function');
      }
    } else if (stmt instanceof ast.ExpressionStatement) {
      this._analyzeExpression(stmt.expression, currentFunc, inEscapingPosition);
    } else if (stmt instanceof ast.BlockStatement) {
      this._analyzeStatements(stmt.statements || [], currentFunc, inEscapingPosition);
    }
  }

  _analyzeExpression(expr, currentFunc, isEscaping) {
    if (!expr) return;
    
    if (expr instanceof ast.Identifier) {
      if (isEscaping) {
        this._markEscaped(expr.value, 'used in escaping position');
      }
    } else if (expr instanceof ast.CallExpression) {
      // Function arguments conservatively escape (passed to unknown function)
      this._analyzeExpression(expr.function, currentFunc, false);
      for (const arg of (expr.arguments || [])) {
        this._analyzeExpression(arg, currentFunc, true); // Conservative: args escape
        this._markExprEscaped(arg, 'passed as function argument');
      }
    } else if (expr instanceof ast.InfixExpression) {
      this._analyzeExpression(expr.left, currentFunc, isEscaping);
      this._analyzeExpression(expr.right, currentFunc, isEscaping);
    } else if (expr instanceof ast.PrefixExpression) {
      this._analyzeExpression(expr.right, currentFunc, isEscaping);
    } else if (expr instanceof ast.ArrayLiteral) {
      for (const elem of (expr.elements || [])) {
        this._analyzeExpression(elem, currentFunc, true); // Elements in array escape
      }
    } else if (expr instanceof ast.IfExpression) {
      this._analyzeExpression(expr.condition, currentFunc, false);
      if (expr.consequence) {
        this._analyzeStatements(expr.consequence.statements || [], currentFunc, isEscaping);
      }
      if (expr.alternative) {
        this._analyzeStatements(expr.alternative.statements || [], currentFunc, isEscaping);
      }
    } else if (expr instanceof ast.FunctionLiteral) {
      // Anonymous function literal in expression position
      // If it's in an escaping position (returned/passed as arg), its free vars escape
      if (isEscaping) {
        const params = new Set((expr.parameters || []).map(p => p.value));
        const freeVars = this._findFreeVars(expr.body, params);
        for (const fv of freeVars) {
          this._markEscaped(fv, 'captured by escaping anonymous closure');
        }
      }
      // Analyze the function body
      const bodyStmts = expr.body?.statements || [];
      for (let i = 0; i < bodyStmts.length; i++) {
        const isLast = i === bodyStmts.length - 1;
        const isImplicitReturn = isLast && bodyStmts[i] instanceof ast.ExpressionStatement;
        this._analyzeStatement(bodyStmts[i], currentFunc, isImplicitReturn);
      }
    }
  }

  _markEscaped(varName, reason) {
    const info = this.variables.get(varName);
    if (info && info.state !== HEAP) {
      info.state = HEAP;
      info.reasons.push(reason);
      
      // If a closure escapes, its captured variables also escape
      const funcInfo = this.functions.get(varName);
      if (funcInfo) {
        for (const captured of funcInfo.captures) {
          this._markEscaped(captured, `captured by escaping closure ${varName}`);
        }
      }
    }
  }

  _markExprEscaped(expr, reason) {
    if (expr instanceof ast.Identifier) {
      this._markEscaped(expr.value, reason);
    }
  }

  _findFreeVars(body, bound) {
    const free = new Set();
    
    const walk = (node) => {
      if (!node) return;
      if (node instanceof ast.Identifier) {
        if (!bound.has(node.value)) free.add(node.value);
      } else if (node instanceof ast.InfixExpression) {
        walk(node.left); walk(node.right);
      } else if (node instanceof ast.PrefixExpression) {
        walk(node.right);
      } else if (node instanceof ast.CallExpression) {
        walk(node.function);
        for (const arg of (node.arguments || [])) walk(arg);
      } else if (node instanceof ast.IfExpression) {
        walk(node.condition);
        walkStmts(node.consequence?.statements || []);
        walkStmts(node.alternative?.statements || []);
      } else if (node instanceof ast.ArrayLiteral) {
        for (const elem of (node.elements || [])) walk(elem);
      } else if (node instanceof ast.BlockStatement) {
        walkStmts(node.statements || []);
      } else if (node instanceof ast.FunctionLiteral) {
        // Don't cross function boundaries — nested captures handled separately
      }
    };
    
    const walkStmts = (stmts) => {
      for (const stmt of stmts) {
        if (stmt instanceof ast.LetStatement) {
          walk(stmt.value);
          bound.add(stmt.name.value);
        } else if (stmt instanceof ast.ReturnStatement) {
          walk(stmt.returnValue);
        } else if (stmt instanceof ast.ExpressionStatement) {
          walk(stmt.expression);
        } else if (stmt instanceof ast.BlockStatement) {
          walkStmts(stmt.statements || []);
        }
      }
    };
    
    if (body instanceof ast.BlockStatement) {
      walkStmts(body.statements || []);
    } else {
      walk(body);
    }
    
    return free;
  }

  _getStackAllocatable() {
    const result = [];
    for (const [name, info] of this.variables) {
      if (info.state === STACK) result.push(name);
    }
    return result;
  }

  _getHeapRequired() {
    const result = [];
    for (const [name, info] of this.variables) {
      if (info.state === HEAP) result.push({ name, reasons: info.reasons });
    }
    return result;
  }
}

export { EscapeAnalyzer, STACK, HEAP, UNKNOWN };
