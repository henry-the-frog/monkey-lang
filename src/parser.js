// Monkey Language Parser — Pratt (Top-Down Operator Precedence)

import { TokenType } from './lexer.js';
import { Lexer } from './lexer.js';
import * as ast from './ast.js';

const Precedence = {
  LOWEST: 1,
  PIPE: 2,         // |>
  TERNARY: 3,      // ?:
  LOGICAL_OR: 4,   // ||
  LOGICAL_AND: 5,  // &&
  EQUALS: 5,       // ==
  LESSGREATER: 6,   // > or <
  RANGE: 7,        // ..
  SUM: 8,          // +
  PRODUCT: 9,      // *
  POWER: 10,       // **
  PREFIX: 10,      // -X or !X
  CALL: 11,        // myFunction(X)
  INDEX: 12,       // array[index]
};

const TOKEN_PRECEDENCE = {
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
  ['++']:  Precedence.CALL,
  ['--']:  Precedence.CALL,
  ['?.']:  Precedence.CALL,
  [TokenType.LPAREN]: Precedence.CALL,
  [TokenType.DOT]: Precedence.CALL,
  [TokenType.LBRACKET]: Precedence.INDEX,
};

export class Parser {
  constructor(lexer) {
    this.lexer = lexer;
    this.errors = [];
    this.curToken = null;
    this.peekToken = null;

    this.prefixParseFns = {};
    this.infixParseFns = {};

    // Register prefix parsers
    this.registerPrefix(TokenType.IDENT, () => this.parseIdentifier());
    // import as both keyword (import "module") and function (import("module"))
    this.registerPrefix(TokenType.IMPORT, () => this.parseIdentifier());
    this.registerPrefix(TokenType.INT, () => this.parseIntegerLiteral());
    this.registerPrefix(TokenType.FLOAT, () => this.parseFloatLiteral());
    this.registerPrefix(TokenType.STRING, () => this.parseStringLiteral());
    this.registerPrefix(TokenType.FSTRING, () => this.parseFStringLiteral());
    this.registerPrefix(TokenType.FSTRING, () => this.parseFString());
    this.registerPrefix(TokenType.TRUE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.FALSE, () => this.parseBooleanLiteral());
    this.registerPrefix(TokenType.NULL, () => new ast.NullLiteral(this.curToken));
    this.registerPrefix('MATCH', () => this.parseMatchExpression());
    this.registerPrefix(TokenType.BANG, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.MINUS, () => this.parsePrefixExpression());
    this.registerPrefix(TokenType.SPREAD, () => this.parseSpreadExpression());
    this.registerPrefix(TokenType.LPAREN, () => this.parseGroupedExpression());
    this.registerPrefix(TokenType.IF, () => this.parseIfExpression());
    this.registerPrefix(TokenType.WHILE, () => this.parseWhileExpression());
    this.registerPrefix(TokenType.DO, () => this.parseDoWhileExpression());
    this.registerPrefix(TokenType.BREAK, () => new ast.BreakStatement(this.curToken));
    this.registerPrefix(TokenType.CONTINUE, () => new ast.ContinueStatement(this.curToken));
    this.registerPrefix(TokenType.SWITCH, () => this.parseSwitchExpression());
    this.registerPrefix(TokenType.TRY, () => this.parseTryCatchExpression());
    this.registerPrefix(TokenType.THROW, () => {
      const token = this.curToken;
      this.nextToken();
      return new ast.ThrowExpression(token, this.parseExpression(Precedence.LOWEST));
    });
    this.registerPrefix(TokenType.FOR, () => this.parseForExpression());
    this.registerPrefix(TokenType.FUNCTION, () => this.parseFunctionLiteral());
    this.registerPrefix(TokenType.LBRACKET, () => this.parseArrayLiteral());
    this.registerPrefix(TokenType.LBRACE, () => this.parseHashLiteral());

    // Register infix parsers
    for (const op of [TokenType.PLUS, TokenType.MINUS, TokenType.SLASH, TokenType.PERCENT,
      TokenType.ASTERISK, TokenType.EQ, TokenType.NOT_EQ,
      TokenType.LT, TokenType.GT, TokenType.LTE, TokenType.GTE,
      TokenType.AND, TokenType.OR, TokenType.NULLISH, TokenType.DOTDOT, TokenType.POWER]) {
      this.registerInfix(op, (left) => this.parseInfixExpression(left));
    }
    
    // Pipe operator: left |> fn  →  fn(left)
    this.registerInfix(TokenType.PIPE, (left) => this.parsePipeExpression(left));
    this.registerInfix('++', (left) => this.parsePostfixExpression(left, '+'));
    this.registerInfix('--', (left) => this.parsePostfixExpression(left, '-'));
    this.registerInfix('?.', (left) => this.parseOptionalChainExpression(left));
    // Arrow function: x => expr — only valid when left is a plain identifier
    // NOT registered as infix because it conflicts with match expression (1 => "one")
    // Instead, handled via parseExpressionStatement looking ahead
    
    // Method call: obj.method(args)  →  method(obj, args)
    this.registerInfix(TokenType.DOT, (left) => this.parseMethodCall(left));
    
    // Ternary operator
    this.registerInfix(TokenType.QUESTION, (condition) => {
      const token = this.curToken;
      this.nextToken();
      const consequence = this.parseExpression(Precedence.TERNARY);
      if (!this.expectPeek(TokenType.COLON)) return null;
      this.nextToken();
      const alternative = this.parseExpression(Precedence.TERNARY);
      return new ast.TernaryExpression(token, condition, consequence, alternative);
    });
    this.registerInfix(TokenType.LPAREN, (left) => this.parseCallExpression(left));
    this.registerInfix(TokenType.LBRACKET, (left) => this.parseIndexExpression(left));

    // Prime the pump
    this.nextToken();
    this.nextToken();
  }

  registerPrefix(type, fn) { this.prefixParseFns[type] = fn; }
  registerInfix(type, fn) { this.infixParseFns[type] = fn; }

  nextToken() {
    this.curToken = this.peekToken;
    this.peekToken = this.lexer.nextToken();
  }

  curTokenIs(t) { return this.curToken.type === t; }
  peekTokenIs(t) { return this.peekToken.type === t; }

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

  peekPrecedence() { return TOKEN_PRECEDENCE[this.peekToken.type] || Precedence.LOWEST; }
  curPrecedence() { return TOKEN_PRECEDENCE[this.curToken.type] || Precedence.LOWEST; }

  // --- Entry point ---

  parseProgram() {
    const program = new ast.Program();
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
      case TokenType.LET: return this.parseLetStatement();
      case TokenType.CONST: return this.parseConstStatement();
      case TokenType.SET: return this.parseSetStatement();
      case TokenType.RETURN: return this.parseReturnStatement();
      case TokenType.IMPORT: {
        // If next token is '(', treat as function call: import("module")
        if (this.peekTokenIs(TokenType.LPAREN)) {
          return this.parseExpressionStatement();
        }
        return this.parseImportStatement();
      }
      case TokenType.EXPORT: return this.parseExportStatement();
      case 'ENUM': return this.parseEnumStatement();
      default: return this.parseExpressionStatement();
    }
  }

  parseConstStatement() {
    const token = this.curToken;
    
    // Reuse let destructuring with isConst flag
    // Array destructuring: const [a, b, c] = expr
    if (this.peekTokenIs(TokenType.LBRACKET)) {
      this.nextToken(); // consume [
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACKET)) {
        this.nextToken();
        names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new ast.DestructureLetStatement(token, names, value, true);
    }
    
    // Hash destructuring: const {a, b} = expr
    if (this.peekTokenIs(TokenType.LBRACE)) {
      this.nextToken();
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACE)) {
        this.nextToken();
        names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken();
          this.nextToken();
          names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACE)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new ast.DestructureHashLetStatement(token, names, value, true);
    }
    
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new ast.Identifier(this.curToken, this.curToken.literal);
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.LetStatement(token, name, value);
  }

  parseLetStatement() {
    const token = this.curToken;
    
    // Array destructuring: let [a, b, c] = expr
    if (this.peekTokenIs(TokenType.LBRACKET)) {
      this.nextToken(); // consume [
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACKET)) {
        this.nextToken(); // first ident
        names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken(); // comma
          this.nextToken(); // next ident
          names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new ast.DestructureLetStatement(token, names, value, token.type === 'CONST');
    }
    
    // Hash destructuring: let {a, b} = expr  
    if (this.peekTokenIs(TokenType.LBRACE)) {
      this.nextToken(); // consume {
      const names = [];
      if (!this.curTokenIs(TokenType.RBRACE)) {
        this.nextToken(); // first ident
        names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        while (this.peekTokenIs(TokenType.COMMA)) {
          this.nextToken(); // comma
          this.nextToken(); // next ident
          names.push(new ast.Identifier(this.curToken, this.curToken.literal));
        }
      }
      if (!this.expectPeek(TokenType.RBRACE)) return null;
      if (!this.expectPeek(TokenType.ASSIGN)) return null;
      this.nextToken();
      const value = this.parseExpression(Precedence.LOWEST);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new ast.DestructureHashLetStatement(token, names, value, token.type === 'CONST');
    }
    
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new ast.Identifier(this.curToken, this.curToken.literal);
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.LetStatement(token, name, value);
  }

  parseSetStatement() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.IDENT)) return null;
    const name = new ast.Identifier(this.curToken, this.curToken.literal);
    
    // Handle compound assignment: +=, -=, *=, /=
    let op = null;
    if (this.peekTokenIs(TokenType.PLUS_ASSIGN)) { op = '+'; }
    else if (this.peekTokenIs(TokenType.MINUS_ASSIGN)) { op = '-'; }
    else if (this.peekTokenIs(TokenType.ASTERISK_ASSIGN)) { op = '*'; }
    else if (this.peekTokenIs(TokenType.SLASH_ASSIGN)) { op = '/'; }
    
    if (op) {
      this.nextToken(); // consume +=/-=/etc
      this.nextToken();
      const right = this.parseExpression(Precedence.LOWEST);
      // Desugar: set x += 5 → set x = x + 5
      const value = new ast.InfixExpression(this.curToken, name, op, right);
      if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
      return new ast.SetStatement(token, name, value);
    }
    
    if (!this.expectPeek(TokenType.ASSIGN)) return null;
    this.nextToken();
    const value = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.SetStatement(token, name, value);
  }

  parseReturnStatement() {
    const token = this.curToken;
    this.nextToken();
    const returnValue = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.ReturnStatement(token, returnValue);
  }

  // import "module" for func1, func2;
  // import "module" as alias;
  // import "module";
  parseImportStatement() {
    const token = this.curToken;
    this.nextToken(); // consume 'import'
    
    // Module name (string literal)
    if (this.curToken.type !== TokenType.STRING) {
      this.errors.push(`expected module name string after import, got ${this.curToken.type}`);
      return null;
    }
    const moduleName = this.curToken.literal;
    
    let bindings = null;
    let alias = null;
    
    // Check for { selective } or 'as' (alias import)
    this.nextToken(); // advance past module name
    if (this.curTokenIs(TokenType.LBRACE)) {
      // import "module" { func1, func2 };
      this.nextToken(); // consume {
      bindings = [];
      bindings.push(this.curToken.literal);
      while (this.peekTokenIs(TokenType.COMMA)) {
        this.nextToken(); // consume comma
        this.nextToken(); // consume binding name
        bindings.push(this.curToken.literal);
      }
      if (this.peekTokenIs(TokenType.RBRACE)) this.nextToken(); // consume }
    } else if (this.curTokenIs(TokenType.AS)) {
      this.nextToken(); // consume 'as'
      alias = this.curToken.literal;
    }
    
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.ImportStatement(token, moduleName, bindings, alias);
  }

  // export let x = ...;
  // export fn name(...) { ... };
  parseExportStatement() {
    const token = this.curToken;
    this.nextToken(); // consume 'export'
    
    // Parse the inner statement (let, const, fn)
    const innerStmt = this.parseStatement();
    
    // Mark it as exported
    if (innerStmt) {
      innerStmt._exported = true;
    }
    
    return innerStmt;
  }

  parseExpressionStatement() {
    const token = this.curToken;
    const expression = this.parseExpression(Precedence.LOWEST);
    if (this.peekTokenIs(TokenType.SEMICOLON)) this.nextToken();
    return new ast.ExpressionStatement(token, expression);
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
    return new ast.BlockStatement(token, statements);
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
    // Check for arrow function: x => expr
    if (this.peekTokenIs(TokenType.ARROW)) {
      const ident = new ast.Identifier(this.curToken, this.curToken.literal);
      this.nextToken(); // consume =>
      this.nextToken(); // move to body
      let body;
      if (this.curTokenIs(TokenType.LBRACE)) {
        body = this.parseBlockStatement();
      } else {
        const expr = this.parseExpression(Precedence.LOWEST);
        const returnStmt = new ast.ReturnStatement(this.curToken, expr);
        body = new ast.BlockStatement(this.curToken, [returnStmt]);
      }
      return new ast.FunctionLiteral(this.curToken, [ident], body);
    }
    return new ast.Identifier(this.curToken, this.curToken.literal);
  }

  parseIntegerLiteral() {
    const value = parseInt(this.curToken.literal, 10);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as integer`);
      return null;
    }
    return new ast.IntegerLiteral(this.curToken, value);
  }

  parseFloatLiteral() {
    const value = parseFloat(this.curToken.literal);
    if (isNaN(value)) {
      this.errors.push(`could not parse ${this.curToken.literal} as float`);
      return null;
    }
    return new ast.FloatLiteral(this.curToken, value);
  }

  parseStringLiteral() {
    return new ast.StringLiteral(this.curToken, this.curToken.literal);
  }

  parseFStringLiteral() {
    const token = this.curToken;
    const raw = token.literal;
    const segments = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === '{') {
        let depth = 1;
        let j = i + 1;
        while (j < raw.length && depth > 0) {
          if (raw[j] === '{') depth++;
          if (raw[j] === '}') depth--;
          j++;
        }
        const exprStr = raw.slice(i + 1, j - 1);
        const l = new Lexer(exprStr);
        const p = new Parser(l);
        const expr = p.parseExpression(Precedence.LOWEST);
        segments.push({ type: 'expr', expr });
        i = j;
      } else {
        let j = i;
        while (j < raw.length && raw[j] !== '{') j++;
        segments.push({ type: 'text', value: raw.slice(i, j) });
        i = j;
      }
    }
    return new ast.FStringExpression(token, segments);
  }

  parseFString() {
    const token = this.curToken;
    const raw = token.literal;
    const segments = [];
    let i = 0;
    let text = '';
    while (i < raw.length) {
      if (raw[i] === '{' && raw[i+1] !== '{') {
        if (text) { segments.push({type: 'text', value: text}); text = ''; }
        let depth = 1; let exprStr = ''; i++;
        while (i < raw.length && depth > 0) {
          if (raw[i] === '{') depth++;
          else if (raw[i] === '}') { depth--; if (depth === 0) break; }
          exprStr += raw[i]; i++;
        }
        i++; // skip closing }
        // Parse the expression string
        const subLexer = new Lexer(exprStr);
        const subParser = new Parser(subLexer);
        segments.push({type: 'expr', expr: subParser.parseExpression(Precedence.LOWEST)});
      } else if (raw[i] === '{' && raw[i+1] === '{') {
        text += '{'; i += 2; // escaped {
      } else if (raw[i] === '}' && raw[i+1] === '}') {
        text += '}'; i += 2; // escaped }
      } else {
        text += raw[i]; i++;
      }
    }
    if (text) segments.push({type: 'text', value: text});
    return new ast.FStringExpression(token, segments);
  }

  parseBooleanLiteral() {
    return new ast.BooleanLiteral(this.curToken, this.curTokenIs(TokenType.TRUE));
  }

  parsePrefixExpression() {
    const token = this.curToken;
    const operator = this.curToken.literal;
    this.nextToken();
    const right = this.parseExpression(Precedence.PREFIX);
    return new ast.PrefixExpression(token, operator, right);
  }

  parseSpreadExpression() {
    const token = this.curToken;
    this.nextToken();
    const value = this.parseExpression(Precedence.PREFIX);
    return new ast.SpreadExpression(token, value);
  }

  parseMatchExpression() {
    const token = this.curToken;
    this.nextToken();
    const subject = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    
    const arms = [];
    while (!this.peekTokenIs(TokenType.RBRACE) && !this.peekTokenIs(TokenType.EOF)) {
      this.nextToken();
      
      // Default arm: _ => expr
      if (this.curToken.literal === '_') {
        if (!this.expectPeek(TokenType.ARROW)) return null;
        this.nextToken();
        const body = this.parseExpression(Precedence.LOWEST);
        arms.push({ pattern: null, body }); // null pattern = default
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
    return new ast.MatchExpression(token, subject, arms);
  }

  parseInfixExpression(left) {
    const token = this.curToken;
    const operator = this.curToken.literal;
    const precedence = this.curPrecedence();
    this.nextToken();
    const right = this.parseExpression(precedence);
    return new ast.InfixExpression(token, left, operator, right);
  }

  parsePipeExpression(left) {
    const token = this.curToken;
    const precedence = this.curPrecedence();
    this.nextToken();
    const right = this.parseExpression(precedence);
    // Transform: left |> fn  →  CallExpression(fn, [left])
    return new ast.CallExpression(token, right, [left]);
  }

  parseMethodCall(left) {
    // obj.method(args) → method(obj, args) for function calls
    // obj.prop → IndexExpression(obj, "prop") for property access
    const token = this.curToken; // DOT
    this.nextToken(); // method/property name
    const name = this.curToken.literal;
    
    if (this.peekTokenIs(TokenType.LPAREN)) {
      // obj.method(args) → method(obj, arg1, arg2, ...)
      const methodName = new ast.Identifier(this.curToken, name);
      this.nextToken(); // consume (
      const args = this.parseExpressionList(TokenType.RPAREN);
      return new ast.CallExpression(token, methodName, [left, ...args]);
    }
    
    // obj.prop → IndexExpression(obj, "prop") — property/hash access
    const key = new ast.StringLiteral(this.curToken, name);
    return new ast.IndexExpression(token, left, key);
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
    return new ast.IfExpression(token, condition, consequence, alternative);
  }

  parseWhileExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);
    if (!this.expectPeek(TokenType.RPAREN)) return null;
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    return new ast.WhileExpression(token, condition, body);
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
    return new ast.DoWhileExpression(token, body, condition);
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
    return new ast.TryCatchExpression(token, tryBody, errorIdent, catchBody);
  }

  parseArrowExpression(left) {
    // x => expr — left must be identifier
    if (!(left instanceof ast.Identifier)) {
      this.errors.push(`expected identifier before '=>', got ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const params = [left];
    this.nextToken(); // move to body
    let body;
    if (this.curTokenIs(TokenType.LBRACE)) {
      body = this.parseBlockStatement();
    } else {
      const expr = this.parseExpression(Precedence.LOWEST);
      const returnStmt = new ast.ReturnStatement(token, expr);
      body = new ast.BlockStatement(token, [returnStmt]);
    }
    return new ast.FunctionLiteral(token, params, body);
  }

  parseOptionalChainExpression(left) {
    const token = this.curToken;
    if (this.peekToken.type === TokenType.LBRACKET) {
      this.nextToken(); // consume [
      this.nextToken();
      const index = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ast.OptionalChainExpression(token, left, index);
    } else if (this.peekToken.type === TokenType.IDENT) {
      this.nextToken();
      const key = new ast.StringLiteral(this.curToken, this.curToken.literal);
      return new ast.OptionalChainExpression(token, left, key);
    } else {
      this.errors.push(`expected [ or identifier after ?., got ${this.peekToken.type}`);
      return left;
    }
  }

  parsePostfixExpression(left, op) {
    // x++ desugars to set x = x + 1, x-- desugars to set x = x - 1
    if (!(left instanceof ast.Identifier)) {
      this.errors.push(`cannot use ${op}${op} on ${left.constructor.name}`);
      return null;
    }
    const token = this.curToken;
    const one = new ast.IntegerLiteral(token, 1);
    const binExpr = new ast.InfixExpression(token, left, op, one);
    return new ast.SetStatement(token, new ast.Identifier(token, left.value), binExpr);
  }

  parseEnumStatement() {
    const token = this.curToken; // 'enum'
    this.nextToken(); // expect name
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
    return new ast.EnumStatement(token, name, variants);
  }

  parseSwitchExpression() {
    const token = this.curToken;
    let value = null;
    
    // Optional value: switch (expr) { ... } or switch { ... } (condition form)
    if (this.peekTokenIs(TokenType.LPAREN)) {
      this.nextToken(); // consume (
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
    return new ast.SwitchExpression(token, value, cases, defaultCase);
  }

  parseForExpression() {
    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;

    // Check for for-in: for (ident in iterable)
    this.nextToken();
    if (this.curTokenIs(TokenType.IDENT) && this.peekTokenIs(TokenType.IN)) {
      const ident = this.curToken.literal;
      this.nextToken(); // consume IN
      this.nextToken();
      const iterable = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RPAREN)) return null;
      if (!this.expectPeek(TokenType.LBRACE)) return null;
      const body = this.parseBlockStatement();
      return new ast.ForInExpression(token, ident, iterable, body);
    }

    // Regular for: for (let i = 0; i < 10; set i = i + 1)
    let init;
    if (this.curTokenIs(TokenType.LET)) {
      init = this.parseLetStatement();
    } else if (this.curTokenIs(TokenType.SET)) {
      init = this.parseSetStatement();
    } else {
      this.errors.push(`expected LET or SET in for init, got ${this.curToken.type}`);
      return null;
    }

    // Parse condition
    this.nextToken();
    const condition = this.parseExpression(Precedence.LOWEST);

    // Expect semicolon after condition
    if (!this.expectPeek(TokenType.SEMICOLON)) return null;

    // Parse update: set x = x + 1
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
    return new ast.ForExpression(token, init, condition, update, body);
  }

  parseFunctionLiteral() {    const token = this.curToken;
    if (!this.expectPeek(TokenType.LPAREN)) return null;
    const { params: parameters, defaults, restParam, paramTypes } = this.parseFunctionParameters();
    
    // Check for return type annotation: -> type
    let returnType = null;
    if (this.peekTokenIs(TokenType.THIN_ARROW)) {
      this.nextToken(); // consume ->
      this.nextToken(); // move to type name
      returnType = this.curToken.literal;
    }
    
    // Arrow function: fn(x) => expr
    if (this.peekTokenIs(TokenType.ARROW)) {
      this.nextToken(); // consume =>
      this.nextToken(); // move to expression
      const expr = this.parseExpression(Precedence.LOWEST);
      const returnStmt = new ast.ReturnStatement(token, expr);
      const body = new ast.BlockStatement(token, [returnStmt]);
      const fn = new ast.FunctionLiteral(token, parameters, body);
      fn.restParam = restParam;
      fn.defaults = defaults;
      fn.paramTypes = paramTypes.length ? paramTypes : null;
      fn.returnType = returnType;
      return fn;
    }
    
    if (!this.expectPeek(TokenType.LBRACE)) return null;
    const body = this.parseBlockStatement();
    const fn = new ast.FunctionLiteral(token, parameters, body);
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
      restParam = new ast.Identifier(this.curToken, this.curToken.literal);
    } else {
      params.push(new ast.Identifier(this.curToken, this.curToken.literal));
      // Type annotation: param: type
      if (this.peekTokenIs(TokenType.COLON)) {
        this.nextToken(); // consume :
        this.nextToken(); // move to type name
        paramTypes.push(this.curToken.literal);
      } else {
        paramTypes.push(null);
      }
      if (this.peekTokenIs(TokenType.ASSIGN)) {
        this.nextToken(); // =
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
        restParam = new ast.Identifier(this.curToken, this.curToken.literal);
      } else {
        params.push(new ast.Identifier(this.curToken, this.curToken.literal));
        // Type annotation: param: type
        if (this.peekTokenIs(TokenType.COLON)) {
          this.nextToken(); // consume :
          this.nextToken(); // move to type name
          paramTypes.push(this.curToken.literal);
        } else {
          paramTypes.push(null);
        }
        if (this.peekTokenIs(TokenType.ASSIGN)) {
          this.nextToken(); // =
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
    return new ast.CallExpression(token, fn, args);
  }

  parseArrayLiteral() {
    const token = this.curToken;
    
    // Check for empty array
    if (this.peekTokenIs(TokenType.RBRACKET)) {
      this.nextToken();
      return new ast.ArrayLiteral(token, []);
    }
    
    // Parse first expression
    this.nextToken();
    const firstExpr = this.parseExpression(Precedence.LOWEST);
    
    // Check for comprehension: [expr for x in iterable]
    if (this.peekToken.literal === 'for') {
      this.nextToken(); // consume 'for'
      this.nextToken(); // variable name
      const variable = new ast.Identifier(this.curToken, this.curToken.literal);
      
      if (this.peekToken.literal !== 'in') {
        this.errors.push('expected "in" in array comprehension');
        return null;
      }
      this.nextToken(); // consume 'in'
      this.nextToken(); // start of iterable
      const iterable = this.parseExpression(Precedence.LOWEST);
      
      // Optional: if condition
      let condition = null;
      if (this.peekToken.literal === 'if') {
        this.nextToken(); // consume 'if'
        this.nextToken();
        condition = this.parseExpression(Precedence.LOWEST);
      }
      
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ast.ArrayComprehension(token, firstExpr, variable, iterable, condition);
    }
    
    // Normal array literal
    const elements = [firstExpr];
    while (this.peekTokenIs(TokenType.COMMA)) {
      this.nextToken();
      this.nextToken();
      elements.push(this.parseExpression(Precedence.LOWEST));
    }
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new ast.ArrayLiteral(token, elements);
  }

  parseIndexExpression(left) {
    const token = this.curToken;
    this.nextToken();
    
    // Check for slice: arr[:end], arr[start:end], arr[start:], arr[:]
    if (this.curTokenIs(TokenType.COLON)) {
      // arr[:end] or arr[:]
      this.nextToken();
      if (this.curTokenIs(TokenType.RBRACKET)) {
        // arr[:] — full slice
        return new ast.SliceExpression(token, left, null, null);
      }
      const end = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ast.SliceExpression(token, left, null, end);
    }
    
    const index = this.parseExpression(Precedence.LOWEST);
    
    // Check for slice: arr[start:end] or arr[start:]
    if (this.peekTokenIs(TokenType.COLON)) {
      this.nextToken(); // consume :
      this.nextToken();
      if (this.curTokenIs(TokenType.RBRACKET)) {
        // arr[start:]
        return new ast.SliceExpression(token, left, index, null);
      }
      const end = this.parseExpression(Precedence.LOWEST);
      if (!this.expectPeek(TokenType.RBRACKET)) return null;
      return new ast.SliceExpression(token, left, index, end);
    }
    
    if (!this.expectPeek(TokenType.RBRACKET)) return null;
    return new ast.IndexExpression(token, left, index);
  }

  parseHashLiteral() {
    const token = this.curToken;
    const pairs = new Map();
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
    return new ast.HashLiteral(token, pairs);
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
}
