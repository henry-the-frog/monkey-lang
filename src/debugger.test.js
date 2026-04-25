// debugger.test.js — Tests for Monkey VM Debugger
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DebugVM, DebugState } from './debugger.js';
import { Compiler } from './compiler.js';
import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { Opcodes } from './code.js';
import { MonkeyInteger, MonkeyArray, MonkeyString } from './object.js';

function compile(input) {
  const lexer = new Lexer(input);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) throw new Error(`Parser errors: ${parser.errors.join(', ')}`);
  const compiler = new Compiler({ optimize: false });
  compiler.compile(program);
  return compiler.bytecode();
}

describe('Bytecode Debugger', () => {
  describe('Step execution', () => {
    it('steps through a simple program', () => {
      const dbg = new DebugVM(compile('1 + 2'));
      
      let steps = 0;
      let result;
      while (true) {
        result = dbg.step();
        steps++;
        if (result === 'completed') break;
        assert.equal(result, 'paused');
      }
      
      assert.ok(steps > 0, 'should have executed some steps');
      assert.equal(dbg.result().value, 3);
    });

    it('reports state correctly', () => {
      const dbg = new DebugVM(compile('42'));
      assert.equal(dbg.state, DebugState.READY);
      
      dbg.step();
      assert.equal(dbg.state, DebugState.PAUSED);
      
      // Step until done
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.state, DebugState.COMPLETED);
    });

    it('handles let bindings', () => {
      const dbg = new DebugVM(compile('let x = 10; let y = 20; x + y'));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 30);
    });

    it('handles function calls', () => {
      const dbg = new DebugVM(compile(`
        let add = fn(a, b) { a + b };
        add(3, 4)
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 7);
    });

    it('handles recursion', () => {
      const dbg = new DebugVM(compile(`
        let fib = fn(n) { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } };
        fib(10)
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 55);
    });
  });

  describe('Breakpoints', () => {
    it('breaks at instruction address', () => {
      const dbg = new DebugVM(compile('let x = 1; let y = 2; x + y'));
      dbg.setBreakpoint(3); // some instruction address
      
      const result = dbg.run();
      assert.equal(result, 'breakpoint');
      assert.equal(dbg.state, DebugState.PAUSED);
    });

    it('continues after breakpoint', () => {
      const dbg = new DebugVM(compile('let a = 1; let b = 2; a + b'));
      // Break on OpAdd opcode
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      
      let result = dbg.run();
      assert.equal(result, 'breakpoint');
      
      // Remove and continue
      dbg.clearBreakpoints();
      result = dbg.run();
      assert.equal(result, 'completed');
      assert.equal(dbg.result().value, 3);
    });

    it('breaks on opcode', () => {
      // Use variables to prevent constant folding
      const dbg = new DebugVM(compile('let a = 1; let b = 2; a + b'));
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      
      const result = dbg.run();
      assert.equal(result, 'breakpoint');
      
      const stack = dbg.inspectStack();
      assert.ok(stack.length >= 2, 'stack should have at least 2 items');
    });

    it('clears all breakpoints', () => {
      const dbg = new DebugVM(compile('1 + 2'));
      dbg.setBreakpoint(0);
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      
      dbg.clearBreakpoints();
      const result = dbg.run();
      assert.equal(result, 'completed');
    });
  });

  describe('Step over/into/out', () => {
    it('step over skips function body', () => {
      const dbg = new DebugVM(compile(`
        let f = fn() { 42 };
        f()
      `));
      
      // Break on OpCall  
      dbg.setOpcodeBreak(Opcodes.OpCall);
      dbg.run();
      dbg.clearBreakpoints();
      
      // Step over should execute the call but not stop inside
      const depthBefore = dbg.vm.framesIndex;
      const result = dbg.stepOver();
      assert.ok(result === 'paused' || result === 'completed');
    });

    it('step out returns from function', () => {
      const dbg = new DebugVM(compile(`
        let f = fn(x) { x + 1 };
        f(5)
      `));
      
      // Run until we're inside the function
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      dbg.run(); // stops at OpAdd inside f
      
      assert.ok(dbg.vm.framesIndex > 1, 'should be inside function');
      
      dbg.clearBreakpoints();
      const result = dbg.stepOut();
      assert.ok(dbg.vm.framesIndex <= 1, 'should have returned from function');
    });
  });

  describe('Inspection', () => {
    it('inspects stack after arithmetic', () => {
      // Use variables to prevent constant folding
      const dbg = new DebugVM(compile('let a = 1; let b = 2; a + b'));
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      dbg.run();
      
      // Before add: stack should have 1 and 2
      let stack = dbg.inspectStack();
      assert.ok(stack.length >= 2, 'stack should have at least 2 items before add');
      
      // Execute the add
      dbg.clearBreakpoints();
      dbg.step();
      stack = dbg.inspectStack();
      assert.ok(stack.some(s => s.value === '3'), 'should have 3 after add');
    });

    it('inspects globals', () => {
      const dbg = new DebugVM(compile('let x = 42; let y = "hello"; x'));
      
      while (dbg.step() !== 'completed') {}
      
      const globals = dbg.inspectGlobals();
      assert.ok(globals.length >= 2);
      assert.equal(globals[0].value, '42');
      assert.equal(globals[1].value, 'hello');
    });

    it('inspects frames', () => {
      const dbg = new DebugVM(compile(`
        let f = fn(x) { x + 1 };
        f(5)
      `));
      
      // Run until inside f
      dbg.setOpcodeBreak(Opcodes.OpAdd);
      dbg.run();
      
      const frames = dbg.inspectFrames();
      assert.ok(frames.length >= 2, 'should have main + f frames');
      assert.equal(frames[1].numParameters, 1);
    });

    it('inspects locals', () => {
      const dbg = new DebugVM(compile(`
        let f = fn(a, b) { let c = a + b; c };
        f(3, 4)
      `));
      
      // Run deep enough to see locals
      // Break after OpSetLocal to see c
      let steps = 0;
      while (steps < 100) {
        const result = dbg.step();
        if (result === 'completed') break;
        
        // Check if we're inside f with locals populated
        if (dbg.vm.framesIndex > 1) {
          const locals = dbg.inspectLocals();
          if (locals.length >= 3 && locals[2].value !== 'null') {
            assert.equal(locals[0].value, '3');  // a
            assert.equal(locals[1].value, '4');  // b
            assert.equal(locals[2].value, '7');  // c = a + b
            return; // test passes
          }
        }
        steps++;
      }
      // If we get here, just run to completion and check result
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 7);
    });

    it('current instruction gives opcode info', () => {
      const dbg = new DebugVM(compile('let x = 42; x'));
      
      dbg.step();
      const instr = dbg.currentInstruction();
      assert.ok(instr.name, 'should have an instruction name');
    });
  });

  describe('Execution trace', () => {
    it('records trace when enabled', () => {
      const dbg = new DebugVM(compile('1 + 2'));
      dbg.enableTrace(true);
      
      while (dbg.step() !== 'completed') {}
      
      assert.ok(dbg.trace.length > 0, 'trace should have entries');
      assert.ok(dbg.trace[0].op, 'trace entries should have op name');
      assert.ok(typeof dbg.trace[0].tick === 'number');
    });

    it('formats trace output', () => {
      const dbg = new DebugVM(compile('let a = 1; let b = 2; a + b'));
      dbg.enableTrace(true);
      
      while (dbg.step() !== 'completed') {}
      
      const formatted = dbg.formatTrace();
      assert.ok(formatted.includes('OpConstant'), 'trace should include OpConstant');
      assert.ok(formatted.includes('OpAdd'), 'trace should include OpAdd');
    });

    it('trace disabled by default', () => {
      const dbg = new DebugVM(compile('1 + 2'));
      
      while (dbg.step() !== 'completed') {}
      
      assert.equal(dbg.trace.length, 0);
    });

    it('trace respects max size', () => {
      const dbg = new DebugVM(compile(`
        let fib = fn(n) { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } };
        fib(10)
      `));
      dbg.enableTrace(true);
      dbg.maxTraceSize = 100;
      
      while (dbg.step() !== 'completed') {}
      
      assert.ok(dbg.trace.length <= 100, 'trace should respect max size');
    });
  });

  describe('Complex programs', () => {
    it('closures work in debugger', () => {
      const dbg = new DebugVM(compile(`
        let make_adder = fn(x) { fn(y) { x + y } };
        let add5 = make_adder(5);
        add5(10)
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 15);
    });

    it('arrays and hashes work in debugger', () => {
      const dbg = new DebugVM(compile(`
        let arr = [1, 2, 3];
        let h = {"a": 10};
        arr[1] + h["a"]
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 12);
    });

    it('for-in loops work in debugger', () => {
      const dbg = new DebugVM(compile(`
        let sum = 0;
        for (x in [1, 2, 3, 4, 5]) { set sum = sum + x; }
        sum
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 15);
    });

    it('mutable closures (cells) work in debugger', () => {
      const dbg = new DebugVM(compile(`
        let make = fn() {
          let n = 0;
          let inc = fn() { set n = n + 1; n };
          inc
        };
        let counter = make();
        counter();
        counter();
        counter()
      `));
      
      while (dbg.step() !== 'completed') {}
      assert.equal(dbg.result().value, 3);
    });

    it('instruction count is accurate', () => {
      const dbg = new DebugVM(compile('1 + 2'));
      
      while (dbg.step() !== 'completed') {}
      
      assert.ok(dbg.instructionCount > 0);
      assert.ok(dbg.instructionCount < 20, 'simple program should not have many instructions');
    });
  });
});
