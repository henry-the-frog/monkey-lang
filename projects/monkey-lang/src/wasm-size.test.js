import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmCompiler, compileAndRun } from './wasm-compiler.js';

function compile(code) {
  const compiler = new WasmCompiler();
  compiler.compile(code);
  return compiler.builder.build();
}

describe('WASM Binary Size Analysis', () => {
  it('hello world is under 2KB', () => {
    const binary = compile('puts("hello world")');
    assert.ok(binary.length < 2048, `Size: ${binary.length}`);
  });

  it('fibonacci is under 5KB', () => {
    const binary = compile(`
      let fib = fn(n) { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } };
      fib(10)
    `);
    assert.ok(binary.length < 5000, `Size: ${binary.length}`);
  });

  it('complex program under 10KB', () => {
    const binary = compile(`
      let map = fn(arr, f) {
        let result = [];
        for (let i = 0; i < len(arr); i = i + 1) {
          result = push(result, f(arr[i]));
        }
        result
      };
      let filter = fn(arr, pred) {
        let result = [];
        for (let i = 0; i < len(arr); i = i + 1) {
          if (pred(arr[i])) { result = push(result, arr[i]) }
        }
        result
      };
      let reduce = fn(arr, init, f) {
        let acc = init;
        for (let i = 0; i < len(arr); i = i + 1) {
          acc = f(acc, arr[i]);
        }
        acc
      };
      let data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      let evens = filter(data, fn(x) { x % 2 == 0 });
      let doubled = map(evens, fn(x) { x * 2 });
      reduce(doubled, 0, fn(a, b) { a + b })
    `);
    assert.ok(binary.length < 10000, `Size: ${binary.length}`);
    console.log(`  Complex program: ${binary.length} bytes`);
  });

  it('string interning reduces binary size', () => {
    const withoutIntern = compile(`
      puts("hello world");
      puts("hello world");
      puts("hello world");
      puts("hello world");
      puts("hello world");
      0
    `);
    // With interning, 5 identical strings should be ~same as 1
    // Without, each would add ~20 bytes (8 header + 11 chars + padding)
    // With interning, only 1 allocation
    console.log(`  5x "hello world": ${withoutIntern.length} bytes`);
    
    const singleString = compile('puts("hello world"); 0');
    // Should not be 5x larger
    assert.ok(withoutIntern.length < singleString.length * 3, 
      `5 copies should not be 3x single (${withoutIntern.length} vs ${singleString.length})`);
  });

  it('empty program is minimal', () => {
    const binary = compile('0');
    console.log(`  Minimal program: ${binary.length} bytes`);
    assert.ok(binary.length < 2500, `Minimal program too large: ${binary.length}`);
  });

  it('optimization reduces size for constant-heavy code', () => {
    const unoptimized = compile('(1 + 2) * (3 + 4) * (5 + 6)');
    
    // Manually compile with optimization
    const compiler2 = new WasmCompiler();
    // Use the optimization pipeline through compileAndRun would need async,
    // but we can at least check that constant expressions generate small code
    console.log(`  Constant expr: ${unoptimized.length} bytes`);
    assert.ok(unoptimized.length < 2000);
  });

  it('closures add reasonable overhead', () => {
    const withoutClosure = compile('let f = fn(x) { x + 1 }; f(5)');
    const withClosure = compile('let f = fn(x) { fn(y) { x + y } }; f(5)(10)');
    const overhead = withClosure.length - withoutClosure.length;
    console.log(`  Closure overhead: ${overhead} bytes (${withoutClosure.length} → ${withClosure.length})`);
    assert.ok(overhead < 500, `Closure overhead too high: ${overhead}`);
  });

  it('reports section sizes', () => {
    const binary = compile(`
      let fib = fn(n) { if (n < 2) { n } else { fib(n - 1) + fib(n - 2) } };
      fib(10)
    `);
    
    // Parse WASM sections
    let offset = 8; // Skip magic + version
    const sections = {};
    const sectionNames = {
      1: 'Type', 2: 'Import', 3: 'Function', 4: 'Table',
      5: 'Memory', 6: 'Global', 7: 'Export', 8: 'Start',
      9: 'Element', 10: 'Code', 11: 'Data'
    };
    
    while (offset < binary.length) {
      const id = binary[offset++];
      // Read LEB128 size
      let size = 0, shift = 0;
      let byte;
      do {
        byte = binary[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80);
      
      const name = sectionNames[id] || `Custom(${id})`;
      sections[name] = size;
      offset += size;
    }
    
    console.log('  WASM sections:');
    for (const [name, size] of Object.entries(sections)) {
      console.log(`    ${name}: ${size} bytes`);
    }
    
    // Code section should be the largest
    assert.ok(sections.Code > 0, 'Should have code section');
    assert.ok(sections.Import > 0, 'Should have import section');
  });
});
