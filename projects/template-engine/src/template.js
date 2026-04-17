// template.js — Template engine with Handlebars-like syntax
// Supports: {{var}}, {{{raw}}}, {{#if}}, {{#each}}, {{#unless}}, {{> partial}}, {{! comment}}

export function compile(source, options = {}) {
  const ast = parse(tokenize(source));
  return (data, partials = {}) => render(ast, data, partials, options.helpers || {});
}

// ===== Tokenizer =====
function tokenize(source) {
  const tokens = [];
  let i = 0;

  while (i < source.length) {
    // Check for expression start
    if (source[i] === '{' && source[i + 1] === '{') {
      const raw = source[i + 2] === '{';
      const start = raw ? i + 3 : i + 2;
      const end = raw
        ? source.indexOf('}}}', start)
        : source.indexOf('}}', start);

      if (end === -1) throw new Error('Unterminated expression');

      const content = source.slice(start, end).trim();
      tokens.push({ type: 'expression', content, raw });
      i = end + (raw ? 3 : 2);
      continue;
    }

    // Plain text
    let text = '';
    while (i < source.length && !(source[i] === '{' && source[i + 1] === '{')) {
      text += source[i++];
    }
    if (text) tokens.push({ type: 'text', value: text });
  }

  return tokens;
}

// ===== Parser =====
function parse(tokens) {
  const ast = [];
  let i = 0;

  function parseBlock(endTag, stopAtElse = false) {
    const body = [];
    while (i < tokens.length) {
      const tok = tokens[i];

      // Stop at {{else}} without consuming it
      if (stopAtElse && tok.type === 'expression' && tok.content === 'else') {
        return body;
      }

      if (tok.type === 'text') {
        body.push({ type: 'text', value: tok.value });
        i++;
        continue;
      }

      if (tok.type === 'expression') {
        const c = tok.content;

        // Comment
        if (c.startsWith('!')) { i++; continue; }

        // End block
        if (c.startsWith('/')) {
          const tag = c.slice(1).trim();
          if (tag === endTag) { i++; return body; }
          throw new Error(`Unexpected {{/${tag}}}, expected {{/${endTag}}}`);
        }

        // Block helpers
        if (c.startsWith('#if ')) {
          i++;
          const expr = c.slice(4).trim();
          const consequent = parseBlock('if', true); // may stop at else
          let alternate = [];
          // Check for {{else}} — already consumed by parseBlock returning early
          if (i < tokens.length && tokens[i]?.type === 'expression' && tokens[i].content === 'else') {
            i++;
            alternate = parseBlock('if');
          }
          body.push({ type: 'if', expr, consequent, alternate });
          continue;
        }

        if (c.startsWith('#unless ')) {
          i++;
          const expr = c.slice(8).trim();
          const block = parseBlock('unless');
          body.push({ type: 'unless', expr, body: block });
          continue;
        }

        if (c.startsWith('#each ')) {
          i++;
          const expr = c.slice(6).trim();
          const block = parseBlock('each');
          body.push({ type: 'each', expr, body: block });
          continue;
        }

        if (c.startsWith('#with ')) {
          i++;
          const expr = c.slice(6).trim();
          const block = parseBlock('with');
          body.push({ type: 'with', expr, body: block });
          continue;
        }

        // Partial
        if (c.startsWith('> ')) {
          body.push({ type: 'partial', name: c.slice(2).trim() });
          i++;
          continue;
        }

        // else (standalone)
        if (c === 'else') { i++; return body; }

        // Variable
        body.push({ type: 'variable', expr: c, raw: tok.raw });
        i++;
        continue;
      }

      i++;
    }

    if (endTag) throw new Error(`Missing {{/${endTag}}}`);
    return body;
  }

  return parseBlock(null);
}

// ===== Renderer =====
function render(nodes, data, partials, helpers) {
  let output = '';

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        output += node.value;
        break;

      case 'variable': {
        let value;
        if (helpers[node.expr]) {
          value = helpers[node.expr](data);
        } else {
          value = resolve(data, node.expr);
        }
        if (value === undefined || value === null) value = '';
        output += node.raw ? String(value) : escapeHtml(String(value));
        break;
      }

      case 'if': {
        const val = resolve(data, node.expr);
        if (isTruthy(val)) {
          output += render(node.consequent, data, partials, helpers);
        } else {
          output += render(node.alternate, data, partials, helpers);
        }
        break;
      }

      case 'unless': {
        const val = resolve(data, node.expr);
        if (!isTruthy(val)) {
          output += render(node.body, data, partials, helpers);
        }
        break;
      }

      case 'each': {
        const val = resolve(data, node.expr);
        if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            const item = val[i];
            const meta = { '@index': i, '@first': i === 0, '@last': i === val.length - 1, '.': item };
            const ctx = (item && typeof item === 'object') ? { ...item, ...meta } : meta;
            output += render(node.body, ctx, partials, helpers);
          }
        } else if (val && typeof val === 'object') {
          const keys = Object.keys(val);
          for (let i = 0; i < keys.length; i++) {
            const ctx = { '@key': keys[i], '@value': val[keys[i]], '.': val[keys[i]], ...val[keys[i]] };
            output += render(node.body, ctx, partials, helpers);
          }
        }
        break;
      }

      case 'with': {
        const val = resolve(data, node.expr);
        if (val) output += render(node.body, val, partials, helpers);
        break;
      }

      case 'partial': {
        const partial = partials[node.name];
        if (typeof partial === 'function') {
          output += partial(data);
        } else if (typeof partial === 'string') {
          output += compile(partial)(data, partials);
        }
        break;
      }
    }
  }

  return output;
}

// ===== Utilities =====
function resolve(data, path) {
  if (path === '.' || path === 'this') return data['.'] !== undefined ? data['.'] : data;
  const parts = path.split('.');
  let current = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function isTruthy(val) {
  if (val === false || val === null || val === undefined || val === '' || val === 0) return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { tokenize, parse, render, resolve, escapeHtml };
