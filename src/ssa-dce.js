// ssa-dce.js — SSA-level Dead Code Elimination
//
// Uses def-use chain analysis on SSA form to identify dead definitions.
// A definition is dead if:
//   1. Its value is never used (no references in any other instruction)
//   2. The definition has no side effects (not a function call, puts, etc.)
//
// Returns a set of dead variable names that can be used to annotate the AST.

import { perFunctionSSA, formatSSA } from './ssa.js';

/**
 * Extract all SSA variable references from a value expression.
 * SSA variables follow the pattern: name_N (where N is a number).
 * Also extracts non-subscripted identifiers (the SSA builder doesn't always
 * rename inside complex expressions like if/while bodies).
 */
function extractReferences(value, allBaseNames) {
  if (value === null || value === undefined) return [];
  const str = String(value);
  const refs = new Set();
  // Remove quoted strings to avoid false matches
  const cleaned = str.replace(/"[^"]*"/g, '');
  
  // Match SSA variable names: word_digits pattern
  const ssaMatches = cleaned.match(/\b([a-zA-Z_]\w*_\d+)\b/g);
  if (ssaMatches) {
    for (const m of ssaMatches) refs.add(m);
  }
  
  // Also match non-subscripted identifiers that correspond to known variables
  // This handles cases where the SSA builder doesn't rename inside complex expressions
  if (allBaseNames) {
    const identMatches = cleaned.match(/\b([a-zA-Z_]\w*)\b/g);
    if (identMatches) {
      for (const m of identMatches) {
        if (allBaseNames.has(m)) {
          // Find the latest SSA version of this variable
          refs.add(`__base__${m}`);
        }
      }
    }
  }
  
  return [...refs];
}

/**
 * Check if a value expression has side effects (function calls, etc.)
 */
function hasSideEffects(value) {
  if (value === null || value === undefined) return false;
  const str = String(value);
  // Function calls have parens: someFunc(...) or name_N(...)
  if (/\w+\(/.test(str)) return true;
  return false;
}

/**
 * Analyze SSA form and return dead definitions.
 * @param {Map} ssa - SSA blocks from SSABuilder.build()
 * @returns {{ dead: string[], uses: Map<string, string[]>, defs: Map<string, any> }}
 */
export function analyzeDeadDefs(ssa) {
  const defs = new Map();   // varName → { blockId, instr }
  const uses = new Map();   // varName → [user varNames or 'return' or 'expr']
  
  // Pass 1: Collect all definitions and build base name set
  const allBaseNames = new Set();
  const baseToSSA = new Map(); // baseName → [ssaName1, ssaName2, ...]
  
  for (const [blockId, block] of ssa) {
    for (const phi of block.phis) {
      defs.set(phi.target, { blockId, type: 'phi', value: phi.sources });
      const base = phi.target.replace(/_\d+$/, '');
      allBaseNames.add(base);
      if (!baseToSSA.has(base)) baseToSSA.set(base, []);
      baseToSSA.get(base).push(phi.target);
    }
    for (const instr of block.instructions) {
      if (instr.tag === 'assign') {
        defs.set(instr.target, { blockId, type: 'assign', value: instr.value });
        const base = instr.target.replace(/_\d+$/, '');
        allBaseNames.add(base);
        if (!baseToSSA.has(base)) baseToSSA.set(base, []);
        baseToSSA.get(base).push(instr.target);
      }
    }
  }
  
  // Initialize use lists
  for (const name of defs.keys()) {
    uses.set(name, []);
  }
  
  // Helper: resolve references (including base name references)
  function resolveRefs(value, user) {
    const refs = extractReferences(value, allBaseNames);
    for (const ref of refs) {
      if (ref.startsWith('__base__')) {
        // Base name reference — mark ALL versions of this variable as used
        const base = ref.slice(8);
        const ssaNames = baseToSSA.get(base) || [];
        for (const ssaName of ssaNames) {
          if (uses.has(ssaName)) {
            uses.get(ssaName).push(user);
          }
        }
      } else if (uses.has(ref)) {
        uses.get(ref).push(user);
      }
    }
  }
  
  // Pass 2: Collect uses
  for (const [blockId, block] of ssa) {
    // Phi sources
    for (const phi of block.phis) {
      for (const src of phi.sources) {
        if (uses.has(src.var)) {
          uses.get(src.var).push(phi.target);
        }
      }
    }
    
    // Instructions
    for (const instr of block.instructions) {
      if (instr.tag === 'assign') {
        resolveRefs(instr.value, instr.target);
      } else if (instr.tag === 'return') {
        resolveRefs(instr.value, '__return__');
      } else if (instr.tag === 'expr') {
        resolveRefs(instr.expr || instr.value, '__expr__');
      }
    }
  }
  
  // Pass 3: Mark dead definitions (no uses AND no side effects)
  const dead = [];
  for (const [name, useList] of uses) {
    if (useList.length === 0) {
      const def = defs.get(name);
      if (def && !hasSideEffects(def.value)) {
        dead.push(name);
      }
    }
  }
  
  return { dead, uses, defs };
}

/**
 * Analyze a source program for dead definitions across all functions.
 * @param {string} source - Monkey-lang source code
 * @returns {Map<string, { dead: string[], uses: Map, defs: Map }>}
 */
export function analyzeProgram(source) {
  const ssaResults = perFunctionSSA(source);
  const analysis = new Map();
  
  for (const [name, { ssa }] of ssaResults) {
    analysis.set(name, analyzeDeadDefs(ssa));
  }
  
  return analysis;
}
