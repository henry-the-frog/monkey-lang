// optimizer.js — Bytecode Optimizer for Monkey VM
//
// Runs optimization passes on compiled bytecode:
//   1. Dead code elimination — remove unreachable instructions after unconditional jumps
//   2. Peephole optimization — simplify instruction sequences
//   3. Jump threading — collapse chains of jumps
//
// The optimizer works on bytecode arrays and preserves semantic correctness.
// It operates post-compilation, before VM execution.

import { Opcodes, lookup, readOperands, make } from './code.js';

/**
 * Optimize a bytecode instruction array.
 * Returns a new (optimized) instruction array.
 */
export function optimize(instructions, options = {}) {
  let result = instructions;
  
  const passes = options.passes || ['deadCode', 'peephole', 'jumpThread'];
  const maxIterations = options.maxIterations || 3;
  
  for (let iter = 0; iter < maxIterations; iter++) {
    const before = result.length;
    
    for (const pass of passes) {
      switch (pass) {
        case 'deadCode':
          result = eliminateDeadCode(result);
          break;
        case 'peephole':
          result = peepholeOptimize(result);
          break;
        case 'jumpThread':
          result = threadJumps(result);
          break;
      }
    }
    
    // Fixed point — stop when no more changes
    if (result.length === before) break;
  }
  
  return result;
}

/**
 * Parse bytecode into an array of instruction descriptors.
 */
function parseInstructions(bytecode) {
  const instrs = [];
  let pos = 0;
  
  while (pos < bytecode.length) {
    const op = bytecode[pos];
    const def = lookup(op);
    
    if (!def) {
      instrs.push({ op, pos, size: 1, operands: [] });
      pos++;
      continue;
    }
    
    const { operands, bytesRead } = readOperands(def, bytecode, pos + 1);
    const size = 1 + bytesRead;
    instrs.push({ op, pos, size, operands, name: def.name });
    pos += size;
  }
  
  return instrs;
}

/**
 * Rebuild bytecode from instruction descriptors, fixing up jump targets.
 */
function rebuildBytecode(instrs) {
  // Build old→new position map
  const posMap = new Map();
  let newPos = 0;
  for (const instr of instrs) {
    posMap.set(instr.pos, newPos);
    newPos += instr.size;
  }
  
  // Helper: find nearest mapped position at or after a given old position
  function remapTarget(oldTarget) {
    if (posMap.has(oldTarget)) return posMap.get(oldTarget);
    // Target was removed — find nearest surviving instruction after it
    const sortedPositions = [...posMap.keys()].sort((a, b) => a - b);
    for (const pos of sortedPositions) {
      if (pos >= oldTarget) return posMap.get(pos);
    }
    // Fall back to end of bytecode
    return newPos;
  }
  
  // Rebuild with remapped jumps
  const result = new Uint8Array(newPos);
  let offset = 0;
  
  for (const instr of instrs) {
    const def = lookup(instr.op);
    
    if (isJump(instr.op) && instr.operands.length > 0) {
      // Remap jump target
      const oldTarget = instr.operands[0];
      const newTarget = remapTarget(oldTarget);
      const bytes = make(instr.op, newTarget);
      result.set(bytes, offset);
    } else if (def) {
      const bytes = make(instr.op, ...instr.operands);
      result.set(bytes, offset);
    } else {
      result[offset] = instr.op;
    }
    
    offset += instr.size;
  }
  
  return result;
}

/**
 * Check if an opcode is a jump instruction.
 */
function isJump(op) {
  return op === Opcodes.OpJump || op === Opcodes.OpJumpNotTruthy;
}

/**
 * Check if an opcode is an unconditional terminator.
 */
function isTerminator(op) {
  return op === Opcodes.OpJump || op === Opcodes.OpReturnValue || op === Opcodes.OpReturn;
}

// --- Dead Code Elimination ---

/**
 * Remove unreachable code after unconditional jumps/returns.
 */
function eliminateDeadCode(bytecode) {
  const instrs = parseInstructions(bytecode);
  if (instrs.length === 0) return bytecode;
  
  // Find all jump targets (these are reachable)
  const jumpTargets = new Set();
  for (const instr of instrs) {
    if (isJump(instr.op) && instr.operands.length > 0) {
      jumpTargets.add(instr.operands[0]);
    }
  }
  
  // Mark reachable instructions
  const reachable = new Set();
  let alive = true;
  
  for (const instr of instrs) {
    // If this position is a jump target, it's reachable
    if (jumpTargets.has(instr.pos)) {
      alive = true;
    }
    
    if (alive) {
      reachable.add(instr);
    }
    
    // After an unconditional terminator, code is dead until a jump target
    if (isTerminator(instr.op)) {
      alive = false;
    }
  }
  
  // Filter to only reachable instructions
  const liveInstrs = instrs.filter(i => reachable.has(i));
  
  if (liveInstrs.length === instrs.length) return bytecode; // no change
  
  return rebuildBytecode(liveInstrs);
}

// --- Peephole Optimization ---

/**
 * Peephole optimizations: simplify short instruction sequences.
 */
function peepholeOptimize(bytecode) {
  const instrs = parseInstructions(bytecode);
  if (instrs.length < 2) return bytecode;
  
  // Find all jump targets (don't optimize across them)
  const jumpTargets = new Set();
  for (const instr of instrs) {
    if (isJump(instr.op) && instr.operands.length > 0) {
      jumpTargets.add(instr.operands[0]);
    }
  }
  
  let changed = false;
  const result = [];
  let i = 0;
  
  while (i < instrs.length) {
    // Don't optimize if next instruction is a jump target
    if (i + 1 < instrs.length && !jumpTargets.has(instrs[i + 1].pos)) {
      // Pattern: OpConstant X, OpPop → eliminate both (if X has no side effects)
      // Actually this would change semantics if the constant is needed for a match
      // So we only eliminate redundant push-pop pairs in specific contexts
      
      // Pattern: OpJump to next instruction → eliminate
      if (instrs[i].op === Opcodes.OpJump) {
        const target = instrs[i].operands[0];
        const nextPos = i + 1 < instrs.length ? instrs[i + 1].pos : -1;
        if (target === nextPos) {
          // Jump to immediately following instruction — remove it
          changed = true;
          i++;
          continue;
        }
      }
      
      // Pattern: OpTrue, OpJumpNotTruthy target → always falls through (remove both)
      if (instrs[i].op === Opcodes.OpTrue && i + 1 < instrs.length && 
          instrs[i + 1].op === Opcodes.OpJumpNotTruthy) {
        // OpTrue always truthy, so JumpNotTruthy never fires
        changed = true;
        i += 2;
        continue;
      }
      
      // Pattern: OpFalse, OpJumpNotTruthy target → always jumps (convert to OpJump)
      if (instrs[i].op === Opcodes.OpFalse && i + 1 < instrs.length &&
          instrs[i + 1].op === Opcodes.OpJumpNotTruthy) {
        // Replace with unconditional jump
        changed = true;
        result.push({
          op: Opcodes.OpJump,
          pos: instrs[i].pos,
          size: 3, // OpJump is 3 bytes
          operands: instrs[i + 1].operands,
          name: 'OpJump',
        });
        i += 2;
        continue;
      }
      
      // Pattern: OpNull, OpJumpNotTruthy target → always jumps (null is falsy)
      if (instrs[i].op === Opcodes.OpNull && i + 1 < instrs.length &&
          instrs[i + 1].op === Opcodes.OpJumpNotTruthy) {
        changed = true;
        result.push({
          op: Opcodes.OpJump,
          pos: instrs[i].pos,
          size: 3,
          operands: instrs[i + 1].operands,
          name: 'OpJump',
        });
        i += 2;
        continue;
      }
    }
    
    result.push(instrs[i]);
    i++;
  }
  
  if (!changed) return bytecode;
  return rebuildBytecode(result);
}

// --- Jump Threading ---

/**
 * Thread jumps: if a jump targets another jump, redirect to final target.
 */
function threadJumps(bytecode) {
  const instrs = parseInstructions(bytecode);
  
  // Build position→instruction index map
  const posToIdx = new Map();
  for (let i = 0; i < instrs.length; i++) {
    posToIdx.set(instrs[i].pos, i);
  }
  
  let changed = false;
  
  for (const instr of instrs) {
    if (instr.op === Opcodes.OpJump && instr.operands.length > 0) {
      let target = instr.operands[0];
      const visited = new Set();
      
      // Follow chain of jumps
      while (true) {
        if (visited.has(target)) break; // cycle
        visited.add(target);
        
        const targetIdx = posToIdx.get(target);
        if (targetIdx === undefined) break;
        
        const targetInstr = instrs[targetIdx];
        if (targetInstr.op === Opcodes.OpJump) {
          target = targetInstr.operands[0];
        } else {
          break;
        }
      }
      
      if (target !== instr.operands[0]) {
        instr.operands[0] = target;
        changed = true;
      }
    }
  }
  
  if (!changed) return bytecode;
  return rebuildBytecode(instrs);
}

/**
 * Get optimization statistics.
 */
export function optimizeWithStats(instructions, options = {}) {
  const originalSize = instructions.length;
  const optimized = optimize(instructions, options);
  const optimizedSize = optimized.length;
  
  return {
    instructions: optimized,
    stats: {
      originalSize,
      optimizedSize,
      savedBytes: originalSize - optimizedSize,
      reductionPct: ((originalSize - optimizedSize) / originalSize * 100).toFixed(1),
    },
  };
}
