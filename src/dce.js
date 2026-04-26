/**
 * Dead Code Elimination (DCE) for monkey-lang
 * 
 * Uses the CFG to identify and remove:
 * 1. Unreachable basic blocks (no path from entry)
 * 2. Dead code after return statements
 * 3. Dead variable assignments (variable never read)
 * 
 * Works at the AST level — transforms the program and returns a new AST.
 */

import * as ast from './ast.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';

class DeadCodeEliminator {
  constructor() {
    this.warnings = [];
    this.eliminatedCount = 0;
  }

  /**
   * Eliminate dead code from a program AST
   */
  eliminate(program) {
    const newStmts = this._eliminateStatements(program.statements);
    const newProg = Object.create(Object.getPrototypeOf(program));
    Object.assign(newProg, program);
    newProg.statements = newStmts;
    return newProg;
  }

  /**
   * Eliminate dead code from source string
   */
  eliminateSource(source) {
    const lexer = new Lexer(source);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    if (parser.errors.length > 0) {
      return { program, warnings: parser.errors.map(e => `Parse: ${e}`), eliminated: 0 };
    }
    const optimized = this.eliminate(program);
    return { program: optimized, warnings: this.warnings, eliminated: this.eliminatedCount };
  }

  _eliminateStatements(stmts) {
    const result = [];
    let afterReturn = false;

    for (const stmt of stmts) {
      if (afterReturn) {
        this.warnings.push(`Dead code after return: ${stmt.toString?.() || 'statement'}`);
        this.eliminatedCount++;
        continue;
      }

      const optimized = this._eliminateStatement(stmt);
      if (optimized) {
        result.push(optimized);
      }

      if (stmt instanceof ast.ReturnStatement) {
        afterReturn = true;
      }
    }

    return result;
  }

  _eliminateStatement(stmt) {
    if (stmt instanceof ast.LetStatement) {
      return stmt; // Keep let statements (could do dead var elimination later)
    }

    if (stmt instanceof ast.ReturnStatement) {
      return stmt;
    }

    if (stmt instanceof ast.ExpressionStatement) {
      const expr = stmt.expression;

      // Optimize if expressions
      if (expr instanceof ast.IfExpression) {
        return this._eliminateIf(stmt, expr);
      }

      // Optimize blocks
      if (expr instanceof ast.BlockStatement) {
        const newBlock = Object.create(Object.getPrototypeOf(expr));
        Object.assign(newBlock, expr);
        newBlock.statements = this._eliminateStatements(expr.statements || []);
        const newStmt = Object.create(Object.getPrototypeOf(stmt));
        Object.assign(newStmt, stmt);
        newStmt.expression = newBlock;
        return newStmt;
      }

      return stmt;
    }

    if (stmt instanceof ast.BlockStatement) {
      const newBlock = Object.create(Object.getPrototypeOf(stmt));
      Object.assign(newBlock, stmt);
      newBlock.statements = this._eliminateStatements(stmt.statements || []);
      return newBlock;
    }

    return stmt;
  }

  _eliminateIf(stmt, ifExpr) {
    // Constant-fold if condition
    if (ifExpr.condition instanceof ast.BooleanLiteral) {
      if (ifExpr.condition.value === true) {
        this.warnings.push('Constant condition: if (true) — else branch eliminated');
        this.eliminatedCount++;
        // Return just the consequence
        if (ifExpr.consequence) {
          const newConseq = Object.create(Object.getPrototypeOf(ifExpr.consequence));
          Object.assign(newConseq, ifExpr.consequence);
          newConseq.statements = this._eliminateStatements(ifExpr.consequence.statements || []);
          return newConseq;
        }
        return null;
      } else if (ifExpr.condition.value === false) {
        this.warnings.push('Constant condition: if (false) — then branch eliminated');
        this.eliminatedCount++;
        if (ifExpr.alternative) {
          const newAlt = Object.create(Object.getPrototypeOf(ifExpr.alternative));
          Object.assign(newAlt, ifExpr.alternative);
          newAlt.statements = this._eliminateStatements(ifExpr.alternative.statements || []);
          return newAlt;
        }
        return null;
      }
    }

    // Recursively optimize branches
    const newIfExpr = Object.create(Object.getPrototypeOf(ifExpr));
    Object.assign(newIfExpr, ifExpr);
    if (ifExpr.consequence) {
      const c = Object.create(Object.getPrototypeOf(ifExpr.consequence));
      Object.assign(c, ifExpr.consequence);
      c.statements = this._eliminateStatements(ifExpr.consequence.statements || []);
      newIfExpr.consequence = c;
    }
    if (ifExpr.alternative) {
      const a = Object.create(Object.getPrototypeOf(ifExpr.alternative));
      Object.assign(a, ifExpr.alternative);
      a.statements = this._eliminateStatements(ifExpr.alternative.statements || []);
      newIfExpr.alternative = a;
    }

    const newStmt = Object.create(Object.getPrototypeOf(stmt));
    Object.assign(newStmt, stmt);
    newStmt.expression = newIfExpr;
    return newStmt;
  }
}

/**
 * Check if an expression is side-effect-free (safe to eliminate)
 */
function isSideEffectFree(expr) {
  if (!expr) return true;
  if (expr instanceof ast.IntegerLiteral) return true;
  if (expr instanceof ast.FloatLiteral) return true;
  if (expr instanceof ast.StringLiteral) return true;
  if (expr instanceof ast.BooleanLiteral) return true;
  if (expr instanceof ast.NullLiteral) return true;
  if (expr instanceof ast.Identifier) return true;
  if (expr instanceof ast.FunctionLiteral) return true; // fn() { ... } is a value, no side effects
  if (expr instanceof ast.ArrayLiteral) {
    return (expr.elements || []).every(isSideEffectFree);
  }
  if (expr instanceof ast.HashLiteral) {
    for (const [k, v] of (expr.pairs || [])) {
      if (!isSideEffectFree(k) || !isSideEffectFree(v)) return false;
    }
    return true;
  }
  if (expr instanceof ast.PrefixExpression) return isSideEffectFree(expr.right);
  if (expr instanceof ast.InfixExpression) {
    return isSideEffectFree(expr.left) && isSideEffectFree(expr.right);
  }
  if (expr instanceof ast.IfExpression) return false; // May have side effects in branches
  if (expr instanceof ast.CallExpression) return false; // Function calls always potentially side-effecting
  if (expr instanceof ast.IndexExpression) return true; // a[0] is a read
  return false; // Unknown node type — assume side effects
}

/**
 * Remove dead let statements from a program AST.
 * 
 * @param {object} program - The AST program node
 * @param {Array<{name: string, stmt: object}>} deadVars - Dead variables from findDeadVariables()
 * @returns {{program: object, removed: number, converted: number}} - Modified program + stats
 */
function removeDeadLets(program, deadVars) {
  if (!deadVars || deadVars.length === 0) {
    return { program, removed: 0, converted: 0 };
  }

  const deadNames = new Set(deadVars.map(d => d.name));
  let removed = 0;
  let converted = 0;

  function filterStatements(stmts) {
    const result = [];
    for (const stmt of stmts) {
      if (stmt instanceof ast.LetStatement && deadNames.has(stmt.name.value)) {
        if (isSideEffectFree(stmt.value)) {
          // Safe to remove entirely
          removed++;
          continue;
        } else {
          // Keep the expression (it has side effects) but drop the binding
          const exprStmt = new ast.ExpressionStatement(stmt.token, stmt.value);
          converted++;
          result.push(exprStmt);
          continue;
        }
      }

      // Recurse into blocks, if expressions, etc.
      if (stmt instanceof ast.ExpressionStatement && stmt.expression instanceof ast.IfExpression) {
        const ifExpr = stmt.expression;
        if (ifExpr.consequence) {
          ifExpr.consequence.statements = filterStatements(ifExpr.consequence.statements || []);
        }
        if (ifExpr.alternative) {
          ifExpr.alternative.statements = filterStatements(ifExpr.alternative.statements || []);
        }
      }
      if (stmt instanceof ast.BlockStatement) {
        stmt.statements = filterStatements(stmt.statements || []);
      }

      result.push(stmt);
    }
    return result;
  }

  program.statements = filterStatements(program.statements);
  return { program, removed, converted };
}

/**
 * Find dead variables: assigned but never read
 */
function findDeadVariables(program) {
  const assigned = new Map(); // name → stmt
  const read = new Set();
  
  function walkExpr(expr) {
    if (!expr) return;
    if (expr instanceof ast.Identifier) {
      read.add(expr.value);
    }
    if (expr instanceof ast.InfixExpression) {
      walkExpr(expr.left);
      walkExpr(expr.right);
    }
    if (expr instanceof ast.PrefixExpression) {
      walkExpr(expr.right);
    }
    if (expr instanceof ast.CallExpression) {
      walkExpr(expr.function);
      for (const arg of (expr.arguments || [])) walkExpr(arg);
    }
    if (expr instanceof ast.IfExpression) {
      walkExpr(expr.condition);
      walkStmts(expr.consequence?.statements || []);
      walkStmts(expr.alternative?.statements || []);
    }
    if (expr instanceof ast.ArrayLiteral) {
      for (const elem of (expr.elements || [])) walkExpr(elem);
    }
    if (expr instanceof ast.IndexExpression) {
      walkExpr(expr.left);
      walkExpr(expr.index);
    }
    if (expr instanceof ast.FunctionLiteral) {
      walkStmts(expr.body?.statements || []);
    }
  }

  function walkStmts(stmts) {
    for (const stmt of stmts) {
      if (stmt instanceof ast.LetStatement) {
        assigned.set(stmt.name.value, stmt);
        walkExpr(stmt.value);
      } else if (stmt instanceof ast.ReturnStatement) {
        walkExpr(stmt.returnValue);
      } else if (stmt instanceof ast.ExpressionStatement) {
        walkExpr(stmt.expression);
      } else if (stmt instanceof ast.BlockStatement) {
        walkStmts(stmt.statements || []);
      }
    }
  }

  walkStmts(program.statements);
  
  const dead = [];
  for (const [name, stmt] of assigned) {
    if (!read.has(name)) {
      dead.push({ name, stmt });
    }
  }
  return dead;
}

/**
 * Convenience function: run DCE on a Program AST in place.
 * Used by the compiler pipeline.
 */
function eliminateDeadCode(program) {
  const dce = new DeadCodeEliminator();
  const optimized = dce.eliminate(program);
  // Copy optimized statements back to original program (in-place mutation)
  program.statements = optimized.statements;
  return program;
}

export { DeadCodeEliminator, findDeadVariables, eliminateDeadCode, removeDeadLets, isSideEffectFree };
