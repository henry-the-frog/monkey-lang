// debugger.js — Bytecode Debugger for Monkey VM
//
// DebugVM wraps the normal VM with debugging capabilities:
//   - Single-step execution
//   - Breakpoints (by instruction address or opcode)
//   - Stack/globals/frame inspection
//   - Instruction disassembly at current IP
//   - Execution trace recording
//   - Step over/into/out for function calls
//
// Rather than reimplementing the VM loop, DebugVM patches the VM's
// run() to execute one instruction at a time via a "stepper" approach.

import { Opcodes, lookup, readOperands } from './code.js';
import { CompiledFunction, Closure, Cell } from './compiler.js';
import { VM, builtins } from './vm.js';
import {
  MonkeyInteger, MonkeyFloat, MonkeyString, MonkeyBoolean,
  MonkeyArray, MonkeyHash, MonkeyNull, MonkeyError, MonkeyBuiltin,
  ShapedHash, objectKeyString, TRUE, FALSE, NULL,
} from './object.js';
import { getShape } from './shape.js';

const DebugState = {
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ERROR: 'error',
};

/**
 * DebugVM — wraps VM with debugging.
 * Uses the VM's own run() in a controlled way.
 */
export class DebugVM {
  constructor(bytecode, gc = null) {
    this.vm = new VM(bytecode, gc);
    this.state = DebugState.READY;
    
    // Breakpoints
    this.breakpoints = new Set();   // instruction addresses (main function)
    this.opcodeBreaks = new Set();  // break on specific opcodes
    
    // Trace
    this.trace = [];
    this.traceEnabled = false;
    this.maxTraceSize = 10000;
    
    // Step tracking
    this.instructionCount = 0;
    
    // Resume tracking
    this._resuming = false;  // true when resuming from a breakpoint
  }

  // --- Execution ---

  /**
   * Run one instruction. Returns state: 'paused', 'completed', 'breakpoint'.
   */
  step() {
    if (this.state === DebugState.COMPLETED) return 'completed';
    
    const vm = this.vm;
    const frame = vm.frames[vm.framesIndex - 1];
    
    if (!this._resuming) {
      if (frame.ip >= frame.instructions().length - 1) {
        this.state = DebugState.COMPLETED;
        return 'completed';
      }
      frame.ip++;
    }
    this._resuming = false;
    
    // Record trace before execution
    if (this.traceEnabled) {
      this._recordTrace();
    }
    
    this.instructionCount++;
    
    try {
      this._executeOne();
      if (this.state === DebugState.COMPLETED) return 'completed';
      this.state = DebugState.PAUSED;
      return 'paused';
    } catch (e) {
      this.state = DebugState.ERROR;
      this.error = e;
      throw e;
    }
  }

  /**
   * Run until completion or breakpoint.
   */
  run() {
    this.state = DebugState.RUNNING;
    
    try {
      const vm = this.vm;
      let skipAdvance = this._resuming;
      this._resuming = false;
      
      while (true) {
        const frame = vm.frames[vm.framesIndex - 1];
        
        if (!skipAdvance) {
          if (frame.ip >= frame.instructions().length - 1) {
            this.state = DebugState.COMPLETED;
            return 'completed';
          }
          frame.ip++;
          
          // Check breakpoints
          if (this._shouldBreak()) {
            this._resuming = true;
            this.state = DebugState.PAUSED;
            return 'breakpoint';
          }
        }
        skipAdvance = false;
        
        if (this.traceEnabled) this._recordTrace();
        this.instructionCount++;
        this._executeOne();
        
        if (this.state === DebugState.COMPLETED) return 'completed';
      }
    } catch (e) {
      this.state = DebugState.ERROR;
      this.error = e;
      throw e;
    }
  }

  /**
   * Step over: execute until we're back at the same or shallower frame depth.
   */
  stepOver() {
    const startDepth = this.vm.framesIndex;
    
    // Execute one instruction first
    const result = this.step();
    if (result !== 'paused') return result;
    
    // If we went deeper (call), keep running until we come back
    let limit = 1000000; // safety limit
    while (this.vm.framesIndex > startDepth && limit-- > 0) {
      const frame = this.vm.frames[this.vm.framesIndex - 1];
      if (frame.ip >= frame.instructions().length - 1) {
        this.state = DebugState.COMPLETED;
        return 'completed';
      }
      
      frame.ip++;
      if (this._shouldBreak()) {
        this._resuming = true;
        this.state = DebugState.PAUSED;
        return 'breakpoint';
      }
      if (this.traceEnabled) this._recordTrace();
      this.instructionCount++;
      this._executeOne();
      if (this.state === DebugState.COMPLETED) return 'completed';
    }
    
    this.state = DebugState.PAUSED;
    return 'paused';
  }

  /**
   * Step out: run until current frame returns.
   */
  stepOut() {
    const startDepth = this.vm.framesIndex;
    let limit = 1000000;
    
    while (limit-- > 0) {
      const frame = this.vm.frames[this.vm.framesIndex - 1];
      if (frame.ip >= frame.instructions().length - 1) {
        this.state = DebugState.COMPLETED;
        return 'completed';
      }
      
      frame.ip++;
      if (this._shouldBreak()) {
        this._resuming = true;
        this.state = DebugState.PAUSED;
        return 'breakpoint';
      }
      if (this.traceEnabled) this._recordTrace();
      this.instructionCount++;
      this._executeOne();
      if (this.state === DebugState.COMPLETED) return 'completed';
      
      if (this.vm.framesIndex < startDepth) {
        this.state = DebugState.PAUSED;
        return 'paused';
      }
    }
    
    this.state = DebugState.COMPLETED;
    return 'completed';
  }

  /**
   * Execute a single instruction using the VM's internal methods.
   * This is the bridge between our debugger and the VM.
   */
  _executeOne() {
    const vm = this.vm;
    const ip = vm.frames[vm.framesIndex - 1].ip;
    const instructions = vm.frames[vm.framesIndex - 1].instructions();
    const op = instructions[ip];
    
    // Call VM's internal execution for one instruction
    // We piggyback on the VM's methods by manually dispatching
    switch (op) {
      case Opcodes.OpConstant: {
        const constIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        vm.push(vm.constants[constIndex]);
        break;
      }
      case Opcodes.OpAdd:
      case Opcodes.OpSub:
      case Opcodes.OpMul:
      case Opcodes.OpDiv:
      case Opcodes.OpMod:
      case Opcodes.OpPower:
        vm.executeBinaryOperation(op);
        break;
      case Opcodes.OpPop:
        vm.pop();
        break;
      case Opcodes.OpTrue: vm.push(TRUE); break;
      case Opcodes.OpFalse: vm.push(FALSE); break;
      case Opcodes.OpNull: vm.push(NULL); break;
      case Opcodes.OpEqual:
      case Opcodes.OpNotEqual:
      case Opcodes.OpGreaterThan:
        vm.executeComparison(op);
        break;
      case Opcodes.OpMinus: {
        const operand = vm.pop();
        if (operand instanceof MonkeyInteger) vm.push(new MonkeyInteger(-operand.value));
        else if (operand instanceof MonkeyFloat) vm.push(new MonkeyFloat(-operand.value));
        else throw new Error(`unsupported type for negation: ${operand.type()}`);
        break;
      }
      case Opcodes.OpBang: {
        const operand = vm.pop();
        if (operand === TRUE) vm.push(FALSE);
        else if (operand === FALSE) vm.push(TRUE);
        else if (operand === NULL) vm.push(TRUE);
        else vm.push(FALSE);
        break;
      }
      case Opcodes.OpJump: {
        const pos = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip = pos - 1;
        break;
      }
      case Opcodes.OpJumpNotTruthy: {
        const pos = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        const condition = vm.pop();
        if (!vm.isTruthy(condition)) vm.frames[vm.framesIndex - 1].ip = pos - 1;
        break;
      }
      case Opcodes.OpSetGlobal: {
        const idx = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        vm.globals[idx] = vm.pop();
        break;
      }
      case Opcodes.OpGetGlobal: {
        const idx = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        vm.push(vm.globals[idx]);
        break;
      }
      case Opcodes.OpArray: {
        const num = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        const elements = [];
        for (let i = vm.sp - num; i < vm.sp; i++) elements.push(vm.stack[i]);
        vm.sp -= num;
        vm.push(vm._track(new MonkeyArray(elements)));
        break;
      }
      case Opcodes.OpHash: {
        const num = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        const keyStrs = [], keys = [], values = [];
        for (let i = vm.sp - num; i < vm.sp; i += 2) {
          keys.push(vm.stack[i]);
          values.push(vm.stack[i + 1]);
          keyStrs.push(objectKeyString(vm.stack[i]));
        }
        vm.sp -= num;
        const shape = getShape(keyStrs);
        vm.push(vm._track(new ShapedHash(shape, values, keys)));
        break;
      }
      case Opcodes.OpIndex: {
        const index = vm.pop();
        const left = vm.pop();
        vm.executeIndexExpression(left, index);
        break;
      }
      case Opcodes.OpCall: {
        const numArgs = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        vm.executeCall(numArgs);
        break;
      }
      case Opcodes.OpReturnValue: {
        const returnValue = vm.pop();
        if (vm.framesIndex <= 1) {
          vm.stack[vm.sp] = returnValue;
          this.state = DebugState.COMPLETED;
          return;
        }
        const frame = vm.frames[--vm.framesIndex];
        vm.sp = frame.basePointer - 1;
        vm.push(returnValue);
        break;
      }
      case Opcodes.OpReturn: {
        if (vm.framesIndex <= 1) {
          vm.stack[vm.sp] = NULL;
          this.state = DebugState.COMPLETED;
          return;
        }
        const frame = vm.frames[--vm.framesIndex];
        vm.sp = frame.basePointer - 1;
        vm.push(NULL);
        break;
      }
      case Opcodes.OpSetLocal: {
        const localIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const val = vm.pop();
        const slot = vm.stack[vm.frames[vm.framesIndex - 1].basePointer + localIndex];
        if (slot instanceof Cell) slot.value = val;
        else vm.stack[vm.frames[vm.framesIndex - 1].basePointer + localIndex] = val;
        break;
      }
      case Opcodes.OpGetLocal: {
        const localIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const slot = vm.stack[vm.frames[vm.framesIndex - 1].basePointer + localIndex];
        vm.push(slot instanceof Cell ? slot.value : slot);
        break;
      }
      case Opcodes.OpGetBuiltin: {
        const builtinIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        vm.push(builtins[builtinIndex]);
        break;
      }
      case Opcodes.OpClosure: {
        const constIndex = (instructions[ip + 1] << 8) | instructions[ip + 2];
        const numFree = instructions[ip + 3];
        vm.frames[vm.framesIndex - 1].ip += 3;
        const fn = vm.constants[constIndex];
        const free = [];
        for (let i = vm.sp - numFree; i < vm.sp; i++) free.push(vm.stack[i]);
        vm.sp -= numFree;
        vm.push(vm._track(new Closure(fn, free)));
        break;
      }
      case Opcodes.OpGetFree: {
        const freeIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const freeVal = vm.frames[vm.framesIndex - 1].closure.free[freeIndex];
        vm.push(freeVal instanceof Cell ? freeVal.value : freeVal);
        break;
      }
      case Opcodes.OpSetFree: {
        const freeIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const val = vm.pop();
        const freeSlot = vm.frames[vm.framesIndex - 1].closure.free[freeIndex];
        if (freeSlot instanceof Cell) freeSlot.value = val;
        else vm.frames[vm.framesIndex - 1].closure.free[freeIndex] = val;
        break;
      }
      case Opcodes.OpMakeCell: {
        const val = vm.pop();
        vm.push(vm._track(new Cell(val)));
        break;
      }
      case Opcodes.OpGetLocalRaw: {
        const localIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        vm.push(vm.stack[vm.frames[vm.framesIndex - 1].basePointer + localIndex]);
        break;
      }
      case Opcodes.OpGetFreeRaw: {
        const freeIndex = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        vm.push(vm.frames[vm.framesIndex - 1].closure.free[freeIndex]);
        break;
      }
      case Opcodes.OpTailCall: {
        const numArgs = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const callee = vm.stack[vm.sp - 1 - numArgs];
        if (callee instanceof Closure) {
          if (numArgs !== callee.fn.numParameters) throw new Error(`wrong number of arguments: want=${callee.fn.numParameters}, got=${numArgs}`);
          const frame = vm.frames[vm.framesIndex - 1];
          const argStart = vm.sp - numArgs;
          for (let i = 0; i < numArgs; i++) vm.stack[frame.basePointer + i] = vm.stack[argStart + i];
          for (let i = numArgs; i < callee.fn.numLocals; i++) vm.stack[frame.basePointer + i] = null;
          vm.sp = frame.basePointer + callee.fn.numLocals;
          frame.closure = callee;
          frame.ip = -1;
        } else if (callee instanceof MonkeyBuiltin) {
          vm.callBuiltin(callee, numArgs);
        } else {
          throw new Error(`calling non-function: ${callee?.type?.() || typeof callee}`);
        }
        break;
      }
      case Opcodes.OpCurrentClosure:
        vm.push(vm.frames[vm.framesIndex - 1].closure);
        break;
      case Opcodes.OpDeepEqual: {
        const right = vm.pop();
        const left = vm.pop();
        vm.push(vm._deepEqual(left, right) ? TRUE : FALSE);
        break;
      }
      // Superinstructions (handled same as in VM)
      case Opcodes.OpIncrementLocal: {
        const localIdx = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const base = vm.frames[vm.framesIndex - 1].basePointer;
        const val = vm.stack[base + localIdx];
        if (typeof val === 'number') {
          vm.stack[base + localIdx] = val + 1;
        } else {
          vm.stack[base + localIdx] = (val && typeof val.value === 'number') ? val.value + 1 : 1;
        }
        break;
      }
      case Opcodes.OpAddSetLocal: {
        const localIdx = instructions[ip + 1];
        vm.frames[vm.framesIndex - 1].ip += 1;
        const right = vm.pop();
        const left = vm.pop();
        const base = vm.frames[vm.framesIndex - 1].basePointer;
        const lv = typeof left === 'number' ? left : (left && left.value) || 0;
        const rv = typeof right === 'number' ? right : (right && right.value) || 0;
        vm.stack[base + localIdx] = lv + rv;
        break;
      }
      case Opcodes.OpAddSetGlobal: {
        const globalIdx = (instructions[ip + 1] << 8) | instructions[ip + 2];
        vm.frames[vm.framesIndex - 1].ip += 2;
        const right = vm.pop();
        const left = vm.pop();
        const lv = typeof left === 'number' ? left : (left && left.value) || 0;
        const rv = typeof right === 'number' ? right : (right && right.value) || 0;
        vm.globals[globalIdx] = lv + rv;
        break;
      }
      default:
        throw new Error(`unknown opcode: ${op}`);
    }
  }

  // --- Breakpoints ---

  setBreakpoint(ip) { this.breakpoints.add(ip); }
  removeBreakpoint(ip) { this.breakpoints.delete(ip); }
  setOpcodeBreak(opcode) { this.opcodeBreaks.add(opcode); }
  clearBreakpoints() { this.breakpoints.clear(); this.opcodeBreaks.clear(); }

  _shouldBreak() {
    const ip = this.vm.frames[this.vm.framesIndex - 1].ip;
    if (this.breakpoints.has(ip)) return true;
    const instructions = this.vm.frames[this.vm.framesIndex - 1].instructions();
    if (this.opcodeBreaks.has(instructions[ip])) return true;
    return false;
  }

  // --- Inspection ---

  currentInstruction() {
    const ip = this.vm.frames[this.vm.framesIndex - 1].ip;
    const instructions = this.vm.frames[this.vm.framesIndex - 1].instructions();
    if (ip < 0 || ip >= instructions.length) return { ip, op: null, name: 'END', operands: [] };
    const op = instructions[ip];
    const def = lookup(op);
    if (!def) return { ip, op, name: `UNKNOWN(${op})`, operands: [] };
    const { operands, bytesRead } = readOperands(def, instructions, ip + 1);
    return { ip, op, name: def.name, operands };
  }

  inspectStack() {
    const items = [];
    for (let i = 0; i < this.vm.sp; i++) {
      const obj = this.vm.stack[i];
      items.push({ index: i, type: obj?.constructor?.name || typeof obj, value: obj?.inspect?.() ?? String(obj) });
    }
    return items;
  }

  inspectGlobals() {
    const items = [];
    for (let i = 0; i < this.vm.globals.length; i++) {
      if (this.vm.globals[i] !== undefined) {
        const obj = this.vm.globals[i];
        items.push({ index: i, type: obj?.constructor?.name || typeof obj, value: obj?.inspect?.() ?? String(obj) });
      }
    }
    return items;
  }

  inspectFrames() {
    const frames = [];
    for (let i = 0; i < this.vm.framesIndex; i++) {
      const frame = this.vm.frames[i];
      frames.push({
        index: i, ip: frame.ip, basePointer: frame.basePointer,
        numLocals: frame.closure.fn.numLocals, numParameters: frame.closure.fn.numParameters,
        freeCount: frame.closure.free?.length || 0,
      });
    }
    return frames;
  }

  inspectLocals() {
    const frame = this.vm.frames[this.vm.framesIndex - 1];
    const locals = [];
    for (let i = 0; i < frame.closure.fn.numLocals; i++) {
      const slot = this.vm.stack[frame.basePointer + i];
      let value = slot, isCell = false;
      if (slot instanceof Cell) { value = slot.value; isCell = true; }
      locals.push({ index: i, type: value?.constructor?.name || typeof value, value: value?.inspect?.() ?? String(value), isCell });
    }
    return locals;
  }

  /**
   * Get the result (last popped stack element).
   */
  result() {
    return this.vm.lastPoppedStackElem();
  }

  // --- Trace ---

  enableTrace(enabled = true) {
    this.traceEnabled = enabled;
    if (!enabled) this.trace = [];
  }

  _recordTrace() {
    if (this.trace.length >= this.maxTraceSize) this.trace.shift();
    const vm = this.vm;
    const ip = vm.frames[vm.framesIndex - 1].ip;
    const instructions = vm.frames[vm.framesIndex - 1].instructions();
    const op = instructions[ip];
    const def = lookup(op);
    this.trace.push({
      tick: this.instructionCount,
      frame: vm.framesIndex - 1,
      ip,
      op: def?.name || `UNKNOWN(${op})`,
      sp: vm.sp,
      stackTop: vm.sp > 0 ? (vm.stack[vm.sp - 1]?.inspect?.() ?? String(vm.stack[vm.sp - 1])) : null,
    });
  }

  formatTrace(limit = 50) {
    return this.trace.slice(-limit).map(e =>
      `[${String(e.tick).padStart(4)}] F${e.frame} @${String(e.ip).padStart(4)} ${e.op.padEnd(20)} sp=${e.sp}${e.stackTop ? ` top=${e.stackTop}` : ''}`
    ).join('\n');
  }
}

export { DebugState };
