// src/lexer.js
var TokenType = {
  // Literals
  INT: "INT",
  FLOAT: "FLOAT",
  STRING: "STRING",
  FSTRING: "FSTRING",
  IDENT: "IDENT",
  NULL: "NULL",
  // Multi-char operators
  PIPE: "|>",
  ARROW: "=>",
  THIN_ARROW: "->",
  SPREAD: "...",
  DOT: ".",
  DOTDOT: "..",
  // Operators
  ASSIGN: "=",
  PLUS_ASSIGN: "+=",
  MINUS_ASSIGN: "-=",
  ASTERISK_ASSIGN: "*=",
  POWER: "**",
  SLASH_ASSIGN: "/=",
  PLUS: "+",
  MINUS: "-",
  BANG: "!",
  ASTERISK: "*",
  SLASH: "/",
  PERCENT: "%",
  LT: "<",
  GT: ">",
  LTE: "<=",
  GTE: ">=",
  AND: "&&",
  OR: "||",
  EQ: "==",
  NOT_EQ: "!=",
  // Delimiters
  COMMA: ",",
  SEMICOLON: ";",
  COLON: ":",
  QUESTION: "?",
  NULLISH: "??",
  LPAREN: "(",
  RPAREN: ")",
  LBRACE: "{",
  RBRACE: "}",
  LBRACKET: "[",
  RBRACKET: "]",
  // Keywords
  FUNCTION: "FUNCTION",
  LET: "LET",
  CONST: "CONST",
  SET: "SET",
  FOR: "FOR",
  TRUE: "TRUE",
  FALSE: "FALSE",
  IF: "IF",
  ELSE: "ELSE",
  RETURN: "RETURN",
  WHILE: "WHILE",
  DO: "DO",
  BREAK: "BREAK",
  CONTINUE: "CONTINUE",
  SWITCH: "SWITCH",
  CASE: "CASE",
  DEFAULT: "DEFAULT",
  TRY: "TRY",
  CATCH: "CATCH",
  THROW: "THROW",
  IN: "IN",
  IMPORT: "IMPORT",
  EXPORT: "EXPORT",
  AS: "AS",
  CLASS: "CLASS",
  EXTENDS: "EXTENDS",
  SUPER: "SUPER",
  // Special
  EOF: "EOF",
  ILLEGAL: "ILLEGAL"
};
var KEYWORDS = /* @__PURE__ */ Object.create(null);
Object.assign(KEYWORDS, {
  fn: TokenType.FUNCTION,
  let: TokenType.LET,
  const: TokenType.CONST,
  set: TokenType.SET,
  for: TokenType.FOR,
  true: TokenType.TRUE,
  false: TokenType.FALSE,
  if: TokenType.IF,
  else: TokenType.ELSE,
  return: TokenType.RETURN,
  while: TokenType.WHILE,
  do: TokenType.DO,
  break: TokenType.BREAK,
  continue: TokenType.CONTINUE,
  switch: TokenType.SWITCH,
  case: TokenType.CASE,
  default: TokenType.DEFAULT,
  try: TokenType.TRY,
  catch: TokenType.CATCH,
  throw: TokenType.THROW,
  import: TokenType.IMPORT,
  export: TokenType.EXPORT,
  as: TokenType.AS,
  null: TokenType.NULL,
  enum: "ENUM",
  match: "MATCH",
  in: TokenType.IN,
  class: TokenType.CLASS,
  extends: TokenType.EXTENDS,
  super: TokenType.SUPER
});
var Token = class {
  constructor(type, literal) {
    this.type = type;
    this.literal = literal;
  }
};
var Lexer = class {
  constructor(input) {
    this.input = input;
    this.position = 0;
    this.readPosition = 0;
    this.ch = null;
    this.readChar();
  }
  readChar() {
    this.ch = this.readPosition >= this.input.length ? null : this.input[this.readPosition];
    this.position = this.readPosition;
    this.readPosition++;
  }
  peekChar() {
    return this.readPosition >= this.input.length ? null : this.input[this.readPosition];
  }
  skipWhitespace() {
    while (true) {
      while (this.ch === " " || this.ch === "	" || this.ch === "\n" || this.ch === "\r") {
        this.readChar();
      }
      if (this.ch === "/" && this.peekChar() === "/") {
        this.readChar();
        this.readChar();
        while (this.ch && this.ch !== "\n") {
          this.readChar();
        }
        continue;
      }
      if (this.ch === "/" && this.peekChar() === "*") {
        this.readChar();
        this.readChar();
        while (this.ch) {
          if (this.ch === "*" && this.peekChar() === "/") {
            this.readChar();
            this.readChar();
            break;
          }
          this.readChar();
        }
        continue;
      }
      break;
    }
  }
  readIdentifier() {
    const start = this.position;
    while (this.ch && (isLetter(this.ch) || this.ch === "_" || this.position > start && isDigit(this.ch))) {
      this.readChar();
    }
    return this.input.slice(start, this.position);
  }
  readNumber() {
    const start = this.position;
    let isFloat = false;
    while (this.ch && isDigit(this.ch)) {
      this.readChar();
    }
    if (this.ch === "." && isDigit(this.peekChar())) {
      isFloat = true;
      this.readChar();
      while (this.ch && isDigit(this.ch)) {
        this.readChar();
      }
    }
    if (this.ch === "e" || this.ch === "E") {
      isFloat = true;
      this.readChar();
      if (this.ch === "+" || this.ch === "-") {
        this.readChar();
      }
      while (this.ch && isDigit(this.ch)) {
        this.readChar();
      }
    }
    return { value: this.input.slice(start, this.position), isFloat };
  }
  readTripleQuoteString() {
    this.readChar();
    this.readChar();
    this.readChar();
    let result = "";
    while (this.ch !== null) {
      if (this.ch === '"' && this.peekChar() === '"' && this.input[this.position + 2] === '"') {
        this.readChar();
        this.readChar();
        this.readChar();
        return result;
      }
      result += this.ch;
      this.readChar();
    }
    return result;
  }
  readString() {
    this.readChar();
    let result = "";
    while (this.ch !== null && this.ch !== '"') {
      if (this.ch === "\\") {
        this.readChar();
        switch (this.ch) {
          case "n":
            result += "\n";
            break;
          case "t":
            result += "	";
            break;
          case "r":
            result += "\r";
            break;
          case "\\":
            result += "\\";
            break;
          case '"':
            result += '"';
            break;
          default:
            result += "\\" + this.ch;
            break;
        }
      } else {
        result += this.ch;
      }
      this.readChar();
    }
    this.readChar();
    return result;
  }
  nextToken() {
    this.skipWhitespace();
    let tok;
    switch (this.ch) {
      case "=":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.EQ, "==");
        } else if (this.peekChar() === ">") {
          this.readChar();
          tok = new Token(TokenType.ARROW, "=>");
        } else {
          tok = new Token(TokenType.ASSIGN, "=");
        }
        break;
      case "+":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.PLUS_ASSIGN, "+=");
        } else if (this.peekChar() === "+") {
          this.readChar();
          tok = new Token("++", "++");
        } else {
          tok = new Token(TokenType.PLUS, "+");
        }
        break;
      case "-":
        if (this.peekChar() === ">") {
          this.readChar();
          tok = new Token(TokenType.THIN_ARROW, "->");
        } else if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.MINUS_ASSIGN, "-=");
        } else if (this.peekChar() === "-") {
          this.readChar();
          tok = new Token("--", "--");
        } else {
          tok = new Token(TokenType.MINUS, "-");
        }
        break;
      case "!":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.NOT_EQ, "!=");
        } else {
          tok = new Token(TokenType.BANG, "!");
        }
        break;
      case "*":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.ASTERISK_ASSIGN, "*=");
        } else if (this.peekChar() === "*") {
          this.readChar();
          tok = new Token(TokenType.POWER, "**");
        } else {
          tok = new Token(TokenType.ASTERISK, "*");
        }
        break;
      case "/":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.SLASH_ASSIGN, "/=");
        } else {
          tok = new Token(TokenType.SLASH, "/");
        }
        break;
      case "%":
        tok = new Token(TokenType.PERCENT, "%");
        break;
      case "&":
        if (this.peekChar() === "&") {
          this.readChar();
          tok = new Token(TokenType.AND, "&&");
        } else {
          tok = new Token(TokenType.ILLEGAL, ch);
        }
        break;
      case "|":
        if (this.peekChar() === "|") {
          this.readChar();
          tok = new Token(TokenType.OR, "||");
        } else if (this.peekChar() === ">") {
          this.readChar();
          tok = new Token(TokenType.PIPE, "|>");
        } else {
          tok = new Token(TokenType.ILLEGAL, ch);
        }
        break;
      case "<":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.LTE, "<=");
        } else {
          tok = new Token(TokenType.LT, "<");
        }
        break;
      case ">":
        if (this.peekChar() === "=") {
          this.readChar();
          tok = new Token(TokenType.GTE, ">=");
        } else {
          tok = new Token(TokenType.GT, ">");
        }
        break;
      case ",":
        tok = new Token(TokenType.COMMA, ",");
        break;
      case ";":
        tok = new Token(TokenType.SEMICOLON, ";");
        break;
      case ":":
        tok = new Token(TokenType.COLON, ":");
        break;
      case "?":
        if (this.peekChar() === "?") {
          this.readChar();
          tok = new Token(TokenType.NULLISH, "??");
        } else if (this.peekChar() === ".") {
          this.readChar();
          tok = new Token("?.", "?.");
        } else {
          tok = new Token(TokenType.QUESTION, "?");
        }
        break;
      case "(":
        tok = new Token(TokenType.LPAREN, "(");
        break;
      case ")":
        tok = new Token(TokenType.RPAREN, ")");
        break;
      case "{":
        tok = new Token(TokenType.LBRACE, "{");
        break;
      case "}":
        tok = new Token(TokenType.RBRACE, "}");
        break;
      case "[":
        tok = new Token(TokenType.LBRACKET, "[");
        break;
      case "]":
        tok = new Token(TokenType.RBRACKET, "]");
        break;
      case '"':
        if (this.peekChar() === '"' && this.input[this.position + 2] === '"') {
          return new Token(TokenType.STRING, this.readTripleQuoteString());
        }
        return new Token(TokenType.STRING, this.readString());
      case "`": {
        this.readChar();
        const start = this.position;
        while (this.ch && this.ch !== "`") {
          if (this.ch === "\\") this.readChar();
          this.readChar();
        }
        let str = this.input.slice(start, this.position);
        this.readChar();
        str = str.replace(/\$\{/g, "{");
        return new Token(TokenType.FSTRING, str);
      }
      case null:
        return new Token(TokenType.EOF, "");
      case ".":
        if (this.peekChar() === "." && this.input[this.readPosition + 1] === ".") {
          this.readChar();
          this.readChar();
          tok = new Token(TokenType.SPREAD, "...");
        } else if (this.peekChar() === ".") {
          this.readChar();
          tok = new Token(TokenType.DOTDOT, "..");
        } else {
          tok = new Token(TokenType.DOT, ".");
        }
        break;
      default:
        if (isLetter(this.ch)) {
          if (this.ch === "f" && this.peekChar() === '"') {
            this.readChar();
            this.readChar();
            const start = this.position;
            while (this.ch && this.ch !== '"') {
              if (this.ch === "\\") this.readChar();
              this.readChar();
            }
            const str = this.input.slice(start, this.position);
            this.readChar();
            return new Token(TokenType.FSTRING, str);
          }
          const ident = this.readIdentifier();
          const type = KEYWORDS[ident] || TokenType.IDENT;
          return new Token(type, ident);
        } else if (isDigit(this.ch)) {
          const num = this.readNumber();
          return new Token(num.isFloat ? TokenType.FLOAT : TokenType.INT, num.value);
        } else {
          tok = new Token(TokenType.ILLEGAL, this.ch);
        }
    }
    this.readChar();
    return tok;
  }
  /** Tokenize all remaining input */
  tokenize() {
    const tokens = [];
    let tok;
    do {
      tok = this.nextToken();
      tokens.push(tok);
    } while (tok.type !== TokenType.EOF);
    return tokens;
  }
};
function isLetter(ch2) {
  return ch2 >= "a" && ch2 <= "z" || ch2 >= "A" && ch2 <= "Z" || ch2 === "_";
}
function isDigit(ch2) {
  return ch2 >= "0" && ch2 <= "9";
}

// src/ast.js
function escapeString(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\n") out += "\\n";
    else if (c === "	") out += "\\t";
    else if (c === "\r") out += "\\r";
    else if (c === "\0") out += "\\0";
    else out += c;
  }
  return out;
}
function joinStatements(statements) {
  return statements.map((s) => s.toString()).filter((s) => s.length > 0).join(" ");
}
var Program = class {
  constructor() {
    this.statements = [];
  }
  tokenLiteral() {
    return this.statements.length > 0 ? this.statements[0].tokenLiteral() : "";
  }
  toString() {
    return this.statements.map((s) => s.toString()).filter((s) => s.length > 0).join("\n");
  }
};
var LetStatement = class {
  constructor(token, name, value) {
    this.token = token;
    this.name = name;
    this.value = value;
    this.isConst = token.type === "CONST";
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.isConst ? "const" : "let"} ${this.name} = ${this.value};`;
  }
};
var ReturnStatement = class {
  constructor(token, returnValue) {
    this.token = token;
    this.returnValue = returnValue;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `return ${this.returnValue};`;
  }
};
var ImportStatement = class {
  constructor(token, moduleName, bindings = null, alias = null) {
    this.token = token;
    this.moduleName = moduleName;
    this.bindings = bindings;
    this.alias = alias;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    if (this.bindings) {
      return `import "${this.moduleName}" { ${this.bindings.join(", ")} };`;
    }
    if (this.alias) {
      return `import "${this.moduleName}" as ${this.alias};`;
    }
    return `import "${this.moduleName}";`;
  }
};
var ExpressionStatement = class {
  constructor(token, expression) {
    this.token = token;
    this.expression = expression;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  // Always append ';' so adjacent expression statements can't fuse — e.g.
  // `if (c) { ... }` followed by `(call())` would otherwise re-parse as
  // an indexed call on the if-expression's result. The trailing ';' is
  // optional in the surface grammar but unambiguously terminates the
  // previous expression for the Pratt parser.
  toString() {
    if (!this.expression) return "";
    return this.expression.toString() + ";";
  }
};
var BlockStatement = class {
  constructor(token, statements) {
    this.token = token;
    this.statements = statements;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    if (this.statements.length === 0) return "{ }";
    return `{ ${joinStatements(this.statements)} }`;
  }
};
var Identifier = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.value;
  }
};
var IntegerLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  // Use the semantic value, not token.literal, because some parser paths
  // (notably postfix `i++` desugaring) construct a synthetic IntegerLiteral
  // whose token still points at the '++' operator.
  toString() {
    return String(this.value);
  }
};
var FloatLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return String(this.value);
  }
};
var StringLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `"${escapeString(this.value)}"`;
  }
};
var BooleanLiteral = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return this.token.literal;
  }
};
var PrefixExpression = class {
  constructor(token, operator, right) {
    this.token = token;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.operator}${this.right})`;
  }
};
var InfixExpression = class {
  constructor(token, left, operator, right) {
    this.token = token;
    this.left = left;
    this.operator = operator;
    this.right = right;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left} ${this.operator} ${this.right})`;
  }
};
var IfExpression = class {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;
    this.alternative = alternative;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    let s = `if (${this.condition}) ${this.consequence}`;
    if (this.alternative) s += ` else ${this.alternative}`;
    return s;
  }
};
var FunctionLiteral = class {
  constructor(token, parameters, body) {
    this.token = token;
    this.parameters = parameters;
    this.body = body;
    this.restParam = null;
    this.paramTypes = null;
    this.returnType = null;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const params = this.parameters.map((p, i) => {
      const type = this.paramTypes && this.paramTypes[i] ? `: ${this.paramTypes[i]}` : "";
      return `${p}${type}`;
    });
    const ret = this.returnType ? ` -> ${this.returnType}` : "";
    return `fn(${params.join(", ")})${ret} ${this.body}`;
  }
};
var CallExpression = class {
  constructor(token, fn, args) {
    this.token = token;
    this.function = fn;
    this.arguments = args;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `${this.function}(${this.arguments.join(", ")})`;
  }
};
var ArrayLiteral = class {
  constructor(token, elements) {
    this.token = token;
    this.elements = elements;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `[${this.elements.join(", ")}]`;
  }
};
var ArrayComprehension = class {
  constructor(token, body, variable, iterable, condition) {
    this.token = token;
    this.body = body;
    this.variable = variable;
    this.iterable = iterable;
    this.condition = condition;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const cond = this.condition ? ` if ${this.condition}` : "";
    return `[${this.body} for ${this.variable} in ${this.iterable}${cond}]`;
  }
};
var IndexExpression = class {
  constructor(token, left, index) {
    this.token = token;
    this.left = left;
    this.index = index;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left}[${this.index}])`;
  }
};
var OptionalChainExpression = class {
  constructor(token, left, index) {
    this.token = token;
    this.left = left;
    this.index = index;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `(${this.left}?.[${this.index}])`;
  }
};
var HashLiteral = class {
  constructor(token, pairs) {
    this.token = token;
    this.pairs = pairs;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const entries = [];
    for (const [k, v] of this.pairs) entries.push(`${k}:${v}`);
    return `{${entries.join(", ")}}`;
  }
};
var WhileExpression = class {
  constructor(token, condition, body) {
    this.token = token;
    this.condition = condition;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `while (${this.condition}) ${this.body}`;
  }
};
var ForExpression = class {
  constructor(token, init, condition, update, body) {
    this.token = token;
    this.init = init;
    this.condition = condition;
    this.update = update;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    let initStr = this.init.toString();
    if (initStr.endsWith(";")) initStr = initStr.slice(0, -1);
    return `for (${initStr}; ${this.condition}; ${this.update}) ${this.body}`;
  }
};
var ForInExpression = class {
  constructor(token, variable, iterable, body) {
    this.token = token;
    this.variable = variable;
    this.iterable = iterable;
    this.body = body;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `for (${this.variable} in ${this.iterable}) ${this.body}`;
  }
};
var BreakStatement = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  // No trailing ';' — the surrounding ExpressionStatement adds one. Despite
  // the class name, break/continue are parsed as prefix expressions by the
  // Pratt parser, so they always live inside an ExpressionStatement.
  toString() {
    return "break";
  }
};
var ContinueStatement = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "continue";
  }
};
var EnumStatement = class {
  constructor(token, name, variants) {
    this.token = token;
    this.name = name;
    this.variants = variants;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `enum ${this.name} { ${this.variants.join(", ")} }`;
  }
};
var NullLiteral = class {
  constructor(token) {
    this.token = token;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return "null";
  }
};
var SliceExpression = class {
  constructor(token, left, start, end) {
    this.token = token;
    this.left = left;
    this.start = start;
    this.end = end;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const startStr = this.start !== null ? this.start.toString() : "";
    const endStr = this.end !== null ? this.end.toString() : "";
    return `${this.left}[${startStr}:${endStr}]`;
  }
};
var TernaryExpression = class {
  constructor(token, condition, consequence, alternative) {
    this.token = token;
    this.condition = condition;
    this.consequence = consequence;
    this.alternative = alternative;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  // Wrap in parens because ternary has lower precedence than most operators;
  // serializing `a + (b ? c : d)` as `a + b ? c : d` would re-parse with the
  // wrong grouping.
  toString() {
    return `(${this.condition} ? ${this.consequence} : ${this.alternative})`;
  }
};
var MatchExpression = class {
  constructor(token, subject, arms) {
    this.token = token;
    this.subject = subject;
    this.arms = arms;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const armParts = this.arms.map((arm) => {
      const pat = arm.pattern === null ? "_" : arm.pattern.toString();
      const guard = arm.guard ? ` when ${arm.guard}` : "";
      return `${pat}${guard} => ${arm.value}`;
    });
    return `match (${this.subject}) { ${armParts.join(", ")} }`;
  }
};
var DoWhileExpression = class {
  constructor(token, body, condition) {
    this.token = token;
    this.body = body;
    this.condition = condition;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `do ${this.body} while (${this.condition})`;
  }
};
var SetStatement = class {
  constructor(token, name, value) {
    this.token = token;
    this.name = name;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `set ${this.name} = ${this.value};`;
  }
};
var FStringExpression = class {
  constructor(token, segments) {
    this.token = token;
    this.segments = segments;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    let s = 'f"';
    for (const seg of this.segments) {
      if (seg.type === "text") s += escapeString(seg.value);
      else s += "${" + seg.expr.toString() + "}";
    }
    return s + '"';
  }
};
var SwitchExpression = class {
  constructor(token, value, cases, defaultCase) {
    this.token = token;
    this.value = value;
    this.cases = cases;
    this.defaultCase = defaultCase;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const cs = this.cases.map((c) => `${c.value} => ${c.body}`).join(", ");
    const def = this.defaultCase ? `, default => ${this.defaultCase}` : "";
    return `switch (${this.value}) { ${cs}${def} }`;
  }
};
var TryCatchExpression = class {
  constructor(token, tryBody, errorIdent, catchBody) {
    this.token = token;
    this.tryBody = tryBody;
    this.errorIdent = errorIdent;
    this.catchBody = catchBody;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `try ${this.tryBody} catch (${this.errorIdent}) ${this.catchBody}`;
  }
};
var ThrowExpression = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `throw ${this.value}`;
  }
};
var DestructureLetStatement = class {
  constructor(token, names, value, isConst = false) {
    this.token = token;
    this.names = names;
    this.value = value;
    this.isConst = isConst;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const kw = this.isConst ? "const" : "let";
    return `${kw} [${this.names.map((n) => n.toString()).join(", ")}] = ${this.value.toString()};`;
  }
};
var DestructureHashLetStatement = class {
  constructor(token, names, value, isConst = false) {
    this.token = token;
    this.names = names;
    this.value = value;
    this.isConst = isConst;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const kw = this.isConst ? "const" : "let";
    return `${kw} {${this.names.map((n) => n.toString()).join(", ")}} = ${this.value.toString()};`;
  }
};
var SpreadExpression = class {
  constructor(token, value) {
    this.token = token;
    this.value = value;
  }
  tokenLiteral() {
    return "...";
  }
  toString() {
    return `...${this.value.toString()}`;
  }
};
var ClassStatement = class {
  constructor(token, name, superClass, methods) {
    this.token = token;
    this.name = name;
    this.superClass = superClass;
    this.methods = methods;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    const ext = this.superClass ? ` extends ${this.superClass.value}` : "";
    const meths = this.methods.map(
      (m) => `  ${m.name.value}(${m.params.map((p) => p.value).join(", ")}) ${m.body.toString()}`
    ).join("\n");
    return `class ${this.name.value}${ext} {
${meths}
}`;
  }
};
var SuperExpression = class {
  constructor(token, method) {
    this.token = token;
    this.method = method;
  }
  tokenLiteral() {
    return this.token.literal;
  }
  toString() {
    return `super.${this.method.value}`;
  }
};

// src/parser.js
var Precedence = {
  LOWEST: 1,
  PIPE: 2,
  // |>
  TERNARY: 3,
  // ?:
  LOGICAL_OR: 4,
  // ||
  LOGICAL_AND: 5,
  // &&
  EQUALS: 5,
  // ==
  LESSGREATER: 6,
  // > or <
  RANGE: 7,
  // ..
  SUM: 8,
  // +
  PRODUCT: 9,
  // *
  POWER: 10,
  // **
  PREFIX: 10,
  // -X or !X
  CALL: 11,
  // myFunction(X)
  INDEX: 12
  // array[index]
};
var TOKEN_PRECEDENCE = {
  [TokenType.PIPE]: Precedence.PIPE,
  [TokenType.QUESTION]: Precedence.TERNARY,
  [TokenType.NULLISH]: Precedence.TERNARY,
  [TokenType.OR]: Precedence.LOGICAL_OR,
  [TokenType.AND]: Precedence.LOGICAL_AND,
  [TokenType.EQ]: Precedence.EQUALS,
  [TokenType.NOT_EQ]: Precedence.EQUALS,
  [TokenType.LT]: Precedence.LESSGREATER,
  [TokenType.GT]: Precedence.LESSGREATER,
  [TokenType.LTE]: Precedence.LESSGREATER,
  [TokenType.GTE]: Precedence.LESSGREATER,
  [TokenType.DOTDOT]: Precedence.RANGE,
  [TokenType.PLUS]: Precedence.SUM,
  [TokenType.MINUS]: Precedence.SUM,
  [TokenType.SLASH]: Precedence.PRODUCT,
  [TokenType.PERCENT]: Precedence.PRODUCT,
  [TokenType.ASTERISK]: Precedence.PRODUCT,
  [TokenType.POWER]: Precedence.POWER,
  ["++"]: Precedence.CALL,
  ["--"]: Precedence.CALL,
  ["?."]: Precedence.CALL,
  [TokenType.LPAREN]: Precedence.CALL,
  [TokenType.DOT]: Precedence.CALL,
  [TokenType.LBRACKET]: Precedence.INDEX
};
var Parser = class _Parser {
  constructor(lexer) {
    this.lexer = lexer;
    this.errors = [];
    this.curToken = null;
    this.peekToken = null;
    this.prefixParseFns = {};
    this.infixParseFns = {};
    this.registerPrefix(TokenType.IDENT, () => this.parseIdentifier());
    this.registerPrefix(TokenType.IMPORT, () => this.parseIdentifier());
    this.registerPrefix(TokenType.INT, () => this.parseIntegerLiteral());
    this.registerPrefix(TokenType.FLOAT, () => this.parseFloatLiteral());
    this.registerPrefix(TokenType.STRING, () => this.parseStringLiteral());
    this.registerPrefix(TokenType.FSTRING, () => this.parseFStringLiteral());
    this.registerPrefix(TokenType.FSTRING, () => this.parseFString());
    this.registerPrefix(TokenType.TRUE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.FALSE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.NULL, () => new NullLiteral(this.curToken));
    this.registerPrefix("MATCH", () => this.parseMatchExpression());
    this.registerPrefix(TokenType.BANG, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.MINUS, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.SPREAD, () => this.parseSpreadExpression());
    this.registerPrefix(TokenType.SUPER, () => this.parseSuperExpression());
    this.registerPrefix(TokenType.LPAREN, () => this.parseGroupedExpression());
    this.registerPrefix(TokenType.IF, () => this.parseIfExpression());
    this.registerPrefix(TokenType.WHILE, () => this.parseWhileExpression());
    this.registerPrefix(TokenType.DO, () => this.parseDoWhileExpression());
    this.registerPrefix(TokenType.BREAK, () => new BreakStatement(this.curToken));
    this.registerPrefix(TokenType.CONTINUE, () => new ContinueStatement(this.curToken));
    this.registerPrefix(TokenType.SWITCH, () => this.parseSwitchExpression());
    this.registerPrefix(TokenType.TRY, () => this.parseTryCatchExpression());
    this.registerPrefix(TokenType.THROW, () => {
      const token = this.curToken;
      this.nextToken();
      return new ThrowExpression(token, this.parseExpression(Precedence.LOWEST));
    });
    this.registerPrefix(TokenType.FOR, () => this.parseForExpression());
    this.registerPrefix(TokenType.FUNCTION, () => this.parseFunctionLiteral());
    this.registerPrefix(TokenType.LBRACKET, () => this.parseArrayLiteral());
    this.registerPrefix(TokenType.LBRACE, () => this.parseHashLiteral());
    for (const op of [
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.SLASH,
      TokenType.PERCENT,
      TokenType.ASTERISK,
      TokenType.EQ,
      TokenType.NOT_EQ,
      TokenType.LT,
      TokenType.GT,
      TokenType.LTE,
      TokenType.GTE,
      TokenType.AND,
      TokenType.OR,
      TokenType.NULLISH,
      TokenType.DOTDOT,
      TokenType.POWER
    ]) {
      this.registerInfix(op, (left) => this.parseInfixExpression(left));
    }
    this.registerInfix(TokenType.PIPE, (left) => this.parsePipeExpression(left));
    this.registerInfix("++", (left) => this.parsePostfixExpression(left, "+"));
    this.registerInfix("--", (left) => this.parsePostfixExpression(left, "-"));
    this.registerInfix("?.", (left) => this.parseOptionalChainExpression(left));
    this.registerInfix(TokenType.DOT, (left) => this.parseMethodCall(left));
    this.registerInfix(TokenType.QUESTION, (condition) => {
      const token = this.curToken;
      this.nextToken();
      const consequence = this.parseExpression(Precedence.TERNARY);
      if (!this.expectPeek(TokenType.COLON)) return null;
      this.nextToken();
      const alternative = this.parseExpression(Precedence.TERNARY);
      return new TernaryExpression(token, condition, consequence, alternative);
    });
    this.registerInfix(TokenType.LPAREN, (left) => this.parseCallExpression(left));
    this.registerInfix(TokenType.LBRACKET, (left) => this.parseIndexExpression(left));
    this.nextToken();
    this.nextToken();
  }
  registerPrefix(type, fn) {
    this.prefixParseFns[type] = fn;
  }
  registerInfix(type, fn) {
    this.infixParseFns[type] = fn;
  }
  nextToken() {
    this.curToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
  }
  curTokenIs(t) {
    return this.curToken.type === t;
  }
  peekTokenIs(t) {
    return this.peekToken.type === t;
  }
  expectPeek(t) {
    if (this.peekTokenIs(t)) {
      this.nextToken();
      return true;
    }
    this.peekError(t);
    return false;
  }
  peekError(t) {
    this.errors.push(`expected next token to be ${t}, got ${this.peekToken.type} instead`);
  }
  peekPrecedence() {
    return TOKEN_PRECEDENCE[this.peekToken.type] || Precedence.LOWEST;
  }
  curPrecedence() {
    return TOKEN_PRECEDENCE[this.curToken.type] || Precedence.LOWEST;
  }
  // --- Entry point ---
  parseProgram() {
    const program = new Program();
    while (!this.curTokenIs(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) program.statements.push(stmt);
      this.nextToken();
    }
    return program;
  }
  // --- Statements ---
  parseStatement() {
    switch (this.curToken.type) {
      case TokenType.LET:
        return this.parseLetStatement();
      case TokenType.CONST:
        return this.parseConstStatement();
      case TokenType.SET:
        return this.parseSetStatement();
      case TokenType.RETURN:
        return this.parseReturnStatement();
      case TokenType.IMPORT: {
        if (this.peekTokenIs(TokenType.LPAREN)) {
          return this.parseExpressionStatement();
        }
        return this.parseImportStatement();
      }
      case TokenType.EXPORT:
        return this.parseExportStatement();
      case "ENUM":
        return this.parseEnumStatement();
      case TokenType.CLASS:
        return this.parseClassStatement();
      default:
        return this.parseExpressionStatement();
    }
  }
  parseConstStatement() {
    const token = this.curToken;
    if (this.peekTokenIs(TokenType.LBRACKET)) {
      this.nextToken();
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        names.push(new Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value2 = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new DestructureLetStatement(token, names, value2, true);
    }
    if (this.peekTokenIs(TokenType.LBRACE)) {
      this.nextToken();
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACE)) {
        this.nextToken();
        names.push(new Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACE)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value2 = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new DestructureHashLetStatement(token, names, value2, true);
    }
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new Identifier(this.curToken, this.curToken.literal);
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new LetStatement(token, name, value);
  }
  parseLetStatement() {
    const token = this.curToken;
    if (this.peekTokenIs(TokenType.LBRACKET)) {
      this.nextToken();
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        names.push(new Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value2 = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new DestructureLetStatement(token, names, value2, token.type === "CONST");
    }
    if (this.peekTokenIs(TokenType.LBRACE)) {
      this.nextToken();
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACE)) {
        this.nextToken();
        names.push(new Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACE)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value2 = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new DestructureHashLetStatement(token, names, value2, token.type === "CONST");
    }
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new Identifier(this.curToken, this.curToken.literal);
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new LetStatement(token, name, value);
  }
  parseSetStatement() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.IDENT)) return null;
    let name = new Identifier(this.curToken, this.curToken.literal);
    while (this.peekTokenIs(TokenType.DOT)) {
      this.nextToken();
      this.nextToken();
      const key = new StringLiteral(this.curToken, this.curToken.literal);
      name = new IndexExpression(this.curToken, name, key);
    }
    while (this.peekTokenIs(TokenType.LBRACKET)) {
      this.nextToken();
      this.nextToken();
      const index = this.parseExpression(0);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      name = new IndexExpression(this.curToken, name, index);
    }
    let op = null;
    if (this.peekTokenIs(TokenType.PLUS_ASSIGN)) {
      op = "+";
    } else if (this.peekTokenIs(TokenType.MINUS_ASSIGN)) {
      op = "-";
    } else if (this.peekTokenIs(TokenType.ASTERISK_ASSIGN)) {
      op = "*";
    } else if (this.peekTokenIs(TokenType.SLASH_ASSIGN)) {
      op = "/";
    }
    if (op) {
      this.nextToken();
      this.nextToken();
      const right = this.parseExpression(Precedence.LOWEST);
      const value2 = new InfixExpression(this.curToken, name, op, right);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new SetStatement(token, name, value2);
    }
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new SetStatement(token, name, value);
  }
  parseReturnStatement() {
    const token = this.curToken;
    this.nextToken();
    const returnValue = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ReturnStatement(token, returnValue);
  }
  // import "module" for func1, func2;
  // import "module" as alias;
  // import "module";
  parseImportStatement() {
    const token = this.curToken;
    this.nextToken();
    if (this.curToken.type !== TokenType.STRING) {
      this.errors.push(`expected module name string after import, got ${this.curToken.type}`);
      return null;
    }
    const moduleName = this.curToken.literal;
    let bindings = null;
    let alias = null;
    this.nextToken();
    if (this.curTokenIs(TokenType.LBRACE)) {
      this.nextToken();
      bindings = [];
      bindings.push(this.curToken.literal);
      while (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken();
        this.nextToken();
        bindings.push(this.curToken.literal);
      }
      if (this.peekTokenIs(TokenType.RBRACE)) this.nextToken();
    } else if (this.curTokenIs(TokenType.AS)) {
      this.nextToken();
      alias = this.curToken.literal;
    }
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ImportStatement(token, moduleName, bindings, alias);
  }
  // export let x = ...;
  // export fn name(...) { ... };
  parseExportStatement() {
    const token = this.curToken;
    this.nextToken();
    const innerStmt = this.parseStatement();
    if (innerStmt) {
      innerStmt._exported = true;
    }
    return innerStmt;
  }
  parseExpressionStatement() {
    const token = this.curToken;
    const expression = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ExpressionStatement(token, expression);
  }
  parseBlockStatement() {
    const token = this.curToken;
    const statements = [];
    this.nextToken();
    while (!this.curTokenIs(TokenType.RBRACE) && !this.curTokenIs(TokenType.EOF)) {
      const stmt = this.parseStatement();
      if (stmt) statements.push(stmt);
      this.nextToken();
    }
    return new BlockStatement(token, statements);
  }
  // --- Expressions (Pratt) ---
  parseExpression(precedence) {
    const prefix = this.prefixParseFns[this.curToken.type];
    if (!prefix) {
      this.errors.push(`no prefix parse function for ${this.curToken.type}`);
      return null;
    }
    let leftExp = prefix();
    while (!this.peekTokenIs(TokenType.SEMICOLON) && precedence < this.peekPrecedence()) {
      const infix = this.infixParseFns[this.peekToken.type];
      if (!infix) return leftExp;
      this.nextToken();
      leftExp = infix(leftExp);
    }
    return leftExp;
  }
  parseIdentifier() {
    if (this.peekTokenIs(TokenType.ARROW)) {
      const ident = new Identifier(this.curToken, this.curToken.literal);
      this.nextToken();
      this.nextToken();
      let body;
      if (this.curTokenIs(TokenType.LBRACE)) {
        body = this.parseBlockStatement();
      } else {
        const expr = this.parseExpression(Precedence.LOWEST);
        const returnStmt = new ReturnStatement(this.curToken, expr);
        body = new BlockStatement(this.curToken, [returnStmt]);
      }
      return new FunctionLiteral(this.curToken, [ident], body);
    }
    return new Identifier(this.curToken, this.curToken.literal);
  }
  parseIntegerLiteral() {
    const value = parseInt(this.curToken.literal, 10);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as integer`);
      return null;
    }
    return new IntegerLiteral(this.curToken, value);
  }
  parseFloatLiteral() {
    const value = parseFloat(this.curToken.literal);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as float`);
      return null;
    }
    return new FloatLiteral(this.curToken, value);
  }
  parseStringLiteral() {
    return new StringLiteral(this.curToken, this.curToken.literal);
  }
  parseFStringLiteral() {
    const token = this.curToken;
    const raw = token.literal;
    const segments = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < raw.length && depth > 0) {
          if (raw[j] === "{") depth++;
          if (raw[j] === "}") depth--;
          j++;
        }
        const exprStr = raw.slice(i + 1, j - 1);
        const l = new Lexer(exprStr);
        const p = new _Parser(l);
        const expr = p.parseExpression(Precedence.LOWEST);
        segments.push({ type: "expr", expr });
        i = j;
      } else {
        let j = i;
        while (j < raw.length && raw[j] !== "{") j++;
        segments.push({ type: "text", value: raw.slice(i, j) });
        i = j;
      }
    }
    return new FStringExpression(token, segments);
  }
  parseFString() {
    const token = this.curToken;
    const raw = token.literal;
    const segments = [];
    let i = 0;
    let text = "";
    while (i < raw.length) {
      if (raw[i] === "{" && raw[i + 1] !== "{") {
        if (text) {
          segments.push({ type: "text", value: text });
          text = "";
        }
        let depth = 1;
        let exprStr = "";
        i++;
        while (i < raw.length && depth > 0) {
          if (raw[i] === "{") depth++;
          else if (raw[i] === "}") {
            depth--;
            if (depth === 0) break;
          }
          exprStr += raw[i];
          i++;
        }
        i++;
        const subLexer = new Lexer(exprStr);
        const subParser = new _Parser(subLexer);
        segments.push({ type: "expr", expr: subParser.parseExpression(Precedence.LOWEST) });
      } else if (raw[i] === "{" && raw[i + 1] === "{") {
        text += "{";
        i += 2;
      } else if (raw[i] === "}" && raw[i + 1] === "}") {
        text += "}";
        i += 2;
      } else {
        text += raw[i];
        i++;
      }
    }
    if (text) segments.push({ type: "text", value: text });
    return new FStringExpression(token, segments);
  }
  parseBooleanLiteral() {
    return new BooleanLiteral(this.curToken, this.curTokenIs(TokenType.TRUE));
  }
  parsePrefixExpression() {
    const token = this.curToken;
    const operator = this.curToken.literal;
    this.nextToken();
    const right = this.parseExpression(Precedence.PREFIX);
    return new PrefixExpression(token, operator, right);
  }
  parseSpreadExpression() {
    const token = this.curToken;
    this.nextToken();
    const value = this.parseExpression(Precedence.PREFIX);
    return new SpreadExpression(token, value);
  }
  parseMatchExpression() {
    const token = this.curToken;
    this.nextToken();
    const subject = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const arms = [];
    while (!this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF)) {
      this.nextToken();
      if (this.curToken.literal === "_") {
        if (!this.expectPeek(TokenType.ARROW)) return null;
        this.nextToken();
        const body2 = this.parseExpression(Precedence.LOWEST);
        arms.push({ pattern: null, body: body2 });
        if (this.peekTokenIs(TokenType.COMMA)) this.nextToken();
        continue;
      }
      const pattern = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.ARROW)) return null;
      this.nextToken();
      const body = this.parseExpression(Precedence.LOWEST);
      arms.push({ pattern, body });
      if (this.peekTokenIs(TokenType.COMMA)) this.nextToken();
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    return new MatchExpression(token, subject, arms);
  }
  parseInfixExpression(left) {
    const token = this.curToken;
    const operator = this.curToken.literal;
    const precedence = this.curPrecedence();
    this.nextToken();
    const right = this.parseExpression(precedence);
    return new InfixExpression(token, left, operator, right);
  }
  parsePipeExpression(left) {
    const token = this.curToken;
    const precedence = this.curPrecedence();
    this.nextToken();
    const right = this.parseExpression(precedence);
    return new CallExpression(token, right, [left]);
  }
  parseMethodCall(left) {
    const token = this.curToken;
    this.nextToken();
    const name = this.curToken.literal;
    if (this.peekTokenIs(TokenType.LPAREN)) {
      const methodName = new Identifier(this.curToken, name);
      this.nextToken();
      const args = this.parseExpressionList(TokenType.RPAREN);
      const call = new CallExpression(token, methodName, [left, ...args]);
      call._isMethodCall = true;
      call._methodName = name;
      return call;
    }
    const key = new StringLiteral(this.curToken, name);
    return new IndexExpression(token, left, key);
  }
  parseGroupedExpression() {
    this.nextToken();
    const exp = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return exp;
  }
  parseIfExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const consequence = this.parseBlockStatement();
    let alternative = null;
    if (this.peekTokenIs(TokenType.ELSE)) {
      this.nextToken();
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      alternative = this.parseBlockStatement();
    }
    return new IfExpression(token, condition, consequence, alternative);
  }
  parseWhileExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new WhileExpression(token, condition, body);
  }
  parseDoWhileExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    if (!this.expectPeek(TokenType.WHILE)) return null;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return new DoWhileExpression(token, body, condition);
  }
  parseTryCatchExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const tryBody = this.parseBlockStatement();
    if (!this.expectPeek(TokenType.CATCH)) return null;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const errorIdent = this.curToken.literal;
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const catchBody = this.parseBlockStatement();
    return new TryCatchExpression(token, tryBody, errorIdent, catchBody);
  }
  parseArrowExpression(left) {
    if (!(left instanceof Identifier)) {
      this.errors.push(`expected identifier before '=>', got ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const params = [left];
    this.nextToken();
    let body;
    if (this.curTokenIs(TokenType.LBRACE)) {
      body = this.parseBlockStatement();
    } else {
      const expr = this.parseExpression(Precedence.LOWEST);
      const returnStmt = new ReturnStatement(token, expr);
      body = new BlockStatement(token, [returnStmt]);
    }
    return new FunctionLiteral(token, params, body);
  }
  parseOptionalChainExpression(left) {
    const token = this.curToken;
    if (this.peekToken.type === TokenType.LBRACKET) {
      this.nextToken();
      this.nextToken();
      const index = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new OptionalChainExpression(token, left, index);
    } else if (this.peekToken.type === TokenType.IDENT) {
      this.nextToken();
      const key = new StringLiteral(this.curToken, this.curToken.literal);
      return new OptionalChainExpression(token, left, key);
    } else {
      this.errors.push(`expected [ or identifier after ?., got ${this.peekToken.type}`);
      return left;
    }
  }
  parsePostfixExpression(left, op) {
    if (!(left instanceof Identifier)) {
      this.errors.push(`cannot use ${op}${op} on ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const one = new IntegerLiteral(token, 1);
    const binExpr = new InfixExpression(token, left, op, one);
    return new SetStatement(token, new Identifier(token, left.value), binExpr);
  }
  parseEnumStatement() {
    const token = this.curToken;
    this.nextToken();
    if (this.curToken.type !== TokenType.IDENT) {
      this.errors.push(`expected enum name, got ${this.curToken.type}`);
      return null;
    }
    const name = this.curToken.literal;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const variants = [];
    while (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected variant name, got ${this.curToken.type}`);
        return null;
      }
      variants.push(this.curToken.literal);
      if (this.peekTokenIs(TokenType.COMMA)) this.nextToken();
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new EnumStatement(token, name, variants);
  }
  parseClassStatement() {
    const token = this.curToken;
    this.nextToken();
    if (this.curToken.type !== TokenType.IDENT) {
      this.errors.push(`expected class name, got ${this.curToken.type}`);
      return null;
    }
    const name = new Identifier(this.curToken, this.curToken.literal);
    let superClass = null;
    if (this.peekTokenIs(TokenType.EXTENDS)) {
      this.nextToken();
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected super class name, got ${this.curToken.type}`);
        return null;
      }
      superClass = new Identifier(this.curToken, this.curToken.literal);
    }
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const methods = [];
    while (!this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF)) {
      this.nextToken();
      if (this.curToken.type !== TokenType.IDENT) {
        this.errors.push(`expected method name in class ${name.value}, got ${this.curToken.type}`);
        return null;
      }
      const methodName = new Identifier(this.curToken, this.curToken.literal);
      if (!this.expectPeek(TokenType.LPAREN)) return null;
      const { params } = this.parseFunctionParameters();
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      const body = this.parseBlockStatement();
      methods.push({ name: methodName, params, body });
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ClassStatement(token, name, superClass, methods);
  }
  parseSuperExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.DOT)) return null;
    this.nextToken();
    if (this.curToken.type !== TokenType.IDENT) {
      this.errors.push(`expected method name after super., got ${this.curToken.type}`);
      return null;
    }
    return new SuperExpression(token, new Identifier(this.curToken, this.curToken.literal));
  }
  parseSwitchExpression() {
    const token = this.curToken;
    let value = null;
    if (this.peekTokenIs(TokenType.LPAREN)) {
      this.nextToken();
      this.nextToken();
      value = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
    }
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const cases = [];
    let defaultCase = null;
    while (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      if (this.curTokenIs(TokenType.CASE)) {
        this.nextToken();
        const caseValue = this.parseExpression(Precedence.LOWEST);
        if (!this.expectPeek(TokenType.COLON)) return null;
        let body;
        if (this.peekTokenIs(TokenType.LBRACE)) {
          this.nextToken();
          body = this.parseBlockStatement();
        } else {
          this.nextToken();
          body = this.parseExpression(Precedence.LOWEST);
        }
        cases.push({ value: caseValue, body });
      } else if (this.curTokenIs(TokenType.DEFAULT)) {
        if (!this.expectPeek(TokenType.COLON)) return null;
        if (this.peekTokenIs(TokenType.LBRACE)) {
          this.nextToken();
          defaultCase = this.parseBlockStatement();
        } else {
          this.nextToken();
          defaultCase = this.parseExpression(Precedence.LOWEST);
        }
      }
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    return new SwitchExpression(token, value, cases, defaultCase);
  }
  parseForExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    if (this.curTokenIs(TokenType.IDENT) && this.peekTokenIs(TokenType.IN)) {
      const ident = this.curToken.literal;
      this.nextToken();
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      const body2 = this.parseBlockStatement();
      return new ForInExpression(token, ident, iterable, body2);
    }
    let init;
    if (this.curTokenIs(TokenType.LET)) {
      init = this.parseLetStatement();
    } else if (this.curTokenIs(TokenType.SET)) {
      init = this.parseSetStatement();
    } else {
      this.errors.push(`expected LET or SET in for init, got ${this.curToken.type}`);
      return null;
    }
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.SEMICOLON)) return null;
    this.nextToken();
    let update;
    if (this.curTokenIs(TokenType.SET)) {
      update = this.parseSetStatement();
    } else {
      this.errors.push(`expected SET in for update, got ${this.curToken.type}`);
      return null;
    }
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new ForExpression(token, init, condition, update, body);
  }
  parseFunctionLiteral() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    const { params: parameters, defaults, restParam, paramTypes } = this.parseFunctionParameters();
    let returnType = null;
    if (this.peekTokenIs(TokenType.THIN_ARROW)) {
      this.nextToken();
      this.nextToken();
      returnType = this.curToken.literal;
    }
    if (this.peekTokenIs(TokenType.ARROW)) {
      this.nextToken();
      this.nextToken();
      const expr = this.parseExpression(Precedence.LOWEST);
      const returnStmt = new ReturnStatement(token, expr);
      const body2 = new BlockStatement(token, [returnStmt]);
      const fn2 = new FunctionLiteral(token, parameters, body2);
      fn2.restParam = restParam;
      fn2.defaults = defaults;
      fn2.paramTypes = paramTypes.length ? paramTypes : null;
      fn2.returnType = returnType;
      return fn2;
    }
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    const fn = new FunctionLiteral(token, parameters, body);
    fn.restParam = restParam;
    fn.defaults = defaults;
    fn.paramTypes = paramTypes.length ? paramTypes : null;
    fn.returnType = returnType;
    return fn;
  }
  parseFunctionParameters() {
    const params = [];
    const defaults = [];
    const paramTypes = [];
    let restParam = null;
    if (this.peekTokenIs(TokenType.RPAREN)) {
      this.nextToken();
      return { params, defaults, restParam, paramTypes };
    }
    this.nextToken();
    if (this.curTokenIs(TokenType.SPREAD)) {
      this.nextToken();
      restParam = new Identifier(this.curToken, this.curToken.literal);
    } else {
      params.push(new Identifier(this.curToken, this.curToken.literal));
      if (this.peekTokenIs(TokenType.COLON)) {
        this.nextToken();
        this.nextToken();
        paramTypes.push(this.curToken.literal);
      } else {
        paramTypes.push(null);
      }
      if (this.peekTokenIs(TokenType.ASSIGN)) {
        this.nextToken();
        this.nextToken();
        defaults.push(this.parseExpression(Precedence.LOWEST));
      } else {
        defaults.push(null);
      }
    }
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      if (this.curTokenIs(TokenType.SPREAD)) {
        this.nextToken();
        restParam = new Identifier(this.curToken, this.curToken.literal);
      } else {
        params.push(new Identifier(this.curToken, this.curToken.literal));
        if (this.peekTokenIs(TokenType.COLON)) {
          this.nextToken();
          this.nextToken();
          paramTypes.push(this.curToken.literal);
        } else {
          paramTypes.push(null);
        }
        if (this.peekTokenIs(TokenType.ASSIGN)) {
          this.nextToken();
          this.nextToken();
          defaults.push(this.parseExpression(Precedence.LOWEST));
        } else {
          defaults.push(null);
        }
      }
    }
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    return { params, defaults, restParam, paramTypes };
  }
  parseCallExpression(fn) {
    const token = this.curToken;
    const args = this.parseExpressionList(TokenType.RPAREN);
    return new CallExpression(token, fn, args);
  }
  parseArrayLiteral() {
    const token = this.curToken;
    if (this.peekTokenIs(TokenType.RBRACKET)) {
      this.nextToken();
      return new ArrayLiteral(token, []);
    }
    this.nextToken();
    const firstExpr = this.parseExpression(Precedence.LOWEST);
    if (this.peekToken.literal === "for") {
      this.nextToken();
      this.nextToken();
      const variable = new Identifier(this.curToken, this.curToken.literal);
      if (this.peekToken.literal !== "in") {
        this.errors.push('expected "in" in array comprehension');
        return null;
      }
      this.nextToken();
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      let condition = null;
      if (this.peekToken.literal === "if") {
        this.nextToken();
        this.nextToken();
        condition = this.parseExpression(Precedence.LOWEST);
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ArrayComprehension(token, firstExpr, variable, iterable, condition);
    }
    const elements = [firstExpr];
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      elements.push(this.parseExpression(Precedence.LOWEST));
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new ArrayLiteral(token, elements);
  }
  parseIndexExpression(left) {
    const token = this.curToken;
    this.nextToken();
    if (this.curTokenIs(TokenType.COLON)) {
      this.nextToken();
      if (this.curTokenIs(TokenType.RBRACKET)) {
        return new SliceExpression(token, left, null, null);
      }
      const end = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new SliceExpression(token, left, null, end);
    }
    const index = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.COLON)) {
      this.nextToken();
      this.nextToken();
      if (this.curTokenIs(TokenType.RBRACKET)) {
        return new SliceExpression(token, left, index, null);
      }
      const end = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new SliceExpression(token, left, index, end);
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new IndexExpression(token, left, index);
  }
  parseHashLiteral() {
    const token = this.curToken;
    const pairs = /* @__PURE__ */ new Map();
    while (!this.peekTokenIs(TokenType.RBRACE)) {
      this.nextToken();
      const key = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.COLON)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      pairs.set(key, value);
      if (!this.peekTokenIs(TokenType.RBRACE) && !this.expectPeek(TokenType.COMMA)) return null;
    }
    if (!this.expectPeek(TokenType.RBRACE)) return null;
    return new HashLiteral(token, pairs);
  }
  parseExpressionList(end) {
    const list = [];
    if (this.peekTokenIs(end)) {
      this.nextToken();
      return list;
    }
    this.nextToken();
    list.push(this.parseExpression(Precedence.LOWEST));
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      list.push(this.parseExpression(Precedence.LOWEST));
    }
    if (!this.expectPeek(end)) return null;
    return list;
  }
};

// src/wasm.js
function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value !== 0) byte |= 128;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}
function encodeSLEB128(value) {
  const bytes = [];
  let more = true;
  while (more) {
    let byte = value & 127;
    value >>= 7;
    if (value === 0 && (byte & 64) === 0 || value === -1 && (byte & 64) !== 0) {
      more = false;
    } else {
      byte |= 128;
    }
    bytes.push(byte);
  }
  return bytes;
}
function encodeF64(value) {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = value;
  return Array.from(new Uint8Array(buf));
}
function encodeF32(value) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = value;
  return Array.from(new Uint8Array(buf));
}
var WASM_TYPE = {
  I32: 127,
  I64: 126,
  F32: 125,
  F64: 124,
  FUNCREF: 112,
  EXTERNREF: 111
};
var WASM_SECTION = {
  TYPE: 1,
  IMPORT: 2,
  FUNCTION: 3,
  TABLE: 4,
  MEMORY: 5,
  GLOBAL: 6,
  EXPORT: 7,
  START: 8,
  ELEMENT: 9,
  CODE: 10,
  DATA: 11
};
var WASM_EXPORT_KIND = {
  FUNCTION: 0,
  TABLE: 1,
  MEMORY: 2,
  GLOBAL: 3
};
var WasmOp = {
  // Control flow
  unreachable: 0,
  nop: 1,
  block: 2,
  loop: 3,
  if_: 4,
  else_: 5,
  end: 11,
  br: 12,
  br_if: 13,
  return_: 15,
  call: 16,
  call_indirect: 17,
  // Variables
  local_get: 32,
  local_set: 33,
  local_tee: 34,
  global_get: 35,
  global_set: 36,
  // i32 operations
  i32_const: 65,
  i32_eqz: 69,
  i32_eq: 70,
  i32_ne: 71,
  i32_lt_s: 72,
  i32_lt_u: 73,
  i32_gt_s: 74,
  i32_gt_u: 75,
  i32_le_s: 76,
  i32_ge_s: 78,
  i32_add: 106,
  i32_sub: 107,
  i32_mul: 108,
  i32_div_s: 109,
  i32_rem_s: 111,
  i32_and: 113,
  i32_or: 114,
  i32_shl: 116,
  i32_shr_s: 117,
  // i64 operations
  i64_const: 66,
  i64_eqz: 80,
  i64_eq: 81,
  i64_ne: 82,
  i64_lt_s: 83,
  i64_gt_s: 85,
  i64_le_s: 87,
  i64_ge_s: 89,
  i64_add: 124,
  i64_sub: 125,
  i64_mul: 126,
  i64_div_s: 127,
  i64_rem_s: 129,
  // Conversion
  i64_extend_i32_s: 172,
  // sign-extend i32 to i64
  i32_wrap_i64: 167,
  // truncate i64 to i32
  f64_convert_i32_s: 183,
  // convert signed i32 to f64
  f64_convert_i64_s: 185,
  // convert signed i64 to f64
  // f64 operations
  f64_const: 68,
  f64_eq: 97,
  f64_ne: 98,
  f64_lt: 99,
  f64_gt: 100,
  f64_le: 101,
  f64_ge: 102,
  f64_add: 160,
  f64_sub: 161,
  f64_mul: 162,
  f64_div: 163,
  f64_neg: 154,
  // Drop
  drop: 26,
  // Memory operations
  i32_load: 40,
  i64_load: 41,
  f64_load: 43,
  i32_store: 54,
  i64_store: 55,
  f64_store: 57,
  memory_size: 63,
  memory_grow: 64
};
var WasmModule = class {
  constructor() {
    this.types = [];
    this.imports = [];
    this.functions = [];
    this.exports = [];
    this.codes = [];
    this.memory = null;
    this.dataSegments = [];
    this.globals = [];
    this.table = null;
    this.elements = [];
    this._nextDataOffset = 0;
  }
  /**
   * Add a function type (signature). Returns the type index.
   * Deduplicates: if same signature exists, returns existing index.
   */
  addType(params, results) {
    const sig = JSON.stringify({ params, results });
    for (let i = 0; i < this.types.length; i++) {
      if (JSON.stringify(this.types[i]) === sig) return i;
    }
    this.types.push({ params, results });
    return this.types.length - 1;
  }
  /**
   * Add a function import. Returns the function index.
   * Imports occupy indices 0..N-1, local functions start at N.
   */
  addImport(moduleName, name, params, results) {
    const typeIndex = this.addType(params, results);
    const funcIndex = this.imports.length;
    this.imports.push({ module: moduleName, name, typeIndex });
    return funcIndex;
  }
  /**
   * Add a local function. Returns the function index (imports.length + local index).
   */
  addFunction(typeIndex, locals, body) {
    const funcIndex = this.imports.length + this.functions.length;
    this.functions.push(typeIndex);
    this.codes.push({ locals, body });
    return funcIndex;
  }
  /**
   * Declare linear memory. Must be called before addDataSegment.
   * @param {number} minPages - Minimum pages (64KB each)
   * @param {number} [maxPages] - Maximum pages (optional)
   */
  addMemory(minPages, maxPages) {
    this.memory = { min: minPages, max: maxPages };
  }
  /**
   * Add a data segment to linear memory. Returns the byte offset.
   * Automatically ensures memory is declared.
   * @param {Uint8Array|string} data - Raw bytes or UTF-8 string
   * @returns {{offset: number, length: number}} - Position in memory
   */
  addDataSegment(data) {
    if (!this.memory) {
      this.addMemory(1);
    }
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const offset = this._nextDataOffset;
    this.dataSegments.push({ offset, data: bytes });
    this._nextDataOffset += bytes.length;
    this._nextDataOffset = this._nextDataOffset + 3 & ~3;
    return { offset, length: bytes.length };
  }
  /**
   * Add a string constant to the data segment.
   * Stores as: [i32 length][utf8 bytes]
   * Returns the offset of the length prefix.
   */
  addStringConstant(str) {
    if (!this.memory) {
      this.addMemory(1);
    }
    const encoded = new TextEncoder().encode(str);
    const offset = this._nextDataOffset;
    const totalLen = 4 + encoded.length;
    const buf = new Uint8Array(totalLen);
    buf[0] = encoded.length & 255;
    buf[1] = encoded.length >> 8 & 255;
    buf[2] = encoded.length >> 16 & 255;
    buf[3] = encoded.length >> 24 & 255;
    buf.set(encoded, 4);
    this.dataSegments.push({ offset, data: buf });
    this._nextDataOffset += totalLen;
    this._nextDataOffset = this._nextDataOffset + 3 & ~3;
    return { offset, length: encoded.length };
  }
  /**
   * Get the current data offset (for runtime heap allocation start).
   */
  getDataEnd() {
    return this._nextDataOffset;
  }
  /**
   * Add a global variable. Returns the global index.
   * @param {number} type - WASM_TYPE (I32, I64, F32, F64)
   * @param {boolean} mutable - Whether the global can be set
   * @param {number} initValue - Initial value (compiled as const expr)
   * @returns {number} Global index
   */
  addGlobal(type, mutable, initValue = 0) {
    const idx = this.globals.length;
    let initExpr;
    switch (type) {
      case WASM_TYPE.I32:
        initExpr = [WasmOp.i32_const, ...encodeSLEB128(initValue), WasmOp.end];
        break;
      case WASM_TYPE.I64:
        initExpr = [WasmOp.i64_const, ...encodeSLEB128(initValue), WasmOp.end];
        break;
      case WASM_TYPE.F64:
        initExpr = [WasmOp.f64_const, ...encodeF64(initValue), WasmOp.end];
        break;
      case WASM_TYPE.F32:
        initExpr = [WasmOp.f32_const, ...encodeF32(initValue), WasmOp.end];
        break;
      default:
        initExpr = [WasmOp.i32_const, ...encodeSLEB128(initValue), WasmOp.end];
    }
    this.globals.push({ type, mutable, initExpr });
    return idx;
  }
  /**
   * Export a global variable.
   */
  exportGlobal(name, globalIndex) {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.GLOBAL, index: globalIndex });
  }
  /**
   * Add a function reference table for indirect calls.
   * @param {number} minSize - Minimum table size
   * @param {number} [maxSize] - Maximum table size
   */
  addTable(minSize, maxSize) {
    this.table = { min: minSize, max: maxSize };
  }
  /**
   * Add a function to the table (element section).
   * Returns the table index for the function.
   * @param {number} funcIndex - Function index to add to table
   * @returns {number} Table index
   */
  addTableElement(funcIndex) {
    if (!this.table) {
      this.addTable(0);
    }
    const idx = this.elements.length;
    this.elements.push(funcIndex);
    if (this.table.min < this.elements.length) {
      this.table.min = this.elements.length;
    }
    return idx;
  }
  /**
   * Export the function table.
   */
  exportTable(name = "table") {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.TABLE, index: 0 });
  }
  /**
   * Export a function by name.
   */
  exportFunction(name, funcIndex) {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.FUNCTION, index: funcIndex });
  }
  /**
   * Export linear memory so the host can read/write it.
   */
  exportMemory(name = "memory") {
    this.exports.push({ name, kind: WASM_EXPORT_KIND.MEMORY, index: 0 });
  }
  /**
   * Encode the module to a Uint8Array (valid .wasm binary).
   */
  encode() {
    const sections = [];
    if (this.types.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.types.length));
      for (const type of this.types) {
        content.push(96);
        content.push(...encodeULEB128(type.params.length));
        for (const p of type.params) content.push(p);
        content.push(...encodeULEB128(type.results.length));
        for (const r of type.results) content.push(r);
      }
      sections.push(this._encodeSection(WASM_SECTION.TYPE, content));
    }
    if (this.imports.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.imports.length));
      for (const imp of this.imports) {
        const modBytes = new TextEncoder().encode(imp.module);
        content.push(...encodeULEB128(modBytes.length));
        content.push(...modBytes);
        const nameBytes = new TextEncoder().encode(imp.name);
        content.push(...encodeULEB128(nameBytes.length));
        content.push(...nameBytes);
        content.push(0);
        content.push(...encodeULEB128(imp.typeIndex));
      }
      sections.push(this._encodeSection(WASM_SECTION.IMPORT, content));
    }
    if (this.functions.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.functions.length));
      for (const typeIdx of this.functions) {
        content.push(...encodeULEB128(typeIdx));
      }
      sections.push(this._encodeSection(WASM_SECTION.FUNCTION, content));
    }
    if (this.table) {
      const content = [];
      content.push(...encodeULEB128(1));
      content.push(112);
      if (this.table.max !== void 0) {
        content.push(1);
        content.push(...encodeULEB128(this.table.min));
        content.push(...encodeULEB128(this.table.max));
      } else {
        content.push(0);
        content.push(...encodeULEB128(this.table.min));
      }
      sections.push(this._encodeSection(WASM_SECTION.TABLE, content));
    }
    if (this.memory) {
      const content = [];
      content.push(...encodeULEB128(1));
      if (this.memory.max !== void 0) {
        content.push(1);
        content.push(...encodeULEB128(this.memory.min));
        content.push(...encodeULEB128(this.memory.max));
      } else {
        content.push(0);
        content.push(...encodeULEB128(this.memory.min));
      }
      sections.push(this._encodeSection(WASM_SECTION.MEMORY, content));
    }
    if (this.globals.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.globals.length));
      for (const g of this.globals) {
        content.push(g.type);
        content.push(g.mutable ? 1 : 0);
        content.push(...g.initExpr);
      }
      sections.push(this._encodeSection(WASM_SECTION.GLOBAL, content));
    }
    if (this.exports.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.exports.length));
      for (const exp of this.exports) {
        const nameBytes = new TextEncoder().encode(exp.name);
        content.push(...encodeULEB128(nameBytes.length));
        content.push(...nameBytes);
        content.push(exp.kind);
        content.push(...encodeULEB128(exp.index));
      }
      sections.push(this._encodeSection(WASM_SECTION.EXPORT, content));
    }
    if (this.elements.length > 0) {
      const content = [];
      content.push(...encodeULEB128(1));
      content.push(0);
      content.push(WasmOp.i32_const, ...encodeSLEB128(0), WasmOp.end);
      content.push(...encodeULEB128(this.elements.length));
      for (const funcIdx of this.elements) {
        content.push(...encodeULEB128(funcIdx));
      }
      sections.push(this._encodeSection(WASM_SECTION.ELEMENT, content));
    }
    if (this.codes.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.codes.length));
      for (const code of this.codes) {
        const funcBody = [];
        funcBody.push(...encodeULEB128(code.locals.length));
        for (const local of code.locals) {
          funcBody.push(...encodeULEB128(local.count));
          funcBody.push(local.type);
        }
        funcBody.push(...code.body);
        funcBody.push(WasmOp.end);
        content.push(...encodeULEB128(funcBody.length));
        content.push(...funcBody);
      }
      sections.push(this._encodeSection(WASM_SECTION.CODE, content));
    }
    if (this.dataSegments.length > 0) {
      const content = [];
      content.push(...encodeULEB128(this.dataSegments.length));
      for (const seg of this.dataSegments) {
        content.push(0);
        content.push(WasmOp.i32_const);
        content.push(...encodeSLEB128(seg.offset));
        content.push(WasmOp.end);
        content.push(...encodeULEB128(seg.data.length));
        content.push(...seg.data);
      }
      sections.push(this._encodeSection(WASM_SECTION.DATA, content));
    }
    const header = [
      0,
      97,
      115,
      109,
      // magic: \0asm
      1,
      0,
      0,
      0
      // version: 1
    ];
    const totalSize = header.length + sections.reduce((sum, s) => sum + s.length, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const byte of header) result[offset++] = byte;
    for (const section of sections) {
      for (const byte of section) result[offset++] = byte;
    }
    return result;
  }
  _encodeSection(id, content) {
    return [id, ...encodeULEB128(content.length), ...content];
  }
};

// src/wasm-compiler.js
function compileToWasm(source, options = {}) {
  const lexer = new Lexer(source);
  const parser = new Parser(lexer);
  const program = parser.parseProgram();
  if (parser.errors.length > 0) {
    throw new Error(`Parse errors: ${parser.errors.join(", ")}`);
  }
  const compiler = new WasmCompiler(options);
  return compiler.compile(program);
}
var WasmCompiler = class {
  constructor(options = {}) {
    this.module = new WasmModule();
    this.functions = /* @__PURE__ */ new Map();
    this.globals = /* @__PURE__ */ new Map();
    this.stringConstants = /* @__PURE__ */ new Map();
    this.currentLocals = null;
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    this.useI64 = options.useI64 || false;
    this.useF64 = options.useF64 || false;
    this.importSignatures = options.importSignatures || null;
    this._strConcatImport = null;
    this._heapBaseGlobal = null;
    this._allocFuncIdx = null;
    this._needsMemory = false;
    this._anonCounter = 0;
    this._anonMap = /* @__PURE__ */ new Map();
    this._anonFunctions = [];
  }
  // Count local (non-imported) functions in the map
  _localFunctionCount() {
    let count = 0;
    for (const [, info] of this.functions) {
      if (!info.imported) count++;
    }
    return count;
  }
  // Get the appropriate numeric type
  get numType() {
    return this.useF64 ? WASM_TYPE.F64 : this.useI64 ? WASM_TYPE.I64 : WASM_TYPE.I32;
  }
  // Get i32/i64 opcode by name
  iop(name) {
    const prefix = this.useF64 ? "f64_" : this.useI64 ? "i64_" : "i32_";
    return WasmOp[prefix + name];
  }
  // Comparison op: f64 uses unsuffixed names (lt, gt), integers use _s suffix
  cop(name) {
    if (this.useF64) return WasmOp["f64_" + name];
    const prefix = this.useI64 ? "i64_" : "i32_";
    return WasmOp[prefix + name + "_s"];
  }
  // Emit a numeric constant (handles f64's 8-byte encoding and i64 BigInt)
  _emitConst(body, value) {
    if (this.useF64) {
      this._emitF64Const(body, value);
    } else {
      body.push(this.iop("const"), ...encodeSLEB128(value));
    }
  }
  compile(program) {
    this._processImports(program.statements);
    if (this._programNeedsMemory(program)) {
      this._getAllocFunc();
    }
    this._processGlobals(program.statements);
    this._collectFunctions(program.statements);
    for (const stmt of program.statements) {
      if (stmt instanceof LetStatement && stmt.value instanceof FunctionLiteral) {
        this._compileFunction(stmt.name.value, stmt.value);
      }
    }
    for (const { name, fnLit } of this._anonFunctions) {
      this._compileFunction(name, fnLit);
    }
    this._initializeGlobals(program.statements);
    const mainStatements = program.statements.filter(
      (stmt) => !(stmt instanceof LetStatement) && !(stmt instanceof ImportStatement)
    );
    if (mainStatements.length > 0) {
      this._compileMainBlock(mainStatements);
    }
    if (this.module.dataSegments.length > 0 || this._needsMemory) {
      this._ensureMemory();
      this.module.exportMemory();
    }
    return this.module.encode();
  }
  // Scan AST to see if any arrays are used (need memory + allocator)
  _programNeedsMemory(program) {
    const scan = (node) => {
      if (!node) return false;
      if (node instanceof ArrayLiteral) return true;
      if (node instanceof IndexExpression) return true;
      if (node.statements) return node.statements.some((s) => scan(s));
      if (node.expression) return scan(node.expression);
      if (node.value) return scan(node.value);
      if (node.returnValue) return scan(node.returnValue);
      if (node.consequence) {
        if (scan(node.consequence)) return true;
      }
      if (node.alternative) {
        if (scan(node.alternative)) return true;
      }
      if (node.body) return scan(node.body);
      if (node.left) {
        if (scan(node.left)) return true;
      }
      if (node.right) {
        if (scan(node.right)) return true;
      }
      if (node.arguments) {
        if (node.arguments.some((a) => scan(a))) return true;
      }
      if (node.elements) {
        if (node.elements.some((e) => scan(e))) return true;
      }
      if (node.parameters) return false;
      if (node.condition) {
        if (scan(node.condition)) return true;
      }
      if (node.init) {
        if (scan(node.init)) return true;
      }
      if (node.update) {
        if (scan(node.update)) return true;
      }
      if (node.index) {
        if (scan(node.index)) return true;
      }
      return false;
    };
    return program.statements.some((s) => scan(s));
  }
  // Lazily add the __str_concat import when string concatenation is first used
  _getStrConcatImport() {
    if (this._strConcatImport === null) {
      this._strConcatImport = this.module.addImport(
        "env",
        "__str_concat",
        [WASM_TYPE.I32, WASM_TYPE.I32],
        [WASM_TYPE.I32]
      );
    }
    return this._strConcatImport;
  }
  // Ensure memory exists and heap pointer global is initialized
  _ensureMemory() {
    if (this._needsMemory) return;
    this._needsMemory = true;
    if (!this.module.memory) {
      this.module.addMemory(1);
    }
  }
  // Get the heap base global index (lazily created)
  _getHeapBaseGlobal() {
    if (this._heapBaseGlobal === null) {
      this._ensureMemory();
      this._heapBaseGlobal = this.module.addGlobal(WASM_TYPE.I32, true, 4096);
    }
    return this._heapBaseGlobal;
  }
  // Get the __alloc function index (bump allocator)
  // __alloc(size: i32) -> ptr: i32
  // Bumps heap pointer by size (aligned to 4), returns old pointer
  _getAllocFunc() {
    if (this._allocFuncIdx !== null) return this._allocFuncIdx;
    const heapGlobal = this._getHeapBaseGlobal();
    const typeIdx = this.module.addType([WASM_TYPE.I32], [WASM_TYPE.I32]);
    const body = [
      WasmOp.global_get,
      ...encodeULEB128(heapGlobal),
      WasmOp.local_set,
      1,
      // local 1 = $ptr (local 0 is the size param)
      WasmOp.global_get,
      ...encodeULEB128(heapGlobal),
      WasmOp.local_get,
      0,
      // size
      WasmOp.i32_add,
      WasmOp.i32_const,
      3,
      WasmOp.i32_add,
      WasmOp.i32_const,
      ...encodeSLEB128(-4),
      // 0xFFFFFFFC
      WasmOp.i32_and,
      WasmOp.global_set,
      ...encodeULEB128(heapGlobal),
      WasmOp.local_get,
      1
      // return ptr
    ];
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, [{ count: 1, type: WASM_TYPE.I32 }], body);
    this._allocFuncIdx = funcIdx;
    return funcIdx;
  }
  _processGlobals(statements) {
    for (const stmt of statements) {
      if (stmt instanceof LetStatement && !(stmt.value instanceof FunctionLiteral)) {
        const name = stmt.name.value;
        const idx = this.module.addGlobal(this.numType, true, 0);
        this.globals.set(name, { index: idx, mutable: true });
      }
    }
  }
  _initializeGlobals(statements) {
    const initBody = [];
    let hasInits = false;
    this.currentLocals = /* @__PURE__ */ new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    for (const stmt of statements) {
      if (stmt instanceof LetStatement && !(stmt.value instanceof FunctionLiteral)) {
        const name = stmt.name.value;
        const global = this.globals.get(name);
        if (global) {
          this._compileExpr(stmt.value, initBody);
          initBody.push(WasmOp.global_set, ...encodeULEB128(global.index));
          hasInits = true;
        }
      }
    }
    if (hasInits) {
      const typeIdx = this.module.addType([], []);
      const locals = this.currentExtraLocals > 0 ? [{ count: this.currentExtraLocals, type: this.numType }] : [];
      const funcIdx = this.module.addFunction(typeIdx, locals, initBody);
      this._initFuncIdx = funcIdx;
    }
    this.currentLocals = null;
  }
  _processImports(statements) {
    for (const stmt of statements) {
      if (stmt instanceof ImportStatement) {
        const moduleName = stmt.moduleName;
        if (stmt.bindings) {
          for (const binding of stmt.bindings) {
            const sig = this.importSignatures && this.importSignatures[`${moduleName}.${binding}`] || { params: [this.numType], results: [this.numType] };
            const funcIdx = this.module.addImport(moduleName, binding, sig.params, sig.results);
            this.functions.set(binding, { index: funcIdx, params: sig.params.length, imported: true });
          }
        } else if (stmt.alias) {
        }
      }
    }
  }
  _collectFunctions(statements) {
    for (const stmt of statements) {
      if (stmt instanceof LetStatement && stmt.value instanceof FunctionLiteral) {
        const name = stmt.name.value;
        const fn = stmt.value;
        const paramCount = fn.parameters.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        const funcIdx = this.module.imports.length + this.module.functions.length + this._localFunctionCount();
        const tableIdx = this.module.addTableElement(funcIdx);
        this.functions.set(name, { index: funcIdx, params: paramCount, typeIdx, tableIdx });
      }
    }
    this._scanForAnonymousFunctions(statements);
  }
  _scanForAnonymousFunctions(nodes) {
    const scan = (node) => {
      if (!node) return;
      if (node instanceof FunctionLiteral && !this._anonMap.has(node)) {
        const name = `__anon_${this._anonCounter++}`;
        const paramCount = node.parameters.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        const funcIdx = this.module.imports.length + this.module.functions.length + this._localFunctionCount();
        const tableIdx = this.module.addTableElement(funcIdx);
        this.functions.set(name, { index: funcIdx, params: paramCount, typeIdx, tableIdx });
        this._anonMap.set(node, name);
        this._anonFunctions.push({ name, fnLit: node });
        if (node.body) scan(node.body);
        return;
      }
      if (node.statements) node.statements.forEach((s) => scan(s));
      if (node.expression) scan(node.expression);
      if (node.value) scan(node.value);
      if (node.returnValue) scan(node.returnValue);
      if (node.consequence) scan(node.consequence);
      if (node.alternative) scan(node.alternative);
      if (node.body) scan(node.body);
      if (node.left) scan(node.left);
      if (node.right) scan(node.right);
      if (node.arguments) node.arguments.forEach((a) => scan(a));
      if (node.elements) node.elements.forEach((e) => scan(e));
      if (node.condition) scan(node.condition);
      if (node.init) scan(node.init);
      if (node.update) scan(node.update);
      if (node.index) scan(node.index);
      if (node.function) scan(node.function);
    };
    for (const node of nodes) scan(node);
  }
  _compileFunction(name, fnLit) {
    const info = this.functions.get(name);
    this.currentLocals = /* @__PURE__ */ new Map();
    this.currentLocalCount = fnLit.parameters.length;
    this.currentExtraLocals = 0;
    for (let i = 0; i < fnLit.parameters.length; i++) {
      this.currentLocals.set(fnLit.parameters[i].value, i);
    }
    const body = [];
    const stmts = fnLit.body.statements;
    if (stmts.length === 0) {
      this._emitConst(body, 0);
    } else {
      for (let i = 0; i < stmts.length; i++) {
        const isLast = i === stmts.length - 1;
        this._compileStatement(stmts[i], body, isLast);
      }
    }
    const locals = this.currentExtraLocals > 0 ? [{ count: this.currentExtraLocals, type: this.numType }] : [];
    this.module.addFunction(info.typeIdx, locals, body);
    this.module.exportFunction(name, info.index);
    this.currentLocals = null;
  }
  _compileMainBlock(statements) {
    const typeIdx = this.module.addType([], [this.numType]);
    this.currentLocals = /* @__PURE__ */ new Map();
    this.currentLocalCount = 0;
    this.currentExtraLocals = 0;
    const body = [];
    if (this._initFuncIdx !== void 0) {
      body.push(WasmOp.call, ...encodeULEB128(this._initFuncIdx));
    }
    for (let i = 0; i < statements.length; i++) {
      const isLast = i === statements.length - 1;
      this._compileStatement(statements[i], body, isLast);
    }
    const locals = this.currentExtraLocals > 0 ? [{ count: this.currentExtraLocals, type: this.numType }] : [];
    const funcIdx = this.module.imports.length + this.module.functions.length;
    this.module.addFunction(typeIdx, locals, body);
    this.module.exportFunction("main", funcIdx);
  }
  _compileStatement(stmt, body, isLast) {
    if (stmt instanceof ReturnStatement) {
      this._compileExpr(stmt.returnValue, body);
      body.push(WasmOp.return_);
    } else if (stmt instanceof LetStatement) {
      const localIdx = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      this.currentLocals.set(stmt.name.value, localIdx);
      this._compileExpr(stmt.value, body);
      body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
      if (isLast) {
        body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
      }
    } else if (stmt instanceof SetStatement) {
      if (stmt.name instanceof IndexExpression) {
        this._compileExpr(stmt.name.left, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_const, 8);
        body.push(WasmOp.i32_add);
        this._compileExpr(stmt.name.index, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_const, 4);
        body.push(WasmOp.i32_mul);
        body.push(WasmOp.i32_add);
        this._compileExpr(stmt.value, body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_store, 2, 0);
        if (isLast) {
          this._compileExpr(stmt.value, body);
        }
        return;
      }
      const name = stmt.name?.value || stmt.target?.left?.value;
      const localIdx = this.currentLocals?.get(name);
      if (localIdx !== void 0) {
        this._compileExpr(stmt.value, body);
        body.push(WasmOp.local_set, ...encodeULEB128(localIdx));
        if (isLast) {
          body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
        }
      } else if (this.globals.has(name)) {
        this._compileExpr(stmt.value, body);
        const globalIdx = this.globals.get(name).index;
        body.push(WasmOp.global_set, ...encodeULEB128(globalIdx));
        if (isLast) {
          body.push(WasmOp.global_get, ...encodeULEB128(globalIdx));
        }
      } else {
        throw new Error(`Undefined variable in WASM set: ${name}`);
      }
    } else if (stmt instanceof ExpressionStatement) {
      this._compileExpr(stmt.expression, body);
      if (!isLast) {
        body.push(WasmOp.drop);
      }
    }
  }
  _emitZero(body) {
    if (this.useF64) {
      this._emitF64Const(body, 0);
    } else {
      this._emitConst(body, 0);
    }
  }
  _emitF64Const(body, value) {
    body.push(WasmOp.f64_const);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    const bytes = new Uint8Array(buf);
    for (const b of bytes) body.push(b);
  }
  _compileWhile(condition, loopBody, body) {
    body.push(WasmOp.block, 64);
    body.push(WasmOp.loop, 64);
    this._compileExpr(condition, body);
    if (this.useF64) {
      this._emitF64Const(body, 0);
      body.push(WasmOp.f64_eq);
    } else {
      body.push(this.iop("eqz"));
    }
    body.push(WasmOp.br_if, 1);
    if (loopBody) {
      const stmts = loopBody.statements;
      for (let i = 0; i < stmts.length; i++) {
        this._compileStatement(stmts[i], body, false);
      }
    }
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
  }
  // Compile push(array, value) — inline, no reallocation (uses pre-allocated capacity)
  // Returns new length
  _compileArrayPush(arrExpr, valExpr, body) {
    const ptrLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const lenLocal = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(lenLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    this._compileExpr(valExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.local_get, ...encodeULEB128(lenLocal));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }
  // map(arr, fn) — create new array, apply fn to each element
  _compileArrayMap(arrExpr, fnExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const dstPtr = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));
    const allocIdx = this._getAllocFunc();
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 4);
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));
    const typeIdx = this.module.addType([this.numType], [this.numType]);
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.block, 64);
    body.push(WasmOp.loop, 64);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }
  // filter(arr, fn) — create new array with elements where fn returns truthy
  _compileArrayFilter(arrExpr, fnExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const dstPtr = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const elemVar = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));
    const allocIdx = this._getAllocFunc();
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.call, ...encodeULEB128(allocIdx));
    body.push(WasmOp.local_set, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.i32_store, 2, 0);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_store, 2, 4);
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));
    const typeIdx = this.module.addType([this.numType], [this.numType]);
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.block, 64);
    body.push(WasmOp.loop, 64);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(elemVar));
    body.push(WasmOp.local_get, ...encodeULEB128(elemVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.if_, 64);
    {
      const dstLenTemp = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.i32_load, 2, 0);
      body.push(WasmOp.local_set, ...encodeULEB128(dstLenTemp));
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenTemp));
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.local_get, ...encodeULEB128(elemVar));
      body.push(WasmOp.i32_store, 2, 0);
      body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
      body.push(WasmOp.local_get, ...encodeULEB128(dstLenTemp));
      body.push(WasmOp.i32_const, 1);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_store, 2, 0);
    }
    body.push(WasmOp.end);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    body.push(WasmOp.local_get, ...encodeULEB128(dstPtr));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }
  // reduce(arr, fn, init) — fold array: fn(fn(...fn(init, a[0]), a[1])..., a[n-1])
  _compileArrayReduce(arrExpr, fnExpr, initExpr, body) {
    const srcPtr = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const srcLen = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const idxVar = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const fnIdx = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    const accVar = this.currentLocalCount + this.currentExtraLocals;
    this.currentExtraLocals++;
    this._compileExpr(arrExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(srcPtr));
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_load, 2, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(srcLen));
    this._compileExpr(fnExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(fnIdx));
    this._compileExpr(initExpr, body);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(accVar));
    const typeIdx = this.module.addType([this.numType, this.numType], [this.numType]);
    body.push(WasmOp.i32_const, 0);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.block, 64);
    body.push(WasmOp.loop, 64);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.local_get, ...encodeULEB128(srcLen));
    body.push(WasmOp.i32_ge_s);
    body.push(WasmOp.br_if, 1);
    body.push(WasmOp.local_get, ...encodeULEB128(accVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
    body.push(WasmOp.local_get, ...encodeULEB128(srcPtr));
    body.push(WasmOp.i32_const, 8);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 4);
    body.push(WasmOp.i32_mul);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.i32_load, 2, 0);
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
    body.push(WasmOp.local_get, ...encodeULEB128(fnIdx));
    body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0);
    if (this.useI64) body.push(WasmOp.i32_wrap_i64);
    body.push(WasmOp.local_set, ...encodeULEB128(accVar));
    body.push(WasmOp.local_get, ...encodeULEB128(idxVar));
    body.push(WasmOp.i32_const, 1);
    body.push(WasmOp.i32_add);
    body.push(WasmOp.local_set, ...encodeULEB128(idxVar));
    body.push(WasmOp.br, 0);
    body.push(WasmOp.end);
    body.push(WasmOp.end);
    body.push(WasmOp.local_get, ...encodeULEB128(accVar));
    if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
  }
  _compileExpr(expr, body) {
    if (!expr) {
      this._emitConst(body, 0);
      return;
    }
    if (expr instanceof IntegerLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value);
      } else {
        body.push(this.iop("const"), ...encodeSLEB128(expr.value));
      }
      return;
    }
    if (expr instanceof FloatLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value);
      } else {
        body.push(this.iop("const"), ...encodeSLEB128(Math.trunc(expr.value)));
      }
      return;
    }
    if (expr instanceof StringLiteral) {
      const str = expr.value;
      if (!this.stringConstants.has(str)) {
        const { offset } = this.module.addStringConstant(str);
        this.stringConstants.set(str, offset);
      }
      const ptr = this.stringConstants.get(str);
      body.push(WasmOp.i32_const, ...encodeSLEB128(ptr));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }
    if (expr instanceof BooleanLiteral) {
      if (this.useF64) {
        this._emitF64Const(body, expr.value ? 1 : 0);
      } else {
        body.push(this.iop("const"), ...encodeSLEB128(expr.value ? 1 : 0));
      }
      return;
    }
    if (expr instanceof Identifier) {
      const localIdx = this.currentLocals?.get(expr.value);
      if (localIdx !== void 0) {
        body.push(WasmOp.local_get, ...encodeULEB128(localIdx));
      } else if (this.globals.has(expr.value)) {
        body.push(WasmOp.global_get, ...encodeULEB128(this.globals.get(expr.value).index));
      } else if (this.functions.has(expr.value)) {
        const funcInfo = this.functions.get(expr.value);
        this._emitConst(body, funcInfo.tableIdx);
      } else {
        throw new Error(`Undefined variable in WASM compilation: ${expr.value}`);
      }
      return;
    }
    if (expr instanceof InfixExpression) {
      if (expr.left instanceof IntegerLiteral && expr.right instanceof IntegerLiteral && !this.useF64) {
        const l = expr.left.value;
        const r = expr.right.value;
        let result;
        switch (expr.operator) {
          case "+":
            result = l + r;
            break;
          case "-":
            result = l - r;
            break;
          case "*":
            result = l * r;
            break;
          case "/":
            result = r !== 0 ? Math.trunc(l / r) : 0;
            break;
          case "%":
            result = r !== 0 ? l % r : 0;
            break;
          case "<":
            result = l < r ? 1 : 0;
            break;
          case ">":
            result = l > r ? 1 : 0;
            break;
          case "<=":
            result = l <= r ? 1 : 0;
            break;
          case ">=":
            result = l >= r ? 1 : 0;
            break;
          case "==":
            result = l === r ? 1 : 0;
            break;
          case "!=":
            result = l !== r ? 1 : 0;
            break;
          default:
            result = void 0;
        }
        if (result !== void 0) {
          this._emitConst(body, result);
          return;
        }
      }
      this._compileExpr(expr.left, body);
      this._compileExpr(expr.right, body);
      switch (expr.operator) {
        case "+": {
          if (expr.left instanceof StringLiteral || expr.right instanceof StringLiteral) {
            const concatIdx = this._getStrConcatImport();
            if (this.useI64) {
              body.push(WasmOp.i32_wrap_i64);
              body.length -= 1;
            }
            body.push(WasmOp.call, ...encodeULEB128(concatIdx));
          } else {
            body.push(this.iop("add"));
          }
          break;
        }
        case "-":
          body.push(this.iop("sub"));
          break;
        case "*":
          body.push(this.iop("mul"));
          break;
        case "/":
          body.push(this.useF64 ? WasmOp.f64_div : this.iop("div_s"));
          break;
        case "%":
          if (this.useF64) throw new Error("WASM f64 does not support %");
          body.push(this.iop("rem_s"));
          break;
        case "<":
          body.push(this.cop("lt"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        case ">":
          body.push(this.cop("gt"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        case "==":
          body.push(this.iop("eq"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        case "!=":
          body.push(this.iop("ne"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        case "<=":
          body.push(this.cop("le"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        case ">=":
          body.push(this.cop("ge"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
          if (this.useF64) body.push(WasmOp.f64_convert_i32_s);
          break;
        default:
          throw new Error(`Unsupported operator in WASM: ${expr.operator}`);
      }
      return;
    }
    if (expr instanceof PrefixExpression) {
      if (expr.right instanceof IntegerLiteral && !this.useF64) {
        if (expr.operator === "-") {
          this._emitConst(body, -expr.right.value);
          return;
        }
        if (expr.operator === "!") {
          this._emitConst(body, expr.right.value === 0 ? 1 : 0);
          return;
        }
      }
      if (expr.operator === "-") {
        if (this.useF64) {
          this._compileExpr(expr.right, body);
          body.push(WasmOp.f64_neg);
        } else {
          this._emitConst(body, 0);
          this._compileExpr(expr.right, body);
          body.push(this.iop("sub"));
        }
      } else if (expr.operator === "!") {
        this._compileExpr(expr.right, body);
        if (this.useF64) {
          this._emitF64Const(body, 0);
          body.push(WasmOp.f64_eq);
          body.push(WasmOp.f64_convert_i32_s);
        } else {
          body.push(this.iop("eqz"));
          if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        }
      } else {
        throw new Error(`Unsupported prefix operator in WASM: ${expr.operator}`);
      }
      return;
    }
    if (expr instanceof CallExpression) {
      const funcName = expr.function.value;
      if (funcName === "len" && expr.arguments.length === 1) {
        this._compileExpr(expr.arguments[0], body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.i32_load, 2, 0);
        if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
        return;
      }
      if (funcName === "push" && expr.arguments.length === 2) {
        this._compileArrayPush(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      if (funcName === "map" && expr.arguments.length === 2) {
        this._compileArrayMap(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      if (funcName === "filter" && expr.arguments.length === 2) {
        this._compileArrayFilter(expr.arguments[0], expr.arguments[1], body);
        return;
      }
      if (funcName === "reduce" && expr.arguments.length === 3) {
        this._compileArrayReduce(expr.arguments[0], expr.arguments[1], expr.arguments[2], body);
        return;
      }
      const funcInfo = this.functions.get(funcName);
      if (funcInfo) {
        for (const arg of expr.arguments) {
          this._compileExpr(arg, body);
        }
        body.push(WasmOp.call, ...encodeULEB128(funcInfo.index));
      } else {
        for (const arg of expr.arguments) {
          this._compileExpr(arg, body);
        }
        this._compileExpr(expr.function, body);
        const paramCount = expr.arguments.length;
        const typeIdx = this.module.addType(
          new Array(paramCount).fill(this.numType),
          [this.numType]
        );
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        body.push(WasmOp.call_indirect, ...encodeULEB128(typeIdx), 0);
      }
      return;
    }
    if (expr instanceof IfExpression) {
      this._compileExpr(expr.condition, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      if (this.useF64) {
        this._emitF64Const(body, 0);
        body.push(WasmOp.f64_ne);
      }
      body.push(WasmOp.if_, this.numType);
      if (expr.consequence) {
        const stmts = expr.consequence.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, i === stmts.length - 1);
        }
      } else {
        this._emitConst(body, 0);
      }
      body.push(WasmOp.else_);
      if (expr.alternative) {
        if (expr.alternative instanceof BlockStatement) {
          const stmts = expr.alternative.statements;
          for (let i = 0; i < stmts.length; i++) {
            this._compileStatement(stmts[i], body, i === stmts.length - 1);
          }
        } else {
          this._compileExpr(expr.alternative, body);
        }
      } else {
        this._emitConst(body, 0);
      }
      body.push(WasmOp.end);
      return;
    }
    if (expr instanceof FunctionLiteral) {
      const anonKey = this._anonMap.get(expr);
      if (anonKey) {
        const info = this.functions.get(anonKey);
        this._emitConst(body, info.tableIdx);
      } else {
        throw new Error("Anonymous function not pre-registered (should not happen)");
      }
      return;
    }
    if (expr instanceof WhileExpression) {
      this._compileWhile(expr.condition, expr.body, body);
      this._emitConst(body, 0);
      return;
    }
    if (expr instanceof DoWhileExpression) {
      body.push(WasmOp.loop, 64);
      if (expr.body) {
        const stmts = expr.body.statements;
        for (let i = 0; i < stmts.length; i++) {
          this._compileStatement(stmts[i], body, false);
        }
      }
      this._compileExpr(expr.condition, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      if (this.useF64) {
        this._emitF64Const(body, 0);
        body.push(WasmOp.f64_ne);
      }
      body.push(WasmOp.br_if, 0);
      body.push(WasmOp.end);
      this._emitConst(body, 0);
      return;
    }
    if (expr instanceof ForExpression) {
      if (expr.init) {
        this._compileStatement(expr.init, body, false);
      }
      const augmentedStmts = expr.body ? [...expr.body.statements] : [];
      if (expr.update) {
        if (expr.update instanceof SetStatement) {
          augmentedStmts.push(expr.update);
        } else {
          augmentedStmts.push(new ExpressionStatement(
            { type: "IDENT", literal: "" },
            expr.update
          ));
        }
      }
      this._compileWhile(expr.condition, { statements: augmentedStmts }, body);
      this._emitConst(body, 0);
      return;
    }
    if (expr instanceof ArrayLiteral) {
      const len = expr.elements.length;
      const cap = Math.max(len, 4);
      const headerSize = 8;
      const totalSize = headerSize + cap * 4;
      const allocIdx = this._getAllocFunc();
      body.push(WasmOp.i32_const, ...encodeSLEB128(totalSize));
      body.push(WasmOp.call, ...encodeULEB128(allocIdx));
      const ptrLocal = this.currentLocalCount + this.currentExtraLocals;
      this.currentExtraLocals++;
      body.push(WasmOp.local_set, ...encodeULEB128(ptrLocal));
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(len));
      body.push(WasmOp.i32_store, 2, 0);
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      body.push(WasmOp.i32_const, ...encodeSLEB128(cap));
      body.push(WasmOp.i32_store, 2, 4);
      for (let i = 0; i < len; i++) {
        body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
        this._compileExpr(expr.elements[i], body);
        if (this.useI64) body.push(WasmOp.i32_wrap_i64);
        if (this.useF64) {
        }
        body.push(WasmOp.i32_store, 2, ...encodeULEB128(8 + i * 4));
      }
      body.push(WasmOp.local_get, ...encodeULEB128(ptrLocal));
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }
    if (expr instanceof IndexExpression) {
      this._compileExpr(expr.left, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.i32_const, 8);
      body.push(WasmOp.i32_add);
      this._compileExpr(expr.index, body);
      if (this.useI64) body.push(WasmOp.i32_wrap_i64);
      body.push(WasmOp.i32_const, 4);
      body.push(WasmOp.i32_mul);
      body.push(WasmOp.i32_add);
      body.push(WasmOp.i32_load, 2, 0);
      if (this.useI64) body.push(WasmOp.i64_extend_i32_s);
      return;
    }
    throw new Error(`Unsupported expression in WASM compilation: ${expr.constructor.name}`);
  }
};
export {
  compileToWasm
};
