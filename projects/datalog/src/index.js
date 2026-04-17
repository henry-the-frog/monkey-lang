/**
 * Tiny Datalog
 * 
 * Logic programming database query language:
 * - Facts (ground atoms)
 * - Rules with head and body
 * - Bottom-up evaluation (semi-naive)
 * - Queries with variable binding
 * - Stratified negation
 */

class Datalog {
  constructor() {
    this.facts = new Map(); // predicate -> Set of tuples (as JSON strings)
    this.rules = []; // [{head: {predicate, args}, body: [{predicate, args, negated?}]}]
  }

  addFact(pred, ...args) {
    // Support addFact('pred', [a, b]) and addFact('pred', a, b)
    if (args.length === 1 && Array.isArray(args[0])) args = args[0];
    if (!this.facts.has(pred)) this.facts.set(pred, new Set());
    this.facts.get(pred).add(JSON.stringify(args));
    return this;
  }

  addRule(headOrPred, headArgsOrBody1, ...bodyRest) {
    let head, body;
    
    if (typeof headOrPred === 'string') {
      // API 2: addRule('pred', ['X', 'Y'], [['parent', ['X', 'Y']], ...])
      const headArgs = headArgsOrBody1;
      const bodyDefs = bodyRest[0] || [];
      head = { predicate: headOrPred, args: headArgs.map(a => a.startsWith && !a.startsWith('?') ? '?' + a : a) };
      body = bodyDefs.map(b => {
        let pred = b[0], args = b[1];
        let negated = false;
        if (pred.startsWith('!')) { negated = true; pred = pred.slice(1); }
        return { predicate: pred, args: args.map(a => a.startsWith && !a.startsWith('?') ? '?' + a : a), negated };
      });
    } else {
      // API 1: addRule({pred/predicate, args}, atom(...), atom(...))
      head = headOrPred;
      if (head.pred && !head.predicate) head.predicate = head.pred;
      body = [headArgsOrBody1, ...bodyRest].filter(Boolean);
    }
    
    this.rules.push({ head, body });
    return this;
  }

  _isVar(s) { return typeof s === 'string' && s.startsWith('?'); }

  _resolve(arg, bindings) {
    if (this._isVar(arg) && arg in bindings) return bindings[arg];
    return arg;
  }

  _unifyArgs(pattern, fact) {
    if (pattern.length !== fact.length) return null;
    const bindings = {};
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i];
      const f = fact[i];
      if (this._isVar(p)) {
        if (p in bindings) {
          if (bindings[p] !== f) return null;
        } else {
          bindings[p] = f;
        }
      } else if (p !== f) {
        return null;
      }
    }
    return bindings;
  }

  _matchAtom(atom, bindings) {
    const pred = atom.predicate;
    const facts = this.facts.get(pred);
    if (!facts) return [];
    
    const results = [];
    const resolvedArgs = atom.args.map(a => this._resolve(a, bindings));
    
    for (const factStr of facts) {
      const fact = JSON.parse(factStr);
      const unified = this._unifyArgs(resolvedArgs, fact);
      if (unified !== null) {
        results.push({ ...bindings, ...unified });
      }
    }
    return results;
  }

  query(pred, ...args) {
    this._evaluate();
    const facts = this.facts.get(pred);
    if (!facts) return [];
    
    const results = [];
    for (const factStr of facts) {
      const fact = JSON.parse(factStr);
      const bindings = this._unifyArgs(args, fact);
      if (bindings !== null) results.push(bindings);
    }
    return results;
  }

  evaluate() {
    this._evaluate();
    return this;
  }

  _evaluate() {
    let changed = true;
    let iterations = 0;
    while (changed && iterations++ < 100) {
      changed = false;
      for (const rule of this.rules) {
        const newFacts = this._evaluateRule(rule);
        for (const fact of newFacts) {
          const key = rule.head.predicate;
          if (!this.facts.has(key)) this.facts.set(key, new Set());
          const str = JSON.stringify(fact);
          if (!this.facts.get(key).has(str)) {
            this.facts.get(key).add(str);
            changed = true;
          }
        }
      }
    }
  }

  _evaluateRule(rule) {
    const results = [];
    const solutions = this._solveBody(rule.body, [{}]);
    for (const bindings of solutions) {
      const args = rule.head.args.map(a => this._resolve(a, bindings));
      if (args.every(a => a !== undefined)) results.push(args);
    }
    return results;
  }

  _solveBody(body, bindingsList) {
    if (body.length === 0) return bindingsList;
    const [first, ...rest] = body;
    const newBindings = [];
    
    for (const bindings of bindingsList) {
      if (first.negated) {
        const matches = this._matchAtom(first, bindings);
        if (matches.length === 0) newBindings.push(bindings);
      } else {
        const matches = this._matchAtom(first, bindings);
        newBindings.push(...matches);
      }
    }
    return this._solveBody(rest, newBindings);
  }

  aggregate(predicate, index, fn) {
    this._evaluate();
    const facts = this.facts.get(predicate);
    if (!facts) return fn === 'count' ? 0 : [];
    const values = [...facts].map(s => JSON.parse(s)[index]).filter(v => typeof v === 'number');
    switch (fn) {
      case 'count': return values.length;
      case 'sum': return values.reduce((a, b) => a + b, 0);
      case 'avg': return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      case 'min': return Math.min(...values);
      case 'max': return Math.max(...values);
      default: return values;
    }
  }

  queryAll(predicate) {
    this._evaluate();
    const facts = this.facts.get(predicate);
    if (!facts) return [];
    return [...facts].map(s => JSON.parse(s));
  }

  queryWhere(predicate, conditions) {
    this._evaluate();
    const facts = this.facts.get(predicate);
    if (!facts) return [];
    return [...facts].map(s => JSON.parse(s)).filter(fact => {
      for (const [idx, value] of Object.entries(conditions)) {
        if (fact[parseInt(idx)] !== value) return false;
      }
      return true;
    });
  }
}

function atom(predicate, ...args) {
  return { predicate, args, negated: false };
}

function not(predicate, ...args) {
  return { predicate, args, negated: true };
}

module.exports = { Datalog, atom, not };
