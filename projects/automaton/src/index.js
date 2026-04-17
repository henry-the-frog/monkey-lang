// ===== Finite Automaton Library =====
// NFA, DFA, subset construction (NFA→DFA), regex to NFA (Thompson's)

const EPSILON = null; // ε-transitions

// ===== NFA =====

export class NFA {
  constructor() {
    this.states = new Set();
    this.transitions = new Map(); // "state,symbol" → Set of states
    this.start = null;
    this.accept = new Set();
    this._nextState = 0;
  }

  addState(isAccept = false) {
    const id = this._nextState++;
    this.states.add(id);
    if (isAccept) this.accept.add(id);
    return id;
  }

  addTransition(from, symbol, to) {
    const key = `${from},${symbol === EPSILON ? 'ε' : symbol}`;
    if (!this.transitions.has(key)) this.transitions.set(key, new Set());
    this.transitions.get(key).add(to);
  }

  // Get states reachable from `state` on `symbol`
  move(states, symbol) {
    const result = new Set();
    for (const state of states) {
      const key = `${state},${symbol}`;
      const targets = this.transitions.get(key);
      if (targets) for (const t of targets) result.add(t);
    }
    return result;
  }

  // ε-closure: all states reachable via ε-transitions
  epsilonClosure(states) {
    const closure = new Set(states);
    const stack = [...states];
    
    while (stack.length > 0) {
      const state = stack.pop();
      const key = `${state},ε`;
      const targets = this.transitions.get(key);
      if (targets) {
        for (const t of targets) {
          if (!closure.has(t)) {
            closure.add(t);
            stack.push(t);
          }
        }
      }
    }
    
    return closure;
  }

  // Test if NFA accepts a string
  accepts(input) {
    let current = this.epsilonClosure(new Set([this.start]));
    
    for (const symbol of input) {
      current = this.epsilonClosure(this.move(current, symbol));
    }
    
    for (const state of current) {
      if (this.accept.has(state)) return true;
    }
    return false;
  }

  // Get alphabet
  get alphabet() {
    const symbols = new Set();
    for (const key of this.transitions.keys()) {
      const symbol = key.split(',').slice(1).join(',');
      if (symbol !== 'ε') symbols.add(symbol);
    }
    return symbols;
  }
}

// ===== DFA =====

export class DFA {
  constructor() {
    this.states = new Set();
    this.transitions = new Map(); // "state,symbol" → state
    this.start = null;
    this.accept = new Set();
  }

  addState(name, opts = {}) {
    this.states.add(name);
    if (opts.start) this.start = name;
    if (opts.accept) this.accept.add(name);
    return this;
  }

  addTransition(from, symbol, to) {
    this.transitions.set(`${from},${symbol}`, to);
    return this;
  }

  getTransition(state, symbol) {
    return this.transitions.get(`${state},${symbol}`);
  }

  accepts(input) {
    let current = this.start;
    for (const symbol of input) {
      current = this.getTransition(current, symbol);
      if (current === undefined) return false;
    }
    return this.accept.has(current);
  }

  run(input) { return this.accepts(input); }

  get stateCount() { return this.states.size; }

  trace(input) {
    const path = [this.start];
    let current = this.start;
    for (const symbol of input) {
      current = this.getTransition(current, symbol);
      if (current === undefined) { path.push(null); return { path, accepted: false }; }
      path.push(current);
    }
    return { path, accepted: this.accept.has(current) };
  }

  minimize() {
    // Hopcroft's algorithm (simplified)
    const states = [...this.states];
    const acceptSet = new Set([...this.accept]);
    const nonAccept = states.filter(s => !acceptSet.has(s));
    const alphabet = new Set();
    for (const key of this.transitions.keys()) {
      alphabet.add(key.split(',').slice(1).join(','));
    }
    
    let partitions = [];
    if (nonAccept.length > 0) partitions.push(new Set(nonAccept));
    if (acceptSet.size > 0) partitions.push(new Set(acceptSet));
    
    let changed = true;
    while (changed) {
      changed = false;
      const newPartitions = [];
      for (const group of partitions) {
        for (const sym of alphabet) {
          const map = new Map();
          for (const state of group) {
            const target = this.getTransition(state, sym);
            const targetPart = partitions.findIndex(p => p.has(target));
            const key = target === undefined ? -1 : targetPart;
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(state);
          }
          if (map.size > 1) {
            changed = true;
            for (const [, subset] of map) newPartitions.push(subset);
            break;
          }
        }
        if (!changed || newPartitions.length === 0) newPartitions.push(group);
        if (changed) {
          // Add remaining unprocessed partitions
          for (const p of partitions) {
            if (!newPartitions.includes(p) && p !== group) newPartitions.push(p);
          }
          break;
        }
      }
      if (changed) partitions = newPartitions;
    }
    
    const min = new DFA();
    const stateMap = new Map();
    for (let i = 0; i < partitions.length; i++) {
      const name = `s${i}`;
      const group = partitions[i];
      const isStart = [...group].some(s => s === this.start);
      const isAccept = [...group].some(s => this.accept.has(s));
      min.addState(name, { start: isStart, accept: isAccept });
      for (const s of group) stateMap.set(s, name);
    }
    for (const [key, target] of this.transitions) {
      const [from, ...symParts] = key.split(',');
      const sym = symParts.join(',');
      const fromMapped = stateMap.get(from);
      const toMapped = stateMap.get(target);
      if (fromMapped && toMapped) min.addTransition(fromMapped, sym, toMapped);
    }
    return min;
  }
}

// ===== NFA to DFA (Subset Construction) =====

export function nfaToDFA(nfa) {
  const dfa = new DFA();
  const alphabet = nfa.alphabet;
  
  const startClosure = nfa.epsilonClosure(new Set([nfa.start]));
  const startKey = setKey(startClosure);
  
  dfa.start = startKey;
  dfa.states.add(startKey);
  
  if (hasAccept(startClosure, nfa.accept)) dfa.accept.add(startKey);
  
  const queue = [startClosure];
  const seen = new Set([startKey]);
  
  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = setKey(current);
    
    for (const symbol of alphabet) {
      const moved = nfa.epsilonClosure(nfa.move(current, symbol));
      if (moved.size === 0) continue;
      
      const movedKey = setKey(moved);
      dfa.addTransition(currentKey, symbol, movedKey);
      
      if (!seen.has(movedKey)) {
        seen.add(movedKey);
        dfa.states.add(movedKey);
        if (hasAccept(moved, nfa.accept)) dfa.accept.add(movedKey);
        queue.push(moved);
      }
    }
  }
  
  return dfa;
}

function setKey(set) { return [...set].sort().join(','); }
function hasAccept(states, acceptStates) {
  for (const s of states) if (acceptStates.has(s)) return true;
  return false;
}

// ===== Regex to NFA (Thompson's Construction) =====

export function regexToNFA(pattern) {
  const tokens = tokenizeRegex(pattern);
  let pos = 0;
  
  function peek() { return tokens[pos]; }
  function advance() { return tokens[pos++]; }
  
  function parseExpr() {
    let left = parseTerm();
    while (peek() === '|') {
      advance();
      const right = parseTerm();
      left = alternate(left, right);
    }
    return left;
  }
  
  function parseTerm() {
    let result = null;
    while (pos < tokens.length && peek() !== ')' && peek() !== '|') {
      const factor = parseFactor();
      result = result ? concatenate(result, factor) : factor;
    }
    return result || emptyNFA();
  }
  
  function parseFactor() {
    let base = parseAtom();
    if (peek() === '*') { advance(); base = kleeneStar(base); }
    else if (peek() === '+') { advance(); base = kleenePlus(base); }
    else if (peek() === '?') { advance(); base = optional(base); }
    return base;
  }
  
  function parseAtom() {
    if (peek() === '(') {
      advance();
      const expr = parseExpr();
      advance(); // )
      return expr;
    }
    const ch = advance();
    return charNFA(ch);
  }
  
  const nfa = parseExpr();
  return nfa;
}

function tokenizeRegex(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) {
      tokens.push(pattern[++i]);
    } else {
      tokens.push(pattern[i]);
    }
  }
  return tokens;
}

function charNFA(ch) {
  const nfa = new NFA();
  const s = nfa.addState();
  const e = nfa.addState(true);
  nfa.start = s;
  nfa.addTransition(s, ch, e);
  return nfa;
}

function emptyNFA() {
  const nfa = new NFA();
  const s = nfa.addState(true);
  nfa.start = s;
  return nfa;
}

function concatenate(a, b) {
  const nfa = new NFA();
  nfa._nextState = 0;
  
  // Copy states from a
  const aMap = new Map();
  for (const s of a.states) { aMap.set(s, nfa.addState()); }
  nfa.start = aMap.get(a.start);
  
  // Copy states from b
  const bMap = new Map();
  for (const s of b.states) { bMap.set(s, nfa.addState(b.accept.has(s))); }
  
  // Copy transitions
  for (const [key, targets] of a.transitions) {
    const [from, ...symbolParts] = key.split(',');
    const symbol = symbolParts.join(',');
    for (const to of targets) {
      nfa.addTransition(aMap.get(Number(from)), symbol === 'ε' ? EPSILON : symbol, aMap.get(to));
    }
  }
  for (const [key, targets] of b.transitions) {
    const [from, ...symbolParts] = key.split(',');
    const symbol = symbolParts.join(',');
    for (const to of targets) {
      nfa.addTransition(bMap.get(Number(from)), symbol === 'ε' ? EPSILON : symbol, bMap.get(to));
    }
  }
  
  // ε-transitions from a's accept states to b's start
  for (const s of a.accept) {
    nfa.addTransition(aMap.get(s), EPSILON, bMap.get(b.start));
  }
  
  return nfa;
}

function alternate(a, b) {
  const nfa = new NFA();
  nfa._nextState = 0;
  const start = nfa.addState();
  const end = nfa.addState(true);
  nfa.start = start;
  
  const aMap = new Map();
  for (const s of a.states) aMap.set(s, nfa.addState());
  const bMap = new Map();
  for (const s of b.states) bMap.set(s, nfa.addState());
  
  // Copy transitions
  for (const [key, targets] of a.transitions) {
    const [from, ...sp] = key.split(',');
    const sym = sp.join(',');
    for (const to of targets) nfa.addTransition(aMap.get(Number(from)), sym === 'ε' ? EPSILON : sym, aMap.get(to));
  }
  for (const [key, targets] of b.transitions) {
    const [from, ...sp] = key.split(',');
    const sym = sp.join(',');
    for (const to of targets) nfa.addTransition(bMap.get(Number(from)), sym === 'ε' ? EPSILON : sym, bMap.get(to));
  }
  
  nfa.addTransition(start, EPSILON, aMap.get(a.start));
  nfa.addTransition(start, EPSILON, bMap.get(b.start));
  for (const s of a.accept) nfa.addTransition(aMap.get(s), EPSILON, end);
  for (const s of b.accept) nfa.addTransition(bMap.get(s), EPSILON, end);
  
  return nfa;
}

function kleeneStar(a) {
  const nfa = new NFA();
  nfa._nextState = 0;
  const start = nfa.addState(true); // accept empty string
  nfa.start = start;
  
  const aMap = new Map();
  for (const s of a.states) aMap.set(s, nfa.addState());
  
  for (const [key, targets] of a.transitions) {
    const [from, ...sp] = key.split(',');
    const sym = sp.join(',');
    for (const to of targets) nfa.addTransition(aMap.get(Number(from)), sym === 'ε' ? EPSILON : sym, aMap.get(to));
  }
  
  nfa.addTransition(start, EPSILON, aMap.get(a.start));
  for (const s of a.accept) {
    nfa.addTransition(aMap.get(s), EPSILON, start);
  }
  
  return nfa;
}

function kleenePlus(a) {
  return concatenate(a, kleeneStar(a));
}

function optional(a) {
  return alternate(a, emptyNFA());
}

export { EPSILON };
