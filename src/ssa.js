/**
 * Static Single Assignment (SSA) Form for monkey-lang
 * 
 * SSA: each variable is assigned exactly once.
 * At join points (merge after if/else), insert φ (phi) nodes:
 *   x₃ = φ(x₁, x₂)  — picks which version of x based on which branch taken
 * 
 * This is the foundation for modern compiler optimizations:
 * - Constant propagation
 * - Copy propagation  
 * - Dead code elimination
 * - Common subexpression elimination
 * 
 * Algorithm: Cytron et al. (1991)
 * 1. Compute dominance frontiers
 * 2. Insert φ-nodes at dominance frontiers of definitions
 * 3. Rename variables (each def gets a new subscript)
 */

import * as ast from './ast.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { CFGBuilder } from './cfg.js';

// ============================================================
// SSA Instruction Types
// ============================================================

class SSAAssign {
  constructor(target, value) {
    this.tag = 'assign';
    this.target = target;  // e.g., 'x_2'
    this.value = value;    // SSA expression
  }
  toString() { return `${this.target} = ${this.value}`; }
}

class SSAPhi {
  constructor(target, sources) {
    this.tag = 'phi';
    this.target = target;         // e.g., 'x_3'
    this.sources = sources;       // [{blockId, var: 'x_1'}, {blockId, var: 'x_2'}]
  }
  toString() {
    const srcs = this.sources.map(s => `${s.var}[BB${s.blockId}]`).join(', ');
    return `${this.target} = φ(${srcs})`;
  }
}

class SSAReturn {
  constructor(value) { this.tag = 'return'; this.value = value; }
  toString() { return `return ${this.value}`; }
}

class SSAExpr {
  constructor(expr) { this.tag = 'expr'; this.expr = expr; }
  toString() { return String(this.expr); }
}

// ============================================================
// SSA Builder
// ============================================================

class SSABuilder {
  constructor(cfg) {
    this.cfg = cfg;
    this.counter = new Map();    // varName → next subscript
    this.stack = new Map();      // varName → stack of current SSA names
    this.ssaBlocks = new Map();  // blockId → [SSA instructions]
    this.phiNodes = new Map();   // blockId → [SSAPhi]
  }

  build() {
    // Initialize
    for (const [id] of this.cfg.blocks) {
      this.ssaBlocks.set(id, []);
      this.phiNodes.set(id, []);
    }

    // Step 1: Find all variable definitions
    const varDefs = new Map(); // varName → [blockId where defined]
    for (const [id, block] of this.cfg.blocks) {
      for (const stmt of block.stmts) {
        const defs = this._getDefinitions(stmt);
        for (const v of defs) {
          if (!varDefs.has(v)) varDefs.set(v, []);
          varDefs.get(v).push(id);
        }
      }
    }

    // Step 2: Compute dominance frontiers
    const df = this._computeDominanceFrontiers();

    // Step 3: Insert phi nodes
    for (const [varName, defBlocks] of varDefs) {
      const worklist = [...defBlocks];
      const hasPhiAt = new Set();
      
      while (worklist.length > 0) {
        const blockId = worklist.pop();
        const frontier = df.get(blockId) || new Set();
        
        for (const fId of frontier) {
          if (!hasPhiAt.has(fId)) {
            hasPhiAt.add(fId);
            const block = this.cfg.blocks.get(fId);
            const phi = new SSAPhi(
              varName,
              block.preds.map(p => ({ blockId: p, var: varName }))
            );
            this.phiNodes.get(fId).push(phi);
            worklist.push(fId);
          }
        }
      }
    }

    // Step 4: Rename variables
    for (const v of varDefs.keys()) {
      this.counter.set(v, 0);
      this.stack.set(v, []);
    }
    this._rename(this.cfg.entry);

    // Collect results
    const result = new Map();
    for (const [id] of this.cfg.blocks) {
      result.set(id, {
        phis: this.phiNodes.get(id),
        instructions: this.ssaBlocks.get(id)
      });
    }
    return result;
  }

  _newName(varName) {
    const n = this.counter.get(varName) || 0;
    this.counter.set(varName, n + 1);
    const ssaName = `${varName}_${n}`;
    if (!this.stack.has(varName)) this.stack.set(varName, []);
    this.stack.get(varName).push(ssaName);
    return ssaName;
  }

  _currentName(varName) {
    const stk = this.stack.get(varName);
    if (stk && stk.length > 0) return stk[stk.length - 1];
    return varName; // Not yet defined in SSA
  }

  _rename(blockId) {
    const block = this.cfg.blocks.get(blockId);
    const savedStackSizes = new Map();
    
    // Save stack sizes for rollback
    for (const [v, stk] of this.stack) {
      savedStackSizes.set(v, stk.length);
    }

    // Rename phi targets
    for (const phi of this.phiNodes.get(blockId)) {
      phi.target = this._newName(phi.target);
    }

    // Rename statements
    for (const stmt of block.stmts) {
      const ssaInstr = this._renameStatement(stmt);
      if (ssaInstr) this.ssaBlocks.get(blockId).push(ssaInstr);
    }

    // Update phi sources in successors
    for (const succId of block.succs) {
      for (const phi of this.phiNodes.get(succId)) {
        for (const src of phi.sources) {
          if (src.blockId === blockId) {
            // Find the original variable name (before subscript)
            const origName = src.var.replace(/_\d+$/, '');
            src.var = this._currentName(origName);
          }
        }
      }
    }

    // Recurse into dominated children
    const idom = this.cfg.computeImmediateDominators();
    for (const [childId, dominator] of idom) {
      if (dominator === blockId) {
        this._rename(childId);
      }
    }

    // Restore stacks
    for (const [v, stk] of this.stack) {
      const savedSize = savedStackSizes.get(v) || 0;
      while (stk.length > savedSize) stk.pop();
    }
  }

  _renameStatement(stmt) {
    if (stmt instanceof ast.LetStatement) {
      const value = this._renameExpr(stmt.value);
      const target = this._newName(stmt.name.value);
      return new SSAAssign(target, value);
    }
    if (stmt instanceof ast.ReturnStatement) {
      const value = stmt.returnValue ? this._renameExpr(stmt.returnValue) : null;
      return new SSAReturn(value);
    }
    if (stmt instanceof ast.ExpressionStatement) {
      return new SSAExpr(this._renameExpr(stmt.expression));
    }
    return null;
  }

  _renameExpr(expr) {
    if (!expr) return null;
    if (expr instanceof ast.Identifier) {
      return this._currentName(expr.value);
    }
    if (expr instanceof ast.IntegerLiteral) return expr.value;
    if (expr instanceof ast.StringLiteral) return `"${expr.value}"`;
    if (expr instanceof ast.BooleanLiteral) return expr.value;
    if (expr instanceof ast.InfixExpression) {
      return `${this._renameExpr(expr.left)} ${expr.operator} ${this._renameExpr(expr.right)}`;
    }
    if (expr instanceof ast.PrefixExpression) {
      return `${expr.operator}${this._renameExpr(expr.right)}`;
    }
    if (expr instanceof ast.CallExpression) {
      const fn = this._renameExpr(expr.function);
      const args = (expr.arguments || []).map(a => this._renameExpr(a)).join(', ');
      return `${fn}(${args})`;
    }
    return expr.toString?.() || String(expr);
  }

  _getDefinitions(stmt) {
    const defs = [];
    if (stmt instanceof ast.LetStatement) {
      defs.push(stmt.name.value);
    }
    return defs;
  }

  _computeDominanceFrontiers() {
    const idom = this.cfg.computeImmediateDominators();
    const df = new Map();
    
    for (const [id] of this.cfg.blocks) {
      df.set(id, new Set());
    }
    
    for (const [id, block] of this.cfg.blocks) {
      if (block.preds.length >= 2) {
        for (const predId of block.preds) {
          let runner = predId;
          while (runner !== idom.get(id) && runner !== undefined && runner !== null) {
            df.get(runner).add(id);
            runner = idom.get(runner);
          }
        }
      }
    }
    
    return df;
  }
}

// ============================================================
// Convenience
// ============================================================

function toSSA(source) {
  let cfg;
  if (typeof source === 'string') {
    const lexer = new Lexer(source);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    const cfgBuilder = new CFGBuilder();
    cfg = cfgBuilder.build(program);
  } else {
    // Assume it's already a CFG
    cfg = source;
  }
  
  const ssaBuilder = new SSABuilder(cfg);
  return { ssa: ssaBuilder.build(), cfg };
}

function formatSSA(ssaResult) {
  const lines = [];
  for (const [id, block] of ssaResult) {
    lines.push(`BB${id}:`);
    for (const phi of block.phis) {
      lines.push(`  ${phi}`);
    }
    for (const instr of block.instructions) {
      lines.push(`  ${instr}`);
    }
  }
  return lines.join('\n');
}

/**
 * Per-function SSA pipeline: extract all functions from a program,
 * build CFG for each function body, and transform to SSA.
 * @param {string|ast.Program} source - Source code string or parsed Program
 * @returns {Map<string, { cfg, ssa }>} Map from function name → { cfg, ssa }
 */
function perFunctionSSA(source) {
  let program;
  if (typeof source === 'string') {
    const lexer = new Lexer(source);
    const parser = new Parser(lexer);
    program = parser.parseProgram();
  } else {
    program = source;
  }
  
  const results = new Map();
  let anonCount = 0;
  
  function extractFunctions(stmts, prefix = '') {
    for (const stmt of stmts) {
      if (stmt instanceof ast.LetStatement && stmt.value instanceof ast.FunctionLiteral) {
        const name = prefix + stmt.name.value;
        const fn = stmt.value;
        const cfgBuilder = new CFGBuilder();
        const cfg = cfgBuilder.build(fn.body);
        const ssaBuilder = new SSABuilder(cfg);
        results.set(name, { cfg, ssa: ssaBuilder.build() });
        
        // Recurse into function body for nested functions
        extractFunctions(fn.body.statements, name + '.');
      } else if (stmt instanceof ast.ExpressionStatement) {
        // Check for anonymous function expressions
        if (stmt.expression instanceof ast.FunctionLiteral) {
          const name = prefix + `__anon_${anonCount++}`;
          const fn = stmt.expression;
          const cfgBuilder = new CFGBuilder();
          const cfg = cfgBuilder.build(fn.body);
          const ssaBuilder = new SSABuilder(cfg);
          results.set(name, { cfg, ssa: ssaBuilder.build() });
          extractFunctions(fn.body.statements, name + '.');
        }
      }
    }
  }
  
  extractFunctions(program.statements);
  return results;
}

export { SSAAssign, SSAPhi, SSAReturn, SSAExpr, SSABuilder, toSSA, formatSSA, perFunctionSSA };
