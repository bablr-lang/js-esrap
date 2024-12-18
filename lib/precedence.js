// Copyright (c) 2023 [these people](https://github.com/Rich-Harris/esrap/graphs/contributors)

export const operatorPrecedence = {
  '||': 2,
  '&&': 3,
  '??': 4,
  '|': 5,
  '^': 6,
  '&': 7,
  '==': 8,
  '!=': 8,
  '===': 8,
  '!==': 8,
  '<': 9,
  '>': 9,
  '<=': 9,
  '>=': 9,
  in: 9,
  instanceof: 9,
  '<<': 10,
  '>>': 10,
  '>>>': 10,
  '+': 11,
  '-': 11,
  '*': 12,
  '%': 12,
  '/': 12,
  '**': 13,
};

export const expressionPrcedence = {
  JSXFragment: 20,
  JSXElement: 20,
  ArrayPattern: 20,
  ObjectPattern: 20,
  ArrayExpression: 20,
  TaggedTemplateExpression: 20,
  ThisExpression: 20,
  Identifier: 20,
  TemplateLiteral: 20,
  Super: 20,
  SequenceExpression: 20,
  MemberExpression: 19,
  MetaProperty: 19,
  CallExpression: 19,
  ChainExpression: 19,
  ImportExpression: 19,
  NewExpression: 19,
  Literal: 18,
  TSSatisfiesExpression: 18,
  TSInstantiationExpression: 18,
  TSNonNullExpression: 18,
  TSTypeAssertion: 18,
  AwaitExpression: 17,
  ClassExpression: 17,
  FunctionExpression: 17,
  ObjectExpression: 17,
  TSAsExpression: 16,
  UpdateExpression: 16,
  UnaryExpression: 15,
  BinaryExpression: 14,
  LogicalExpression: 13,
  ConditionalExpression: 4,
  ArrowFunctionExpression: 3,
  AssignmentExpression: 3,
  YieldExpression: 2,
  RestElement: 1,
};

export function needsParens(node, parent, is_right) {
  if (node.type === 'PrivateIdentifier') return false;

  // special case where logical expressions and coalesce expressions cannot be mixed,
  // either of them need to be wrapped with parentheses
  if (
    node.type === 'LogicalExpression' &&
    parent.type === 'LogicalExpression' &&
    ((parent.operator === '??' && node.operator !== '??') ||
      (parent.operator !== '??' && node.operator === '??'))
  ) {
    return true;
  }

  const precedence = expressionPrcedence[node.type];
  const parent_precedence = expressionPrcedence[parent.type];

  if (precedence !== parent_precedence) {
    // Different node types
    return (
      (!is_right && precedence === 15 && parent_precedence === 14 && parent.operator === '**') ||
      precedence < parent_precedence
    );
  }

  if (precedence !== 13 && precedence !== 14) {
    // Not a `LogicalExpression` or `BinaryExpression`
    return false;
  }

  if (node.operator === '**' && parent.operator === '**') {
    // Exponentiation operator has right-to-left associativity
    return !is_right;
  }

  if (is_right) {
    // Parenthesis are used if both operators have the same precedence
    return operatorPrecedence[node.operator] <= operatorPrecedence[parent.operator];
  }

  return operatorPrecedence[node.operator] < operatorPrecedence[parent.operator];
}
