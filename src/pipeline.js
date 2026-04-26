/**
 * Monkey-lang Compiler Pipeline
 * 
 * Connects all analysis and optimization passes into a unified pipeline:
 * Source → Parse → TypeCheck → CFG → SSA → ConstProp → Liveness → DCE → Escape
 * 
 * Each pass produces results that feed into the next.
 * The pipeline is configurable — individual passes can be enabled/disabled.
 */

import { Lexer } from './lexer.js';
import { Parser } from './parser.js';
import { TypeChecker } from './typechecker.js';
import { CFGBuilder } from './cfg.js';
import { SSABuilder, formatSSA } from './ssa.js';
import { ConstantPropagation } from './const-prop.js';
import { LivenessAnalysis } from './liveness.js';
import { DeadCodeEliminator, findDeadVariables, removeDeadLets } from './dce.js';
import { EscapeAnalyzer } from './escape.js';

class CompilerPipeline {
  constructor(options = {}) {
    this.options = {
      typecheck: true,
      cfg: true,
      ssa: true,
      constProp: true,
      liveness: true,
      dce: true,
      escape: true,
      ...options
    };
    this.results = {};
    this.timings = {};
  }

  /**
   * Run the full pipeline on source code
   */
  run(source) {
    const startTime = Date.now();
    this.results = {};
    this.timings = {};

    // === PARSE ===
    let t0 = Date.now();
    const lexer = new Lexer(source);
    const parser = new Parser(lexer);
    const program = parser.parseProgram();
    this.timings.parse = Date.now() - t0;
    
    if (parser.errors.length > 0) {
      this.results.parseErrors = parser.errors;
      return this._summary('parse-error');
    }
    this.results.program = program;
    this.results.stmtCount = program.statements.length;

    // === TYPE CHECK ===
    if (this.options.typecheck) {
      t0 = Date.now();
      const tc = new TypeChecker();
      const { errors, env } = tc.check(program);
      this.timings.typecheck = Date.now() - t0;
      this.results.typeErrors = errors;
      this.results.typeEnv = env;
    }

    // === DEAD CODE ELIMINATION (AST-level) ===
    if (this.options.dce) {
      t0 = Date.now();
      const dce = new DeadCodeEliminator();
      const optimized = dce.eliminate(program);
      this.results.dceWarnings = dce.warnings;
      this.results.dceEliminated = dce.eliminatedCount;
      
      // Find and remove dead let statements
      const deadVars = findDeadVariables(optimized);
      this.results.deadVars = deadVars;
      const { removed, converted } = removeDeadLets(optimized, deadVars);
      this.results.deadLetsRemoved = removed;
      this.results.deadLetsConverted = converted;
      
      // Update program reference to optimized version
      program.statements = optimized.statements;
      this.results.program = program;
      this.timings.dce = Date.now() - t0;
    }

    // === CFG ===
    if (this.options.cfg) {
      t0 = Date.now();
      const cfgBuilder = new CFGBuilder();
      const cfg = cfgBuilder.build(program);
      this.timings.cfg = Date.now() - t0;
      this.results.cfg = cfg;
      this.results.blockCount = cfg.blocks.size;

      // === DOMINATORS ===
      const dom = cfg.computeDominators();
      this.results.dominators = dom;

      // === LOOP DETECTION ===
      const loops = cfg.detectLoops();
      this.results.loops = loops;

      // === SSA ===
      if (this.options.ssa) {
        t0 = Date.now();
        const ssaBuilder = new SSABuilder(cfg);
        const ssa = ssaBuilder.build();
        this.timings.ssa = Date.now() - t0;
        this.results.ssa = ssa;

        // === CONSTANT PROPAGATION ===
        if (this.options.constProp) {
          t0 = Date.now();
          const cp = new ConstantPropagation();
          const cpResult = cp.propagate(ssa);
          this.timings.constProp = Date.now() - t0;
          this.results.constants = cpResult.constants;
          this.results.cpIterations = cpResult.iterations;
        }
      }

      // === LIVENESS ANALYSIS ===
      if (this.options.liveness) {
        t0 = Date.now();
        const liveness = new LivenessAnalysis(cfg);
        liveness.analyze();
        this.timings.liveness = Date.now() - t0;
        this.results.deadAssignments = liveness.findDeadAssignments();
        this.results.interference = liveness.buildInterferenceGraph();
      }
    }

    // === ESCAPE ANALYSIS ===
    if (this.options.escape) {
      t0 = Date.now();
      const ea = new EscapeAnalyzer();
      const escapeResult = ea.analyze(program);
      this.timings.escape = Date.now() - t0;
      this.results.stackAllocatable = escapeResult.stackAllocatable;
      this.results.heapRequired = escapeResult.heapRequired;
    }

    this.timings.total = Date.now() - startTime;
    return this._summary('ok');
  }

  _summary(status) {
    return {
      status,
      timings: this.timings,
      stats: {
        stmts: this.results.stmtCount || 0,
        blocks: this.results.blockCount || 0,
        typeErrors: this.results.typeErrors?.length || 0,
        parseErrors: this.results.parseErrors?.length || 0,
        constants: this.results.constants?.size || 0,
        deadVars: this.results.deadVars?.length || 0,
        deadLetsRemoved: this.results.deadLetsRemoved || 0,
        deadLetsConverted: this.results.deadLetsConverted || 0,
        deadAssignments: this.results.deadAssignments?.length || 0,
        dceEliminated: this.results.dceEliminated || 0,
        loops: this.results.loops?.length || 0,
        stackAllocatable: this.results.stackAllocatable?.length || 0,
        heapRequired: this.results.heapRequired?.length || 0,
      },
      results: this.results
    };
  }

  /**
   * Get a formatted report
   */
  report() {
    const s = this._summary(this.results.parseErrors?.length ? 'parse-error' : 'ok');
    const lines = [`Compiler Pipeline Report`];
    lines.push(`Status: ${s.status}`);
    lines.push(`Timing: ${s.timings.total}ms total`);
    lines.push('');
    lines.push(`Statements: ${s.stats.stmts}`);
    lines.push(`Basic blocks: ${s.stats.blocks}`);
    lines.push(`Type errors: ${s.stats.typeErrors}`);
    lines.push(`Constants found: ${s.stats.constants}`);
    lines.push(`Dead variables: ${s.stats.deadVars}`);
    lines.push(`Dead assignments: ${s.stats.deadAssignments}`);
    lines.push(`DCE eliminated: ${s.stats.dceEliminated}`);
    lines.push(`Loops: ${s.stats.loops}`);
    lines.push(`Stack-allocatable: ${s.stats.stackAllocatable}`);
    lines.push(`Heap-required: ${s.stats.heapRequired}`);
    
    for (const [phase, time] of Object.entries(s.timings)) {
      if (phase !== 'total') lines.push(`  ${phase}: ${time}ms`);
    }
    
    return lines.join('\n');
  }
}

export { CompilerPipeline };
