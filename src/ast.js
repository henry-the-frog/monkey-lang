// Monkey Language AST Nodes

// --- Helpers ---

// Escape a JavaScript string for safe inclusion inside a Monkey "..."
// string literal. Mirrors the lexer's readString() escape table:
// backslash, double-quote, newline, tab, carriage return, NUL.
function escapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') out += '\\\\';
    else if (c === '"') out += '\\"';
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else if (c === '\0') out += '\\0';
    else out += c;
  }
  return out;
}

// Escape a string for the literal-text portion of a backtick template.
// Mirrors readTemplateString(): backslash, backtick, dollar (only when
// followed by `{`), and the standard whitespace escapes.
function escapeTemplateText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') out += '\\\\';
    else if (c === '`') out += '\\`';
    else if (c === '$' && s[i + 1] === '{') out += '\\$';
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else out += c;
  }
  return out;
}

// Render a list of statements as the inside of a block, joining with a
// single space. Every statement type self-terminates with ';' or '}', so
// no extra separator is needed. The space exists only for readability.
function joinStatements(statements) {
  return statements.map(s => s.toString()).filter(s => s.length > 0).join(' ');
}

// --- Statements ---

export class Program {
  constructor() {
    this.statements = [];
  }
  tokenLiteral() {
    return this.statements.length > 0 ? this.statements[0].tokenLiteral() : '';
  }
  toString() {
    // Top-level: one statement per line. Every statement self-terminates.
    return this.statements.map(s => s.toString()).filter(s => s.length > 0).join('\n');
  }
}

export class LetStatement {
  constructor(token, name, value) {
    this.token = token; // LET or CONST token
    this.name = name;   // Identifier
    this.value = value;  // Expression
    this.isConst = token.type === 'CONST';
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `${this.isConst ? 'const' : 'let'} ${this.name} = ${this.value};`; }
}

export class ReturnStatement {
  constructor(token, returnValue) {
    this.token = token;
    this.returnValue = returnValue;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `return ${this.returnValue};`; }
}

export class ImportStatement {
  constructor(token, moduleName, bindings = null, alias = null) {
    this.token = token;
    this.moduleName = moduleName;
    this.bindings = bindings; // null = import whole module, array of strings = selective
    this.alias = alias; // null = use module name, string = use alias
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    if (this.bindings) {
      return `import "${this.moduleName}" { ${this.bindings.join(', ')} };`;
    }
    if (this.alias) {
      return `import "${this.moduleName}" as ${this.alias};`;
    }
    return `import "${this.moduleName}";`;
  }
}

export class ExpressionStatement {
  constructor(token, expression) {
    this.token = token;
    this.expression = expression;
  }
  tokenLiteral() { return this.token.literal; }
  // Always append ';' so adjacent expression statements can't fuse — e.g.
  // `if (c) { ... }` followed by `(call())` would otherwise re-parse as
  // an indexed call on the if-expression's result. The trailing ';' is
  // optional in the surface grammar but unambiguously terminates the
  // previous expression for the Pratt parser.
  toString() {
    if (!this.expression) return '';
    return this.expression.toString() + ';';
  }
}

export class BlockStatement {
  constructor(token, statements) {
    this.token = token; // LBRACE
    this.statements = statements;
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    if (this.statements.length === 0) return '{ }';
    return `{ ${joinStatements(this.statements)} }`;
  }
}

// --- Expressions ---

export class Identifier {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return this.value; }
}

export class IntegerLiteral {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  // Use the semantic value, not token.literal, because some parser paths
  // (notably postfix `i++` desugaring) construct a synthetic IntegerLiteral
  // whose token still points at the '++' operator.
  toString() { return String(this.value); }
}

export class FloatLiteral {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return String(this.value); }
}

export class StringLiteral {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `"${escapeString(this.value)}"`; }
}

export class BooleanLiteral {
  constructor(token, value) {
    this.token = token;
    this.value = value; // boolean
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return this.token.literal; }
}

export class PrefixExpression {
  constructor(token, operator, right) {
    this.token = token;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `(${this.operator}${this.right})`; }
}

export class InfixExpression {
  constructor(token, left, operator, right) {
    this.token = token;
    this.left = left;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `(${this.left} ${this.operator} ${this.right})`; }
}

export class IfExpression {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;   // BlockStatement
    this.alternative = alternative;   // BlockStatement | null
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    let s = `if (${this.condition}) ${this.consequence}`;
    if (this.alternative) s += ` else ${this.alternative}`;
    return s;
  }
}

export class FunctionLiteral {
  constructor(token, parameters, body) {
    this.token = token;
    this.parameters = parameters; // Identifier[]
    this.body = body;             // BlockStatement
    this.restParam = null;        // Identifier (for ...rest)
    this.paramTypes = null;       // string[] | null (type annotations: 'int', 'bool', 'string', etc.)
    this.returnType = null;       // string | null (return type annotation)
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const params = this.parameters.map((p, i) => {
      const type = this.paramTypes && this.paramTypes[i] ? `: ${this.paramTypes[i]}` : '';
      return `${p}${type}`;
    });
    const ret = this.returnType ? ` -> ${this.returnType}` : '';
    return `fn(${params.join(', ')})${ret} ${this.body}`;
  }
}

export class CallExpression {
  constructor(token, fn, args) {
    this.token = token; // LPAREN
    this.function = fn;  // Identifier or FunctionLiteral
    this.arguments = args;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `${this.function}(${this.arguments.join(', ')})`; }
}

export class ArrayLiteral {
  constructor(token, elements) {
    this.token = token;
    this.elements = elements;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `[${this.elements.join(', ')}]`; }
}

export class ArrayComprehension {
  constructor(token, body, variable, iterable, condition) {
    this.token = token;
    this.body = body;         // expression to evaluate per element
    this.variable = variable; // identifier string
    this.iterable = iterable; // expression producing array
    this.condition = condition; // optional filter expression (or null)
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const cond = this.condition ? ` if ${this.condition}` : '';
    return `[${this.body} for ${this.variable} in ${this.iterable}${cond}]`;
  }
}

export class IndexExpression {
  constructor(token, left, index) {
    this.token = token; // LBRACKET
    this.left = left;
    this.index = index;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `(${this.left}[${this.index}])`; }
}

export class OptionalChainExpression {
  constructor(token, left, index) {
    this.token = token; // ?.
    this.left = left;   // the object
    this.index = index;  // the key expression
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `(${this.left}?.[${this.index}])`; }
}

export class SpreadElement {
  constructor(token, expression) {
    this.token = token;       // ...
    this.expression = expression;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `...${this.expression}`; }
}

export class HashLiteral {
  constructor(token, pairs) {
    this.token = token;
    this.pairs = pairs; // Map<Expression, Expression>
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const entries = [];
    for (const [k, v] of this.pairs) entries.push(`${k}:${v}`);
    return `{${entries.join(', ')}}`;
  }
}

export class WhileExpression {
  constructor(token, condition, body) {
    this.token = token;
    this.condition = condition;   // Expression
    this.body = body;             // BlockStatement
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `while (${this.condition}) ${this.body}`; }
}

export class AssignExpression {
  constructor(token, name, value) {
    this.token = token;
    this.name = name;     // Identifier
    this.value = value;   // Expression
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `${this.name} = ${this.value}`; }
}

export class ForExpression {
  constructor(token, init, condition, update, body) {
    this.token = token;
    this.init = init;           // LetStatement or ExpressionStatement
    this.condition = condition; // Expression
    this.update = update;       // Expression (e.g., i += 1)
    this.body = body;           // BlockStatement
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    // init is a LetStatement (already ends in ';') or an ExpressionStatement
    // (no trailing ';'). Strip the trailing ';' from let so we can re-emit
    // a single one in the canonical `for (init; cond; update)` form.
    let initStr = this.init.toString();
    if (initStr.endsWith(';')) initStr = initStr.slice(0, -1);
    return `for (${initStr}; ${this.condition}; ${this.update}) ${this.body}`;
  }
}

export class ForInExpression {
  constructor(token, variable, iterable, body) {
    this.token = token;
    this.variable = variable;   // string (identifier name)
    this.iterable = iterable;   // Expression
    this.body = body;            // BlockStatement
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `for (${this.variable} in ${this.iterable}) ${this.body}`; }
}

export class BreakStatement {
  constructor(token) { this.token = token; }
  tokenLiteral() { return this.token.literal; }
  // No trailing ';' — the surrounding ExpressionStatement adds one. Despite
  // the class name, break/continue are parsed as prefix expressions by the
  // Pratt parser, so they always live inside an ExpressionStatement.
  toString() { return 'break'; }
}

export class ContinueStatement {
  constructor(token) { this.token = token; }
  tokenLiteral() { return this.token.literal; }
  toString() { return 'continue'; }
}

export class EnumStatement {
  constructor(token, name, variants) {
    this.token = token;
    this.name = name;       // string
    this.variants = variants; // array of strings
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `enum ${this.name} { ${this.variants.join(', ')} }`; }
}

export class TemplateLiteral {
  constructor(token, parts) {
    this.token = token;
    this.parts = parts; // Array of StringLiteral or Expression nodes
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    let s = '`';
    for (const part of this.parts) {
      if (part instanceof StringLiteral) {
        s += escapeTemplateText(part.value);
      } else {
        s += `\${${part}}`;
      }
    }
    s += '`';
    return s;
  }
}

export class IndexAssignExpression {
  constructor(token, left, index, value) {
    this.token = token;
    this.left = left;     // Expression (the array/hash)
    this.index = index;   // Expression (the index/key)
    this.value = value;   // Expression (the value to assign)
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `${this.left}[${this.index}] = ${this.value}`; }
}

export class NullLiteral {
  constructor(token) { this.token = token; }
  tokenLiteral() { return this.token.literal; }
  toString() { return 'null'; }
}

export class SliceExpression {
  constructor(token, left, start, end) {
    this.token = token;
    this.left = left;    // the array/string
    this.start = start;  // Expression or null (start of slice)
    this.end = end;      // Expression or null (end of slice)
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const startStr = this.start !== null ? this.start.toString() : '';
    const endStr = this.end !== null ? this.end.toString() : '';
    return `${this.left}[${startStr}:${endStr}]`;
  }
}

export class TernaryExpression {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;
    this.alternative = alternative;
  }
  tokenLiteral() { return this.token.literal; }
  // Wrap in parens because ternary has lower precedence than most operators;
  // serializing `a + (b ? c : d)` as `a + b ? c : d` would re-parse with the
  // wrong grouping.
  toString() { return `(${this.condition} ? ${this.consequence} : ${this.alternative})`; }
}

export class MatchExpression {
  constructor(token, subject, arms) {
    this.token = token;
    this.subject = subject;   // Expression to match against
    this.arms = arms;         // Array of { pattern, value, guard? } where pattern is Expression, TypePattern, OrPattern, or null (wildcard)
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const armParts = this.arms.map(arm => {
      const pat = arm.pattern === null ? '_' : arm.pattern.toString();
      const guard = arm.guard ? ` when ${arm.guard}` : '';
      return `${pat}${guard} => ${arm.value}`;
    });
    return `match (${this.subject}) { ${armParts.join(', ')} }`;
  }
}

export class TypePattern {
  constructor(typeName, binding) {
    this.typeName = typeName;
    this.binding = binding;
  }
  toString() { return `${this.typeName}(${this.binding.value})`; }
}

export class OrPattern {
  constructor(patterns) {
    this.patterns = patterns; // array of pattern expressions
  }
  toString() { return this.patterns.map(p => p.toString()).join(' | '); }
}

export class DestructuringLet {
  constructor(token, names, value) {
    this.token = token;
    this.names = names;   // Array of Identifier or null (for _)
    this.value = value;   // Expression
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const nameStrs = this.names.map(n => n ? n.value : '_').join(', ');
    return `let [${nameStrs}] = ${this.value};`;
  }
}

export class HashDestructuringLet {
  constructor(token, names, value) {
    this.token = token;
    this.names = names;   // Array of Identifier (keys to extract from hash)
    this.value = value;   // Expression
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const nameStrs = this.names.map(n => n.value).join(', ');
    return `let {${nameStrs}} = ${this.value};`;
  }
}

export class DoWhileExpression {
  constructor(token, body, condition) {
    this.token = token;
    this.body = body;
    this.condition = condition;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `do ${this.body} while (${this.condition})`; }
}

export class RangeExpression {
  constructor(token, start, end) {
    this.token = token;
    this.start = start;  // Expression
    this.end = end;      // Expression
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `${this.start}..${this.end}`; }
}

// --- Classes from our main branch not in the PR ---

export class SetStatement {
  constructor(token, name, value) {
    this.token = token;
    this.name = name; // Identifier
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `set ${this.name} = ${this.value};`; }
}

export class FStringExpression {
  constructor(token, segments) {
    this.token = token;
    this.segments = segments; // [{type: 'text', value: '...'}, {type: 'expr', expr: AST}]
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    let s = 'f"';
    for (const seg of this.segments) {
      if (seg.type === 'text') s += escapeString(seg.value);
      else s += '${' + seg.expr.toString() + '}';
    }
    return s + '"';
  }
}

export class SwitchExpression {
  constructor(token, value, cases, defaultCase) {
    this.token = token;
    this.value = value;
    this.cases = cases;
    this.defaultCase = defaultCase;
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const cs = this.cases.map(c => `${c.value} => ${c.body}`).join(', ');
    const def = this.defaultCase ? `, default => ${this.defaultCase}` : '';
    return `switch (${this.value}) { ${cs}${def} }`;
  }
}

export class TryCatchExpression {
  constructor(token, tryBody, errorIdent, catchBody) {
    this.token = token;
    this.tryBody = tryBody;
    this.errorIdent = errorIdent;
    this.catchBody = catchBody;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `try ${this.tryBody} catch (${this.errorIdent}) ${this.catchBody}`; }
}

export class ThrowExpression {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return this.token.literal; }
  toString() { return `throw ${this.value}`; }
}

export class DestructureLetStatement {
  constructor(token, names, value, isConst = false) {
    this.token = token;
    this.names = names; // Array of Identifiers
    this.value = value;
    this.isConst = isConst;
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const kw = this.isConst ? 'const' : 'let';
    return `${kw} [${this.names.map(n => n.toString()).join(', ')}] = ${this.value.toString()};`;
  }
}

export class DestructureHashLetStatement {
  constructor(token, names, value, isConst = false) {
    this.token = token;
    this.names = names; // Array of Identifiers
    this.value = value;
    this.isConst = isConst;
  }
  tokenLiteral() { return this.token.literal; }
  toString() {
    const kw = this.isConst ? 'const' : 'let';
    return `${kw} {${this.names.map(n => n.toString()).join(', ')}} = ${this.value.toString()};`;
  }
}

export class SpreadExpression {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() { return '...'; }
  toString() { return `...${this.value.toString()}`; }
}
