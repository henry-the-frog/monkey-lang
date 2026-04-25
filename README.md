# Monkey-lang

[![CI](https://github.com/henry-the-frog/monkey-lang/actions/workflows/ci.yml/badge.svg)](https://github.com/henry-the-frog/monkey-lang/actions/workflows/ci.yml)

A complete programming language runtime in JavaScript — a mini-V8 with 20,500+ lines of compiler and runtime infrastructure.

## Features

- **Lexer + Parser** → Rich AST with closures, loops, higher-order functions
- **Tree-walking Evaluator** → Direct interpretation
- **Bytecode Compiler + VM** → Stack-based virtual machine with GC
- **Type System** → Hindley-Milner type inference (Algorithm W) — 82 tests
- **Optimization Pipeline** → SSA, constant propagation, dead code elimination, escape analysis
- **Bytecode Optimizer** → DCE, peephole (4 patterns), jump threading — 42% reduction
- **Constant Substitution** → Inter-variable propagation before compilation
- **Register Allocator** → Chaitin-Briggs graph coloring
- **Hidden Classes** → V8-style shapes for hash optimization
- **GC** → Mark-sweep with generational support
- **Debugger** → Breakpoints, step-over/into/out, stack inspection
- **38 test files, ~8,735 test cases** → Comprehensive coverage

## Compiler Pipeline

```
Source Code
    │
    ▼
┌─────────┐    ┌──────────────┐    ┌──────────┐
│  Lexer  │ →  │    Parser    │ →  │   AST    │
└─────────┘    └──────────────┘    └──────────┘
                                        │
                    ┌───────────────────┬┴──────────────────┐
                    │                   │                    │
                    ▼                   ▼                    ▼
            ┌──────────────┐  ┌──────────────┐    ┌──────────────┐
            │ Type Checker │  │     CFG      │    │     DCE      │
            │ (Algorithm W)│  │ Basic Blocks │    │ Dead Code    │
            └──────┬───────┘  └──────┬───────┘    └──────────────┘
                   │                 │
                   ▼                 ▼
            ┌──────────────┐  ┌──────────────┐
            │  Type Info   │  │     SSA      │
            │ (LSP Hover)  │  │  (Cytron)    │
            └──────────────┘  └──────┬───────┘
                                     │
                    ┌────────────────┬┴──────────────────┐
                    │                │                    │
                    ▼                ▼                    ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  Const Prop  │  │  Liveness    │  │   Escape     │
            │   (SCCP)     │  │  Analysis    │  │  Analysis    │
            └──────────────┘  └──────┬───────┘  └──────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │  Reg Alloc   │
                              │ Graph Color  │
                              └──────────────┘
                                     │
                    ┌────────────────┬┴──────────────────┐
                    │                │                    │
                    ▼                ▼                    ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  Evaluator   │  │  Bytecode    │  │  Bytecode    │
            │ (tree-walk)  │  │  Compiler    │  │  Optimizer   │
            └──────────────┘  └──────────────┘  └──────────────┘
```

## Module Catalog

### Frontend
| Module | File | Description |
|--------|------|-------------|
| Lexer | `src/lexer.js` | Tokenization |
| Parser | `src/parser.js` | Recursive descent, all expression types |
| AST | `src/ast.js` | Expression/Statement nodes |

### Type System
| Module | File | Description |
|--------|------|-------------|
| Type Checker | `src/typechecker.js` | Algorithm W, HM inference |
| Type Info | `src/type-info.js` | LSP-like hover (inferred types) |
| Type Tracer | `src/type-tracer.js` | Step-by-step inference visualization |

### Analysis
| Module | File | Description |
|--------|------|-------------|
| CFG | `src/cfg.js` | Basic blocks, dominators, loop detection, DOT export |
| SSA | `src/ssa.js` | Cytron algorithm, phi nodes, variable renaming |
| Constant Propagation | `src/const-prop.js` | SCCP, lattice-based analysis |
| Liveness | `src/liveness.js` | Backward dataflow, dead assignments |
| Dead Code Elimination | `src/dce.js` | Unreachable code, constant conditions |
| Escape Analysis | `src/escape.js` | Stack vs heap allocation decisions |
| Register Allocator | `src/regalloc.js` | Graph coloring (Chaitin-Briggs) + Linear scan |
| Pipeline | `src/pipeline.js` | Unified: all passes in sequence |

### Optimization
| Module | File | Description |
|--------|------|-------------|
| Typed Optimizer | `src/typed-optimizer.js` | Constant folding, strength reduction |
| Inline Caching | `src/shape.js` | V8-style shapes + IC |

### Backends
| Module | File | Description |
|--------|------|-------------|
| Evaluator | `src/evaluator.js` | Tree-walking interpreter |
| Bytecode Compiler | `src/compiler.js` | Stack-based bytecode with const substitution |
| VM | `src/vm.js` | Virtual machine with GC |
| Bytecode Optimizer | `src/optimizer.js` | DCE, peephole, jump threading |

### Runtime
| Module | File | Description |
|--------|------|-------------|
| GC | `src/gc.js` | Mark-sweep, generational |
| Hidden Classes | `src/shape.js` | V8-style shapes + inline caching |
| Debugger | `src/debugger.js` | Breakpoints, stepping, stack inspection |

### Testing
| File | Description |
|------|-------------|
| 38 test files | `src/*.test.js` |
| Parity tests | Evaluator ↔ VM equivalence |
| Integration | End-to-end compilation |
| Stress tests | Complex programs |

## Running

```bash
# REPL
node repl.js

# With type checking
node repl.js --typecheck

# Run all tests
for f in src/*.test.js; do node "$f"; done

# Run compiler pipeline on source
node -e "import {CompilerPipeline} from './src/pipeline.js'; const p = new CompilerPipeline(); console.log(p.run('let x = 5; let y = x + 1;').stats)"
```

## Language Features

- **Data types**: integers, strings, booleans, arrays, hashes, null
- **Functions**: first-class closures, recursion, default params
- **Control flow**: if/else, while, for-in, match/case
- **Operators**: arithmetic, comparison, string concat, logical
- **Built-ins**: puts, len, first, last, rest, push, type
- **Advanced**: generators (yield), try/catch, spread operator, destructuring
