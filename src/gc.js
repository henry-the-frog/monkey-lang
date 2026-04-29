// gc.js — Mark-Sweep Garbage Collector for Monkey VM
//
// Design:
//   - All heap objects get registered with the GC on creation
//   - Root set: VM stack, globals, frame closures, free variables
//   - Mark phase: traverse from roots, mark all reachable objects
//   - Sweep phase: free all unmarked objects
//   - Trigger: allocation count threshold (configurable)
//
// Object graph edges:
//   - MonkeyArray → elements[]
//   - MonkeyHash → pairs (keys + values)
//   - Closure → fn (constants), free[]
//   - Cell → value
//
// This is educational — JS has its own GC, but implementing mark-sweep
// teaches the concepts and gives us control over memory pressure.

import {
  MonkeyInteger, MonkeyFloat, MonkeyString, MonkeyBoolean,
  MonkeyArray, MonkeyHash, MonkeyNull, MonkeyError, MonkeyBuiltin,
  ShapedHash, TRUE, FALSE, NULL,
} from './object.js';
import { Closure, Cell, CompiledFunction } from './compiler.js';

// Mark bit symbol — attached to objects during mark phase
const MARK = Symbol('gc_mark');
// Generation tag — tracks which generation an object belongs to
const GEN = Symbol('gc_generation');

export class GarbageCollector {
  constructor(options = {}) {
    // All tracked heap objects
    this.heap = new Set();       // Set of live objects
    this.threshold = options.threshold || 1024;  // allocations before GC triggers
    this.allocationsSinceGC = 0;
    this.enabled = options.enabled !== false;
    this.verbose = options.verbose || false;
    
    // Generational GC
    this.generational = options.generational || false;
    this.youngGen = new Set();   // Recently allocated objects
    this.oldGen = new Set();     // Objects that survived N collections
    this.promotionAge = options.promotionAge || 2; // survive N minor GCs → promote
    this.minorCollections = 0;   // count of minor GCs between major GCs
    this.majorInterval = options.majorInterval || 5; // major GC every N minor GCs
    
    // Weak references
    this.weakRefs = new Map();   // key → WeakRef(object) — for cache patterns
    
    // Write barrier tracking (for generational: old→young references)
    this.rememberedSet = new Set(); // old-gen objects that reference young-gen objects
    
    // Statistics
    this.stats = {
      collections: 0,
      minorCollections: 0,
      majorCollections: 0,
      totalAllocated: 0,
      totalFreed: 0,
      currentLive: 0,
      peakLive: 0,
      markTime: 0,
      sweepTime: 0,
      promotions: 0,
    };
    
    // VM reference (set when VM registers with GC)
    this.vm = null;
    
    // Immortal objects that should never be collected
    this.immortals = new Set([TRUE, FALSE, NULL]);
  }

  /**
   * Register the VM instance with the GC.
   */
  attach(vm) {
    this.vm = vm;
  }

  /**
   * Track a new heap allocation.
   * Called whenever the VM creates a new object.
   * Returns the object (for chaining).
   */
  track(obj) {
    if (!this.enabled) return obj;
    if (this.immortals.has(obj)) return obj;
    
    // Only track compound objects
    if (obj instanceof MonkeyArray || (obj instanceof MonkeyHash || obj instanceof ShapedHash) ||
        obj instanceof MonkeyString || obj instanceof MonkeyError ||
        obj instanceof Closure || obj instanceof Cell ||
        obj instanceof MonkeyInteger || obj instanceof MonkeyFloat) {
      this.heap.add(obj);
      this.stats.totalAllocated++;
      this.stats.currentLive = this.heap.size;
      if (this.heap.size > this.stats.peakLive) {
        this.stats.peakLive = this.heap.size;
      }
      
      // Generational: new objects go to young gen
      if (this.generational) {
        this.youngGen.add(obj);
        obj[GEN] = 0; // age = 0
      }
      
      this.allocationsSinceGC++;
      if (this.allocationsSinceGC >= this.threshold) {
        this.collect();
      }
    }
    
    return obj;
  }

  /**
   * Run a full mark-sweep collection.
   */
  collect() {
    if (!this.vm) return;
    
    if (this.generational) {
      this.minorCollections++;
      if (this.minorCollections >= this.majorInterval) {
        this._majorCollect();
        this.minorCollections = 0;
      } else {
        this._minorCollect();
      }
    } else {
      this._fullCollect();
    }
    
    this.allocationsSinceGC = 0;
  }

  /**
   * Full mark-sweep (non-generational).
   */
  _fullCollect() {
    const markStart = performance.now();
    this.mark();
    const markEnd = performance.now();
    const freed = this.sweep();
    const sweepEnd = performance.now();
    
    this.stats.collections++;
    this.stats.totalFreed += freed;
    this.stats.currentLive = this.heap.size;
    this.stats.markTime += markEnd - markStart;
    this.stats.sweepTime += sweepEnd - markEnd;
    
    if (this.verbose) {
      console.log(`[GC] Full collection #${this.stats.collections}: freed ${freed} objects, ${this.heap.size} live (${(markEnd - markStart).toFixed(2)}ms mark, ${(sweepEnd - markEnd).toFixed(2)}ms sweep)`);
    }
  }

  /**
   * Minor collection: only scan young generation + remembered set.
   */
  _minorCollect() {
    const markStart = performance.now();
    
    // Clear marks on young gen only
    for (const obj of this.youngGen) {
      obj[MARK] = false;
    }
    
    // Mark from roots (only trace into young gen)
    this._markRoots();
    
    // Also mark from remembered set (old→young references)
    for (const oldObj of this.rememberedSet) {
      this._traceYoung(oldObj);
    }
    
    const markEnd = performance.now();
    
    // Sweep young gen
    let freed = 0;
    const survivors = [];
    for (const obj of this.youngGen) {
      if (!obj[MARK]) {
        this.youngGen.delete(obj);
        this.heap.delete(obj);
        delete obj[MARK];
        delete obj[GEN];
        freed++;
      } else {
        // Survived — age it
        obj[GEN] = (obj[GEN] || 0) + 1;
        if (obj[GEN] >= this.promotionAge) {
          survivors.push(obj);
        }
        delete obj[MARK];
      }
    }
    
    // Promote survivors to old gen
    for (const obj of survivors) {
      this.youngGen.delete(obj);
      this.oldGen.add(obj);
      this.stats.promotions++;
    }
    
    const sweepEnd = performance.now();
    
    this.stats.collections++;
    this.stats.minorCollections++;
    this.stats.totalFreed += freed;
    this.stats.currentLive = this.heap.size;
    this.stats.markTime += markEnd - markStart;
    this.stats.sweepTime += sweepEnd - markEnd;
    
    if (this.verbose) {
      console.log(`[GC] Minor #${this.stats.minorCollections}: freed ${freed}, promoted ${survivors.length}, young=${this.youngGen.size}, old=${this.oldGen.size}`);
    }
  }

  /**
   * Major collection: full mark-sweep of both generations.
   */
  _majorCollect() {
    const markStart = performance.now();
    this.mark();
    const markEnd = performance.now();
    
    let freed = 0;
    // Sweep both generations
    for (const obj of this.heap) {
      if (!obj[MARK]) {
        this.heap.delete(obj);
        this.youngGen.delete(obj);
        this.oldGen.delete(obj);
        delete obj[MARK];
        delete obj[GEN];
        freed++;
      } else {
        delete obj[MARK];
      }
    }
    
    // Clear remembered set
    this.rememberedSet.clear();
    
    const sweepEnd = performance.now();
    
    this.stats.collections++;
    this.stats.majorCollections++;
    this.stats.totalFreed += freed;
    this.stats.currentLive = this.heap.size;
    this.stats.markTime += markEnd - markStart;
    this.stats.sweepTime += sweepEnd - markEnd;
    
    if (this.verbose) {
      console.log(`[GC] Major #${this.stats.majorCollections}: freed ${freed}, young=${this.youngGen.size}, old=${this.oldGen.size}`);
    }
  }

  /**
   * Mark phase: traverse from roots and mark all reachable objects.
   */
  mark() {
    // Clear all marks
    for (const obj of this.heap) {
      obj[MARK] = false;
    }
    
    // Mark from roots
    this._markRoots();
  }

  /**
   * Mark from all root sets.
   */
  _markRoots() {
    // 1. Stack
    for (let i = 0; i < this.vm.sp; i++) {
      this.markObject(this.vm.stack[i]);
    }
    
    // 2. Globals
    for (let i = 0; i < this.vm.globals.length; i++) {
      if (this.vm.globals[i] !== undefined) {
        this.markObject(this.vm.globals[i]);
      }
    }
    
    // 3. Call frames (closures and their free variables)
    for (let i = 0; i < this.vm.framesIndex; i++) {
      const frame = this.vm.frames[i];
      if (frame) {
        this.markObject(frame.closure);
      }
    }
    
    // 4. Constants pool
    for (const c of this.vm.constants) {
      this.markObject(c);
    }
  }

  /**
   * Trace from an old-gen object into young-gen objects (for minor GC).
   */
  _traceYoung(obj) {
    if (obj instanceof MonkeyArray) {
      for (const elem of obj.elements) {
        if (elem && this.youngGen.has(elem)) {
          elem[MARK] = true;
          this._traceYoung(elem);
        }
      }
    } else if ((obj instanceof MonkeyHash || obj instanceof ShapedHash)) {
      for (const [key, value] of obj.pairs) {
        if (key && this.youngGen.has(key)) { key[MARK] = true; this._traceYoung(key); }
        if (value && this.youngGen.has(value)) { value[MARK] = true; this._traceYoung(value); }
      }
    } else if (obj instanceof Closure && obj.free) {
      for (const freeVar of obj.free) {
        if (freeVar && this.youngGen.has(freeVar)) { freeVar[MARK] = true; this._traceYoung(freeVar); }
      }
    } else if (obj instanceof Cell) {
      if (obj.value && this.youngGen.has(obj.value)) { obj.value[MARK] = true; this._traceYoung(obj.value); }
    }
  }

  /**
   * Recursively mark an object and all objects it references.
   */
  markObject(obj) {
    if (obj === null || obj === undefined) return;
    if (this.immortals.has(obj)) return;
    
    // Already marked? Skip (prevents infinite loops on circular refs)
    if (obj[MARK] === true) return;
    
    // Mark it
    obj[MARK] = true;
    
    // Trace references
    if (obj instanceof MonkeyArray) {
      for (const elem of obj.elements) {
        this.markObject(elem);
      }
    } else if ((obj instanceof MonkeyHash || obj instanceof ShapedHash)) {
      for (const [key, value] of obj.pairs) {
        this.markObject(key);
        this.markObject(value);
      }
    } else if (obj instanceof Closure) {
      // Mark free variables
      if (obj.free) {
        for (const freeVar of obj.free) {
          this.markObject(freeVar);
        }
      }
      // Mark constants in the compiled function
      if (obj.fn && obj.fn.constants) {
        for (const c of obj.fn.constants) {
          this.markObject(c);
        }
      }
    } else if (obj instanceof Cell) {
      this.markObject(obj.value);
    }
    // MonkeyInteger, MonkeyFloat, MonkeyString, MonkeyBoolean, MonkeyNull,
    // MonkeyError, MonkeyBuiltin — no outgoing references
  }

  /**
   * Sweep phase: remove all unmarked objects from the heap.
   * Returns the number of objects freed.
   */
  sweep() {
    let freed = 0;
    for (const obj of this.heap) {
      if (!obj[MARK]) {
        this.heap.delete(obj);
        // Clean up the mark symbol
        delete obj[MARK];
        freed++;
      } else {
        // Clean up mark for next cycle
        delete obj[MARK];
      }
    }
    return freed;
  }

  /**
   * Force a collection regardless of threshold.
   */
  forceCollect() {
    if (this.generational) {
      this._majorCollect();
    } else {
      this._fullCollect();
    }
  }

  /**
   * Write barrier: called when an old-gen object gets a reference to a young-gen object.
   * Must be called by the VM when mutating object fields (arrays, hashes, cells).
   */
  writeBarrier(container, value) {
    if (!this.generational || !this.enabled) return;
    if (this.oldGen.has(container) && this.youngGen.has(value)) {
      this.rememberedSet.add(container);
    }
  }

  /**
   * Create a weak reference to an object.
   * Returns a key that can be used to retrieve the object if it's still alive.
   */
  makeWeakRef(key, obj) {
    this.weakRefs.set(key, new WeakRef(obj));
  }

  /**
   * Get a weakly-referenced object. Returns null if collected.
   */
  getWeakRef(key) {
    const ref = this.weakRefs.get(key);
    if (!ref) return null;
    const obj = ref.deref();
    if (!obj) {
      this.weakRefs.delete(key); // clean up dead refs
      return null;
    }
    return obj;
  }

  /**
   * Clean up dead weak references.
   */
  pruneWeakRefs() {
    for (const [key, ref] of this.weakRefs) {
      if (!ref.deref()) {
        this.weakRefs.delete(key);
      }
    }
  }

  /**
   * Get GC statistics.
   */
  getStats() {
    return {
      ...this.stats,
      heapSize: this.heap.size,
      allocationsSinceGC: this.allocationsSinceGC,
      threshold: this.threshold,
    };
  }

  /**
   * Reset GC state (for testing).
   */
  reset() {
    this.heap.clear();
    this.youngGen.clear();
    this.oldGen.clear();
    this.rememberedSet.clear();
    this.weakRefs.clear();
    this.allocationsSinceGC = 0;
    this.minorCollections = 0;
    this.stats = {
      collections: 0,
      minorCollections: 0,
      majorCollections: 0,
      totalAllocated: 0,
      totalFreed: 0,
      currentLive: 0,
      peakLive: 0,
      markTime: 0,
      sweepTime: 0,
      promotions: 0,
    };
  }

  /**
   * Generate a DOT graph of the current heap for visualization.
   * Useful for debugging and understanding object relationships.
   */
  heapDot() {
    const lines = ['digraph heap {', '  rankdir=LR;', '  node [shape=record];'];
    const id = (obj) => {
      if (obj instanceof MonkeyInteger) return `int_${obj.value}`;
      if (obj instanceof MonkeyFloat) return `float_${String(obj.value).replace('.', '_')}`;
      if (obj instanceof MonkeyString) return `str_${obj.value.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 20)}`;
      if (obj instanceof MonkeyArray) return `arr_${[...this.heap].indexOf(obj)}`;
      if ((obj instanceof MonkeyHash || obj instanceof ShapedHash)) return `hash_${[...this.heap].indexOf(obj)}`;
      if (obj instanceof Closure) return `closure_${[...this.heap].indexOf(obj)}`;
      if (obj instanceof Cell) return `cell_${[...this.heap].indexOf(obj)}`;
      return `obj_${[...this.heap].indexOf(obj)}`;
    };
    const label = (obj) => {
      if (obj instanceof MonkeyInteger) return `INT(${obj.value})`;
      if (obj instanceof MonkeyFloat) return `FLOAT(${obj.value})`;
      if (obj instanceof MonkeyString) return `STR("${obj.value.slice(0, 15)}")`;
      if (obj instanceof MonkeyArray) return `ARRAY[${obj.elements.length}]`;
      if ((obj instanceof MonkeyHash || obj instanceof ShapedHash)) return `HASH{${obj.pairs.size}}`;
      if (obj instanceof Closure) return `CLOSURE(${obj.fn?.numParameters || 0} params)`;
      if (obj instanceof Cell) return `CELL`;
      return `?`;
    };
    const gen = (obj) => {
      if (!this.generational) return '';
      if (this.oldGen.has(obj)) return ' [color=blue]';
      if (this.youngGen.has(obj)) return ' [color=green]';
      return '';
    };

    for (const obj of this.heap) {
      const nid = id(obj);
      lines.push(`  ${nid} [label="${label(obj)}"]${gen(obj)};`);
      
      if (obj instanceof MonkeyArray) {
        for (let i = 0; i < obj.elements.length; i++) {
          if (this.heap.has(obj.elements[i])) {
            lines.push(`  ${nid} -> ${id(obj.elements[i])} [label="${i}"];`);
          }
        }
      } else if ((obj instanceof MonkeyHash || obj instanceof ShapedHash)) {
        for (const [k, v] of obj.pairs) {
          if (this.heap.has(k)) lines.push(`  ${nid} -> ${id(k)} [label="key"];`);
          if (this.heap.has(v)) lines.push(`  ${nid} -> ${id(v)} [label="val"];`);
        }
      } else if (obj instanceof Closure && obj.free) {
        for (let i = 0; i < obj.free.length; i++) {
          if (this.heap.has(obj.free[i])) {
            lines.push(`  ${nid} -> ${id(obj.free[i])} [label="free${i}" style=dashed];`);
          }
        }
      } else if (obj instanceof Cell && obj.value && this.heap.has(obj.value)) {
        lines.push(`  ${nid} -> ${id(obj.value)} [label="value" style=dotted];`);
      }
    }
    
    lines.push('}');
    return lines.join('\n');
  }
}
