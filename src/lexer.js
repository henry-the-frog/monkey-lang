// Monkey Language Lexer
// Tokenizes source code into a stream of tokens

export const TokenType = {
  // Literals
  INT: 'INT',
  FLOAT: 'FLOAT',
  STRING: 'STRING',
  FSTRING: 'FSTRING',
  IDENT: 'IDENT',
  NULL: 'NULL',
  
  // Multi-char operators
  PIPE: '|>',
  ARROW: '=>',
  THIN_ARROW: '->',
  SPREAD: '...',
  DOT: '.',
  DOTDOT: '..',

  // Operators
  ASSIGN: '=',
  PLUS_ASSIGN: '+=',
  MINUS_ASSIGN: '-=',
  ASTERISK_ASSIGN: '*=',
  POWER: '**',
  SLASH_ASSIGN: '/=',
  PLUS: '+',
  MINUS: '-',
  BANG: '!',
  ASTERISK: '*',
  SLASH: '/',
  PERCENT: '%',
  LT: '<',
  GT: '>',
  LTE: '<=',
  GTE: '>=',
  AND: '&&',
  OR: '||',
  EQ: '==',
  NOT_EQ: '!=',

  // Delimiters
  COMMA: ',',
  SEMICOLON: ';',
  COLON: ':',
  QUESTION: '?',
  NULLISH: '??',
  LPAREN: '(',
  RPAREN: ')',
  LBRACE: '{',
  RBRACE: '}',
  LBRACKET: '[',
  RBRACKET: ']',

  // Keywords
  FUNCTION: 'FUNCTION',
  LET: 'LET',
  CONST: 'CONST',
  SET: 'SET',
  FOR: 'FOR',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  IF: 'IF',
  ELSE: 'ELSE',
  RETURN: 'RETURN',
  WHILE: 'WHILE',
  DO: 'DO',
  BREAK: 'BREAK',
  CONTINUE: 'CONTINUE',
  SWITCH: 'SWITCH',
  CASE: 'CASE',
  DEFAULT: 'DEFAULT',
  TRY: 'TRY',
  CATCH: 'CATCH',
  THROW: 'THROW',
  IN: 'IN',
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  AS: 'AS',
  CLASS: 'CLASS',
  EXTENDS: 'EXTENDS',
  SUPER: 'SUPER',

  // Special
  EOF: 'EOF',
  ILLEGAL: 'ILLEGAL',
};

const KEYWORDS = {
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
  enum: 'ENUM',
  match: 'MATCH',
  in: TokenType.IN,
  class: TokenType.CLASS,
  extends: TokenType.EXTENDS,
  super: TokenType.SUPER,
};

export class Token {
  constructor(type, literal) {
    this.type = type;
    this.literal = literal;
  }
}

export class Lexer {
  constructor(input) {
    this.input = input;
    this.position = 0;     // current position (points to current char)
    this.readPosition = 0; // next position (after current char)
    this.ch = null;        // current char
    this.readChar();
  }

  readChar() {
    this.ch = this.readPosition >= this.input.length
      ? null
      : this.input[this.readPosition];
    this.position = this.readPosition;
    this.readPosition++;
  }

  peekChar() {
    return this.readPosition >= this.input.length
      ? null
      : this.input[this.readPosition];
  }

  skipWhitespace() {
    while (true) {
      // Skip whitespace
      while (this.ch === ' ' || this.ch === '\t' || this.ch === '\n' || this.ch === '\r') {
        this.readChar();
      }
      // Skip line comments: // ...
      if (this.ch === '/' && this.peekChar() === '/') {
        this.readChar(); // consume first /
        this.readChar(); // consume second /
        while (this.ch && this.ch !== '\n') {
          this.readChar();
        }
        continue; // Check for more whitespace/comments
      }
      // Skip block comments: /* ... */
      if (this.ch === '/' && this.peekChar() === '*') {
        this.readChar(); // consume /
        this.readChar(); // consume *
        while (this.ch) {
          if (this.ch === '*' && this.peekChar() === '/') {
            this.readChar(); // consume *
            this.readChar(); // consume /
            break;
          }
          this.readChar();
        }
        continue; // Check for more whitespace/comments
      }
      break; // No more whitespace or comments
    }
  }

  readIdentifier() {
    const start = this.position;
    while (this.ch && (isLetter(this.ch) || this.ch === '_' || (this.position > start && isDigit(this.ch)))) {
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
    // Check for decimal point
    if (this.ch === '.' && isDigit(this.peekChar())) {
      isFloat = true;
      this.readChar(); // consume '.'
      while (this.ch && isDigit(this.ch)) {
        this.readChar();
      }
    }
    // Check for scientific notation (e.g., 1e10, 1.5e-3)
    if (this.ch === 'e' || this.ch === 'E') {
      isFloat = true;
      this.readChar(); // consume 'e'/'E'
      if (this.ch === '+' || this.ch === '-') {
        this.readChar(); // consume sign
      }
      while (this.ch && isDigit(this.ch)) {
        this.readChar();
      }
    }
    return { value: this.input.slice(start, this.position), isFloat };
  }

  readTripleQuoteString() {
    // Skip opening """
    this.readChar(); this.readChar(); this.readChar();
    let result = '';
    while (this.ch !== null) {
      if (this.ch === '"' && this.peekChar() === '"' && this.input[this.position + 2] === '"') {
        // Skip closing """
        this.readChar(); this.readChar(); this.readChar();
        return result;
      }
      result += this.ch;
      this.readChar();
    }
    return result;
  }

  readString() {
    this.readChar(); // skip opening quote
    let result = '';
    while (this.ch !== null && this.ch !== '"') {
      if (this.ch === '\\') {
        this.readChar();
        switch (this.ch) {
          case 'n': result += '\n'; break;
          case 't': result += '\t'; break;
          case 'r': result += '\r'; break;
          case '\\': result += '\\'; break;
          case '"': result += '"'; break;
          default: result += '\\' + this.ch; break;
        }
      } else {
        result += this.ch;
      }
      this.readChar();
    }
    this.readChar(); // skip closing quote
    return result;
  }

  nextToken() {
    this.skipWhitespace();

    let tok;
    switch (this.ch) {
      case '=':
        if (this.peekChar() === '=') {
          this.readChar();
          tok = new Token(TokenType.EQ, '==');
        } else if (this.peekChar() === '>') {
          this.readChar();
          tok = new Token(TokenType.ARROW, '=>');
        } else {
          tok = new Token(TokenType.ASSIGN, '=');
        }
        break;
      case '+':
        if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.PLUS_ASSIGN, '+='); }
        else if (this.peekChar() === '+') { this.readChar(); tok = new Token('++', '++'); }
        else { tok = new Token(TokenType.PLUS, '+'); }
        break;
      case '-':
        if (this.peekChar() === '>') { this.readChar(); tok = new Token(TokenType.THIN_ARROW, '->'); }
        else if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.MINUS_ASSIGN, '-='); }
        else if (this.peekChar() === '-') { this.readChar(); tok = new Token('--', '--'); }
        else { tok = new Token(TokenType.MINUS, '-'); }
        break;
      case '!':
        if (this.peekChar() === '=') {
          this.readChar();
          tok = new Token(TokenType.NOT_EQ, '!=');
        } else {
          tok = new Token(TokenType.BANG, '!');
        }
        break;
      case '*':
        if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.ASTERISK_ASSIGN, '*='); }
        else if (this.peekChar() === '*') { this.readChar(); tok = new Token(TokenType.POWER, '**'); }
        else { tok = new Token(TokenType.ASTERISK, '*'); }
        break;
      case '/':
        if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.SLASH_ASSIGN, '/='); }
        else { tok = new Token(TokenType.SLASH, '/'); }
        break;
      case '%': tok = new Token(TokenType.PERCENT, '%'); break;
      case '&':
        if (this.peekChar() === '&') { this.readChar(); tok = new Token(TokenType.AND, '&&'); }
        else { tok = new Token(TokenType.ILLEGAL, ch); }
        break;
      case '|':
        if (this.peekChar() === '|') { this.readChar(); tok = new Token(TokenType.OR, '||'); }
        else if (this.peekChar() === '>') { this.readChar(); tok = new Token(TokenType.PIPE, '|>'); }
        else { tok = new Token(TokenType.ILLEGAL, ch); }
        break;
      case '<':
        if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.LTE, '<='); }
        else { tok = new Token(TokenType.LT, '<'); }
        break;
      case '>':
        if (this.peekChar() === '=') { this.readChar(); tok = new Token(TokenType.GTE, '>='); }
        else { tok = new Token(TokenType.GT, '>'); }
        break;
      case ',': tok = new Token(TokenType.COMMA, ','); break;
      case ';': tok = new Token(TokenType.SEMICOLON, ';'); break;
      case ':': tok = new Token(TokenType.COLON, ':'); break;
      case '?':
        if (this.peekChar() === '?') { this.readChar(); tok = new Token(TokenType.NULLISH, '??'); }
        else if (this.peekChar() === '.') { this.readChar(); tok = new Token('?.', '?.'); }
        else { tok = new Token(TokenType.QUESTION, '?'); }
        break;
      case '(': tok = new Token(TokenType.LPAREN, '('); break;
      case ')': tok = new Token(TokenType.RPAREN, ')'); break;
      case '{': tok = new Token(TokenType.LBRACE, '{'); break;
      case '}': tok = new Token(TokenType.RBRACE, '}'); break;
      case '[': tok = new Token(TokenType.LBRACKET, '['); break;
      case ']': tok = new Token(TokenType.RBRACKET, ']'); break;
      case '"':
        if (this.peekChar() === '"' && this.input[this.position + 2] === '"') {
          return new Token(TokenType.STRING, this.readTripleQuoteString());
        }
        return new Token(TokenType.STRING, this.readString());
      case '`': {
        // Template literal: `text ${expr} text` — same as f"text {expr} text"
        this.readChar(); // consume `
        const start = this.position;
        while (this.ch && this.ch !== '`') {
          if (this.ch === '\\') this.readChar();
          this.readChar();
        }
        let str = this.input.slice(start, this.position);
        this.readChar(); // consume closing `
        // Convert ${...} syntax to {...} for f-string compatibility
        str = str.replace(/\$\{/g, '{');
        return new Token(TokenType.FSTRING, str);
      }
      case null:
        return new Token(TokenType.EOF, '');
      case '.':
        if (this.peekChar() === '.' && this.input[this.readPosition + 1] === '.') {
          this.readChar(); this.readChar();
          tok = new Token(TokenType.SPREAD, '...');
        } else if (this.peekChar() === '.') {
          this.readChar();
          tok = new Token(TokenType.DOTDOT, '..');
        } else {
          tok = new Token(TokenType.DOT, '.');
        }
        break;
      default:
        if (isLetter(this.ch)) {
          // Check for f-string: f"..."
          if (this.ch === 'f' && this.peekChar() === '"') {
            this.readChar(); // consume 'f'
            this.readChar(); // consume '"'
            const start = this.position;
            while (this.ch && this.ch !== '"') {
              if (this.ch === '\\') this.readChar();
              this.readChar();
            }
            const str = this.input.slice(start, this.position);
            this.readChar(); // consume closing "
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
}

function isLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
