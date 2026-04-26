// code.js — Monkey Bytecode Instruction Set
// Defines opcodes, instruction encoding, and disassembly.

// Opcodes
export const Opcodes = {
  OpConstant:        0x00, // Load constant from pool: OpConstant <uint16>
  OpAdd:             0x01, // Pop two, push sum
  OpSub:             0x02, // Pop two, push difference
  OpMul:             0x03, // Pop two, push product
  OpDiv:             0x04, // Pop two, push quotient
  OpMod:             0x1F, // Pop two, push modulo
  OpPower:           0x25, // Pop two, push exponentiation
  OpPop:             0x05, // Pop top of stack (expression statement cleanup)
  OpTrue:            0x06, // Push true
  OpFalse:           0x07, // Push false
  OpNull:            0x08, // Push null
  OpEqual:           0x09, // Pop two, push equality result
  OpNotEqual:        0x0A, // Pop two, push inequality result
  OpGreaterThan:     0x0B, // Pop two, push greater-than result
  OpMinus:           0x0C, // Negate top of stack (prefix -)
  OpBang:            0x0D, // Logical NOT top of stack (prefix !)
  OpJumpNotTruthy:   0x0E, // Conditional jump: OpJumpNotTruthy <uint16>
  OpJump:            0x0F, // Unconditional jump: OpJump <uint16>
  OpSetGlobal:       0x10, // Store top in global: OpSetGlobal <uint16>
  OpGetGlobal:       0x11, // Load global: OpGetGlobal <uint16>
  OpArray:           0x12, // Build array: OpArray <uint16> (pops N elements)
  OpHash:            0x13, // Build hash: OpHash <uint16> (pops N*2 elements)
  OpIndex:           0x14, // Index operation: pop index, pop object, push result
  OpCall:            0x15, // Call function: OpCall <uint8> (num args)
  OpReturnValue:     0x16, // Return with value on stack
  OpReturn:          0x17, // Return without value (implicit null)
  OpSetLocal:        0x18, // Store in local: OpSetLocal <uint8>
  OpGetLocal:        0x19, // Load local: OpGetLocal <uint8>
  OpGetBuiltin:      0x1A, // Load builtin: OpGetBuiltin <uint8>
  OpClosure:         0x1B, // Create closure: OpClosure <uint16> <uint8> (const idx, num free vars)
  OpGetFree:         0x1C, // Load free variable: OpGetFree <uint8>
  OpSetFree:         0x20, // Store to free variable: OpSetFree <uint8>
  OpMakeCell:        0x21, // Wrap TOS in a Cell: OpMakeCell (no operands)
  OpGetLocalRaw:     0x22, // Get local without Cell deref: OpGetLocalRaw <uint8>
  OpGetFreeRaw:      0x23, // Get free without Cell deref: OpGetFreeRaw <uint8>
  OpCurrentClosure:  0x1D, // Push current closure (for recursion)
  OpDeepEqual:       0x24, // Pop two, push deep structural equality result
  OpTailCall:        0x1E, // Tail call: OpTailCall <uint8> (num args) — reuses frame
  OpSetIndex:        0x26, // Set index: pop value, pop key, pop obj, set obj[key]=value, push obj
};

// Instruction definitions: opcode → { name, operandWidths }
// operandWidths: array of byte widths for each operand
const definitions = new Map([
  [Opcodes.OpConstant,       { name: 'OpConstant',       operandWidths: [2] }],
  [Opcodes.OpAdd,            { name: 'OpAdd',            operandWidths: [] }],
  [Opcodes.OpSub,            { name: 'OpSub',            operandWidths: [] }],
  [Opcodes.OpMul,            { name: 'OpMul',            operandWidths: [] }],
  [Opcodes.OpDiv,            { name: 'OpDiv',            operandWidths: [] }],
  [Opcodes.OpMod,            { name: 'OpMod',            operandWidths: [] }],
  [Opcodes.OpPop,            { name: 'OpPop',            operandWidths: [] }],
  [Opcodes.OpTrue,           { name: 'OpTrue',           operandWidths: [] }],
  [Opcodes.OpFalse,          { name: 'OpFalse',          operandWidths: [] }],
  [Opcodes.OpNull,           { name: 'OpNull',           operandWidths: [] }],
  [Opcodes.OpEqual,          { name: 'OpEqual',          operandWidths: [] }],
  [Opcodes.OpNotEqual,       { name: 'OpNotEqual',       operandWidths: [] }],
  [Opcodes.OpGreaterThan,    { name: 'OpGreaterThan',    operandWidths: [] }],
  [Opcodes.OpMinus,          { name: 'OpMinus',          operandWidths: [] }],
  [Opcodes.OpBang,           { name: 'OpBang',           operandWidths: [] }],
  [Opcodes.OpJumpNotTruthy,  { name: 'OpJumpNotTruthy',  operandWidths: [2] }],
  [Opcodes.OpJump,           { name: 'OpJump',           operandWidths: [2] }],
  [Opcodes.OpSetGlobal,      { name: 'OpSetGlobal',      operandWidths: [2] }],
  [Opcodes.OpGetGlobal,      { name: 'OpGetGlobal',      operandWidths: [2] }],
  [Opcodes.OpArray,          { name: 'OpArray',          operandWidths: [2] }],
  [Opcodes.OpHash,           { name: 'OpHash',           operandWidths: [2] }],
  [Opcodes.OpIndex,          { name: 'OpIndex',          operandWidths: [] }],
  [Opcodes.OpCall,           { name: 'OpCall',           operandWidths: [1] }],
  [Opcodes.OpReturnValue,    { name: 'OpReturnValue',    operandWidths: [] }],
  [Opcodes.OpReturn,         { name: 'OpReturn',         operandWidths: [] }],
  [Opcodes.OpSetLocal,       { name: 'OpSetLocal',       operandWidths: [1] }],
  [Opcodes.OpGetLocal,       { name: 'OpGetLocal',       operandWidths: [1] }],
  [Opcodes.OpGetBuiltin,     { name: 'OpGetBuiltin',     operandWidths: [1] }],
  [Opcodes.OpClosure,        { name: 'OpClosure',        operandWidths: [2, 1] }],
  [Opcodes.OpGetFree,        { name: 'OpGetFree',        operandWidths: [1] }],
  [Opcodes.OpSetFree,        { name: 'OpSetFree',        operandWidths: [1] }],
  [Opcodes.OpMakeCell,       { name: 'OpMakeCell',       operandWidths: [] }],
  [Opcodes.OpGetLocalRaw,   { name: 'OpGetLocalRaw',   operandWidths: [1] }],
  [Opcodes.OpGetFreeRaw,    { name: 'OpGetFreeRaw',    operandWidths: [1] }],
  [Opcodes.OpCurrentClosure, { name: 'OpCurrentClosure', operandWidths: [] }],
  [Opcodes.OpDeepEqual,      { name: 'OpDeepEqual',      operandWidths: [] }],
  [Opcodes.OpPower,          { name: 'OpPower',          operandWidths: [] }],
  [Opcodes.OpTailCall,       { name: 'OpTailCall',       operandWidths: [1] }],
  [Opcodes.OpSetIndex,       { name: 'OpSetIndex',       operandWidths: [] }],
]);

/**
 * Look up an opcode definition.
 */
export function lookup(op) {
  return definitions.get(op) || null;
}

/**
 * Encode an instruction: opcode + operands → Uint8Array
 */
export function make(op, ...operands) {
  const def = definitions.get(op);
  if (!def) return new Uint8Array(0);

  // Calculate total instruction length
  let instructionLen = 1; // opcode byte
  for (const w of def.operandWidths) instructionLen += w;

  const instruction = new Uint8Array(instructionLen);
  instruction[0] = op;

  let offset = 1;
  for (let i = 0; i < def.operandWidths.length; i++) {
    const width = def.operandWidths[i];
    const operand = operands[i] || 0;
    if (width === 2) {
      // Big-endian uint16
      instruction[offset] = (operand >> 8) & 0xFF;
      instruction[offset + 1] = operand & 0xFF;
    } else if (width === 1) {
      instruction[offset] = operand & 0xFF;
    }
    offset += width;
  }

  return instruction;
}

/**
 * Read operands from instruction bytes starting at offset.
 * Returns { operands: number[], bytesRead: number }
 */
export function readOperands(def, instructions, offset) {
  const operands = [];
  let bytesRead = 0;

  for (const width of def.operandWidths) {
    if (width === 2) {
      operands.push((instructions[offset + bytesRead] << 8) | instructions[offset + bytesRead + 1]);
      bytesRead += 2;
    } else if (width === 1) {
      operands.push(instructions[offset + bytesRead]);
      bytesRead += 1;
    }
  }

  return { operands, bytesRead };
}

/**
 * Disassemble bytecode instructions into human-readable string.
 */
export function disassemble(instructions) {
  const lines = [];
  let i = 0;

  while (i < instructions.length) {
    const op = instructions[i];
    const def = definitions.get(op);

    if (!def) {
      lines.push(`${String(i).padStart(4, '0')} ERROR: unknown opcode ${op}`);
      i++;
      continue;
    }

    const { operands, bytesRead } = readOperands(def, instructions, i + 1);
    const operandStr = operands.length > 0 ? ' ' + operands.join(' ') : '';
    lines.push(`${String(i).padStart(4, '0')} ${def.name}${operandStr}`);

    i += 1 + bytesRead;
  }

  return lines.join('\n');
}

/**
 * Concatenate multiple instruction byte arrays.
 */
export function concatInstructions(...arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
