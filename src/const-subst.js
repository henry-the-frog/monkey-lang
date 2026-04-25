/**
 * Constant Substitution Pass
 * 
 * Pre-compilation optimization that replaces variable references with
 * their known constant values. Runs after parsing, before compilation.
 * 
 * Example:
 *   let x = 30;      →  let x = 30;
 *   let y = x * 3;   →  let y = 30 * 3;  (x substituted)
 *   y                 →  90              (constant-folded by compiler)
 */

import * as AST from './ast.js';

/**
 * Find all let statements with constant values and substitute references.
 * Only handles simple cases (no mutation, no closure capture, no reassignment).
 */
export function constantSubstitution(program) {
  if (!(program instanceof AST.Program)) return program;
  
  const constants = new Map(); // name → AST literal node
  const used = new Set(); // names used in non-constant context
  
  // First pass: find constant bindings
  for (const stmt of program.statements) {
    if (stmt instanceof AST.LetStatement && isConstantLiteral(stmt.value)) {
      constants.set(stmt.name.value, stmt.value);
    }
  }
  
  if (constants.size === 0) return program;
  
  // Remove any variables that are mutated via set statements
  removeMutated(program.statements, constants);
  
  if (constants.size === 0) return program;
  
  // Second pass: substitute references
  program.statements = program.statements.map(stmt => substituteInNode(stmt, constants));
  
  return program;
}

/**
 * Recursively scan for SetStatement nodes and remove mutated names from constants.
 */
function removeMutated(nodes, constants) {
  for (const node of nodes) {
    if (!node) continue;
    if (node instanceof AST.SetStatement) {
      constants.delete(node.name.value);
    }
    // Recurse into blocks and control flow
    if (node instanceof AST.BlockStatement) {
      removeMutated(node.statements, constants);
    }
    if (node instanceof AST.IfExpression) {
      if (node.consequence) removeMutated(node.consequence.statements, constants);
      if (node.alternative) removeMutated(node.alternative.statements, constants);
    }
    if (node instanceof AST.ExpressionStatement && node.expression) {
      removeMutated([node.expression], constants);
    }
    if (node instanceof AST.ForExpression) {
      if (node.body) removeMutated(node.body.statements, constants);
      if (node.update) removeMutated([node.update], constants);
    }
    if (node instanceof AST.WhileExpression) {
      if (node.body) removeMutated(node.body.statements, constants);
    }
    if (node instanceof AST.DoWhileExpression) {
      if (node.body) removeMutated(node.body.statements, constants);
    }
    if (node instanceof AST.ForInExpression) {
      if (node.body) removeMutated(node.body.statements, constants);
    }
  }
}

function isConstantLiteral(node) {
  return node instanceof AST.IntegerLiteral ||
         node instanceof AST.FloatLiteral ||
         node instanceof AST.StringLiteral ||
         node instanceof AST.BooleanLiteral;
}

function substituteInNode(node, constants) {
  if (!node) return node;
  
  // Replace identifier references with constant values
  if (node instanceof AST.Identifier && constants.has(node.value)) {
    return cloneLiteral(constants.get(node.value));
  }
  
  // Recurse into expressions
  if (node instanceof AST.InfixExpression) {
    node.left = substituteInNode(node.left, constants);
    node.right = substituteInNode(node.right, constants);
    return node;
  }
  
  if (node instanceof AST.PrefixExpression) {
    node.right = substituteInNode(node.right, constants);
    return node;
  }
  
  if (node instanceof AST.LetStatement) {
    node.value = substituteInNode(node.value, constants);
    return node;
  }
  
  if (node instanceof AST.ExpressionStatement) {
    node.expression = substituteInNode(node.expression, constants);
    return node;
  }
  
  if (node instanceof AST.ReturnStatement) {
    node.returnValue = substituteInNode(node.returnValue, constants);
    return node;
  }
  
  if (node instanceof AST.IfExpression) {
    node.condition = substituteInNode(node.condition, constants);
    if (node.consequence) substituteInBlock(node.consequence, constants);
    if (node.alternative) substituteInBlock(node.alternative, constants);
    return node;
  }
  
  if (node instanceof AST.BlockStatement) {
    substituteInBlock(node, constants);
    return node;
  }
  
  // Don't substitute inside function bodies (variables might be shadowed)
  if (node instanceof AST.FunctionLiteral) return node;
  
  if (node instanceof AST.CallExpression) {
    node.arguments = node.arguments.map(a => substituteInNode(a, constants));
    // Don't substitute the function itself
    return node;
  }
  
  if (node instanceof AST.ArrayLiteral) {
    node.elements = node.elements.map(e => substituteInNode(e, constants));
    return node;
  }
  
  if (node instanceof AST.IndexExpression) {
    node.left = substituteInNode(node.left, constants);
    node.index = substituteInNode(node.index, constants);
    return node;
  }
  
  return node;
}

function substituteInBlock(block, constants) {
  block.statements = block.statements.map(s => substituteInNode(s, constants));
}

function cloneLiteral(node) {
  if (node instanceof AST.IntegerLiteral) {
    const n = new AST.IntegerLiteral();
    n.value = node.value;
    n.token = node.token;
    return n;
  }
  if (node instanceof AST.FloatLiteral) {
    const n = new AST.FloatLiteral();
    n.value = node.value;
    n.token = node.token;
    return n;
  }
  if (node instanceof AST.StringLiteral) {
    const n = new AST.StringLiteral();
    n.value = node.value;
    n.token = node.token;
    return n;
  }
  if (node instanceof AST.BooleanLiteral) {
    const n = new AST.BooleanLiteral();
    n.value = node.value;
    n.token = node.token;
    return n;
  }
  return node;
}
