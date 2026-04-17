// ===== Event Emitter =====
// Full-featured event system with wildcards, namespaces, once, async

export class EventEmitter {
  constructor() {
    this._listeners = new Map();   // event → Set of {fn, once}
    this._wildcards = [];          // {pattern, fn, once}
    this._maxListeners = 10;
  }

  // ===== Core API =====

  on(event, fn) {
    if (event.includes('*')) {
      const regex = new RegExp('^' + event.replace(/\*/g, '.*') + '$');
      this._wildcards.push({ pattern: regex, fn, once: false, raw: event });
      return this;
    }
    
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push({ fn, once: false });
    return this;
  }

  once(event, fn) {
    if (event.includes('*')) {
      const regex = new RegExp('^' + event.replace(/\*/g, '.*') + '$');
      this._wildcards.push({ pattern: regex, fn, once: true, raw: event });
      return this;
    }
    
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push({ fn, once: true });
    return this;
  }

  off(event, fn) {
    if (event.includes('*')) {
      this._wildcards = this._wildcards.filter(w => !(w.raw === event && w.fn === fn));
      return this;
    }
    
    if (!fn) {
      this._listeners.delete(event);
      return this;
    }
    
    const listeners = this._listeners.get(event);
    if (listeners) {
      const idx = listeners.findIndex(l => l.fn === fn);
      if (idx !== -1) listeners.splice(idx, 1);
      if (listeners.length === 0) this._listeners.delete(event);
    }
    return this;
  }

  emit(event, ...args) {
    let called = 0;
    
    // Exact match
    const listeners = this._listeners.get(event);
    if (listeners) {
      const toRemove = [];
      for (let i = 0; i < listeners.length; i++) {
        listeners[i].fn(...args);
        called++;
        if (listeners[i].once) toRemove.push(i);
      }
      // Remove once listeners in reverse order
      for (let i = toRemove.length - 1; i >= 0; i--) {
        listeners.splice(toRemove[i], 1);
      }
      if (listeners.length === 0) this._listeners.delete(event);
    }
    
    // Wildcard matches
    const toRemoveWild = [];
    for (let i = 0; i < this._wildcards.length; i++) {
      const w = this._wildcards[i];
      if (w.pattern.test(event)) {
        w.fn(event, ...args);
        called++;
        if (w.once) toRemoveWild.push(i);
      }
    }
    for (let i = toRemoveWild.length - 1; i >= 0; i--) {
      this._wildcards.splice(toRemoveWild[i], 1);
    }
    
    return called > 0;
  }

  // Async emit — waits for all handlers (useful for async hooks)
  async emitAsync(event, ...args) {
    const promises = [];
    
    const listeners = this._listeners.get(event);
    if (listeners) {
      const toRemove = [];
      for (let i = 0; i < listeners.length; i++) {
        promises.push(Promise.resolve(listeners[i].fn(...args)));
        if (listeners[i].once) toRemove.push(i);
      }
      for (let i = toRemove.length - 1; i >= 0; i--) {
        listeners.splice(toRemove[i], 1);
      }
    }
    
    for (const w of this._wildcards) {
      if (w.pattern.test(event)) {
        promises.push(Promise.resolve(w.fn(event, ...args)));
      }
    }
    
    await Promise.all(promises);
    return promises.length > 0;
  }

  // ===== Utility =====

  listenerCount(event) {
    let count = (this._listeners.get(event) || []).length;
    for (const w of this._wildcards) {
      if (w.pattern.test(event)) count++;
    }
    return count;
  }

  listeners(event) {
    return (this._listeners.get(event) || []).map(l => l.fn);
  }

  prependListener(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).unshift({ fn, once: false });
    return this;
  }

  get maxListeners() { return this._maxListeners; }
  set maxListeners(n) { this._maxListeners = n; }

  eventNames() {
    return [...this._listeners.keys()];
  }

  removeAllListeners(event) {
    if (event) {
      this._listeners.delete(event);
      this._wildcards = this._wildcards.filter(w => !w.pattern.test(event));
    } else {
      this._listeners.clear();
      this._wildcards = [];
    }
    return this;
  }

  // Wait for an event (returns a promise)
  waitFor(event, { timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const handler = (...args) => {
        if (timer) clearTimeout(timer);
        resolve(args.length === 1 ? args[0] : args);
      };
      
      this.once(event, handler);
      
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.off(event, handler);
          reject(new Error(`Timeout waiting for "${event}"`));
        }, timeout);
      }
    });
  }

  // Pipe all events to another emitter
  pipe(target, events) {
    const handler = (event, ...args) => target.emit(event, ...args);
    if (events) {
      for (const event of events) {
        this.on(event, (...args) => target.emit(event, ...args));
      }
    } else {
      this.on('*', handler);
    }
    return this;
  }
}

export function mixin(obj) {
  const ee = new EventEmitter();
  for (const method of ['on', 'off', 'once', 'emit', 'removeAllListeners', 'listeners', 'listenerCount', 'prependListener', 'onAny']) {
    if (typeof ee[method] === 'function') {
      obj[method] = ee[method].bind(ee);
    }
  }
  return obj;
}
