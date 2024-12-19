// Copyright (c) 2023 [these people](https://github.com/Rich-Harris/esrap/graphs/contributors)

import { re } from '@bablr/boot';
import * as t from '@bablr/agast-helpers/shorthand';
import { map } from '@bablr/agast-vm-helpers/iterable';
import {
  buildNumber,
  buildString,
  buildNull,
  buildBoolean,
  canonicalURL,
  PN,
  WS,
  KW,
  ID,
  LIT,
  seq,
  ref,
  buildAppend,
} from './builders.js';
import { expressionPrcedence, needsParens } from './precedence.js';
import { getRoot, streamFromTree } from '@bablr/agast-helpers/tree';

const newline = { type: 'Newline' };
const indent = { type: 'Indent' };
const dedent = { type: 'Dedent' };

function measure(commands, from, to = commands.length) {
  let total = 0;
  for (let i = from; i < to; i += 1) {
    const command = commands[i];
    if (typeof command === 'string') {
      total += command.length;
    } else if (command.type === 'Chunk') {
      total += command.content.length;
    } else if (command.type === 'Sequence') {
      // assume this is ', '
      total += 2;
    }
  }

  return total;
}

export function handle(node, state) {
  const node_with_comments = node;

  const handler = handlers[node.type];

  if (!handler) {
    throw new Error(`Not implemented ${node.type}`);
  }

  state.commands.push(buildAppend(t.ref`children[]`));
  state.commands.push(buildAppend(t.nodeOpen(t.nodeFlags, canonicalURL, node.type)));
  state.commands.push(buildAppend(t.ref`children[]`));
  state.commands.push(buildAppend(t.buildArrayInitializerTag()));

  if (node_with_comments.leadingComments) {
    prepend_comments(node_with_comments.leadingComments, state, false);
  }

  handler(node, state);

  if (node_with_comments.trailingComments) {
    state.comments.push(node_with_comments.trailingComments[0]); // there is only ever one
  }

  state.commands.push(buildAppend(t.nodeClose()));
}

function prepend_comments(comments, state, newlines) {
  for (const comment of comments) {
    state.commands.push({ type: 'Comment', comment });

    if (newlines || comment.type === 'Line' || /\n/.test(comment.value)) {
      state.commands.push(newline);
    } else {
      state.commands.push(ref`#`, WS` `);
    }
  }
}

function has_call_expression(node) {
  while (node) {
    if (node.type === 'CallExpression') {
      return true;
    } else if (node.type === 'MemberExpression') {
      node = node.object;
    } else {
      return false;
    }
  }
}

const grouped_expression_types = [
  'ImportDeclaration',
  'VariableDeclaration',
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
];

const handle_body = (nodes, state) => {
  let last_statement = {
    type: 'EmptyStatement',
  };
  let first = true;
  let needs_margin = false;

  for (const statement of nodes) {
    if (statement.type === 'EmptyStatement') continue;

    const margin = seq();

    if (!first) state.commands.push(margin, newline);
    first = false;

    const statement_with_comments = statement;
    const leading_comments = statement_with_comments.leadingComments;
    delete statement_with_comments.leadingComments;

    if (leading_comments && leading_comments.length > 0) {
      prepend_comments(leading_comments, state, true);
    }

    const child_state = { ...state, multiline: false };
    handle(statement, child_state);

    if (
      child_state.multiline ||
      needs_margin ||
      ((grouped_expression_types.includes(statement.type) ||
        grouped_expression_types.includes(last_statement.type)) &&
        last_statement.type !== statement.type)
    ) {
      margin.children.push(ref`#`, WS`\n`);
    }

    let add_newline = false;

    while (state.comments.length) {
      const comment = state.comments.shift();

      state.commands.push(...(add_newline ? [newline] : [ref`#`, WS` `]), {
        type: 'Comment',
        comment,
      });
      add_newline = comment.type === 'Line';
    }

    needs_margin = child_state.multiline;
    last_statement = statement;
  }
};

const handle_var_declaration = (node, state) => {
  const index = state.commands.length;

  const open = seq();
  const join = seq();
  const child_state = { ...state, multiline: false };

  state.commands.push(ref`children[]`, KW(node.kind), ref`#`, WS` `, open);

  let first = true;

  for (const d of node.declarations) {
    if (!first) state.commands.push(join);
    first = false;

    handle(d, child_state);
  }

  const multiline =
    child_state.multiline || (node.declarations.length > 1 && measure(state.commands, index) > 50);

  if (multiline) {
    state.multiline = true;
    if (node.declarations.length > 1) open.children.push(indent);
    join.children.push(ref`separators[]`, ref`children[]`, PN`,`, newline);
    if (node.declarations.length > 1) state.commands.push(dedent);
  } else {
    join.children.push(ref`separators[]`, ref`children[]`, PN`,`, ref`#`, WS` `);
  }
};

function list(nodes, state, spaces, fn, separator = [ref`children[]`, PN`,`]) {
  if (nodes.length === 0) return;

  const index = state.commands.length;

  const open = seq();
  const join = seq();
  const close = seq();

  state.commands.push(open);

  const child_state = { ...state, multiline: false };

  let prev;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const is_first = i === 0;
    const is_last = i === nodes.length - 1;

    if (node) {
      if (!is_first && !prev) {
        state.commands.push(join);
      }

      fn(node, child_state);

      if (!is_last) {
        state.commands.push(...separator);
      }

      if (state.comments.length > 0) {
        state.commands.push(ref`#`, WS` `);

        while (state.comments.length) {
          const comment = state.comments.shift();
          state.commands.push({ type: 'Comment', comment });
          if (!is_last) state.commands.push(join);
        }

        child_state.multiline = true;
      } else {
        if (!is_last) state.commands.push(join);
      }
    } else {
      // This is only used for ArrayPattern and ArrayExpression, but
      // it makes more sense to have the logic here than there, because
      // otherwise we'd duplicate a lot more stuff
      state.commands.push(...separator);
    }

    prev = node;
  }

  state.commands.push(close);

  const multiline = child_state.multiline || measure(state.commands, index) > 50;

  if (multiline) {
    state.multiline = true;

    open.children.push(indent, newline);
    join.children.push(newline);
    close.children.push(dedent, newline);
  } else {
    if (spaces) open.children.push(ref`#`, WS` `);
    join.children.push(ref`#`, WS` `);
    if (spaces) close.children.push(ref`#`, WS` `);
  }
}

function handle_type_annotation(node, state) {
  switch (node.type) {
    case 'TSNumberKeyword':
      state.commands.push(ref`children[]`, KW`number`);
      break;
    case 'TSStringKeyword':
      state.commands.push(ref`children[]`, KW`string`);
      break;
    case 'TSBooleanKeyword':
      state.commands.push(ref`children[]`, KW`boolean`);
      break;
    case 'TSAnyKeyword':
      state.commands.push(ref`children[]`, KW`any`);
      break;
    case 'TSVoidKeyword':
      state.commands.push(ref`children[]`, KW`void`);
      break;
    case 'TSUnknownKeyword':
      state.commands.push(ref`children[]`, KW`unknown`);
      break;
    case 'TSNeverKeyword':
      state.commands.push(ref`children[]`, KW`never`);
      break;
    case 'TSArrayType':
      handle_type_annotation(node.elementType, state);
      state.commands.push(ref`children[]`, PN`[]`);
      break;
    case 'TSTypeAnnotation':
      state.commands.push(ref`children[]`, PN`:`, ref`#`, WS` `);
      handle_type_annotation(node.typeAnnotation, state);
      break;
    case 'TSTypeLiteral':
      state.commands.push(ref`children[]`, PN`{`, ref`#`, WS` `);
      list(node.members, state, false, handle_type_annotation, [
        ref`statementTerminatorToken`,
        PN`;`,
      ]);
      state.commands.push(ref`#`, WS` `, ref`children[]`, PN`}`);
      break;
    case 'TSPropertySignature':
      handle(node.key, state);
      if (node.optional) state.commands.push(ref`children[]`, PN`?`);
      if (node.typeAnnotation) handle_type_annotation(node.typeAnnotation, state);
      break;
    case 'TSTypeReference':
      handle(node.typeName, state);

      if (node.typeParameters) handle_type_annotation(node.typeParameters, state);
      break;
    case 'TSTypeParameterInstantiation':
    case 'TSTypeParameterDeclaration':
      state.commands.push(ref`children[]`, PN`<`);
      for (let i = 0; i < node.params.length; i++) {
        handle_type_annotation(node.params[i], state);
        if (i != node.params.length - 1)
          state.commands.push(ref`separators[]`, ref`children[]`, PN`,`, ref`#`, WS` `);
      }
      state.commands.push(ref`children[]`, PN`>`);
      break;
    case 'TSTypeParameter':
      state.commands.push(node.name);

      if (node.constraint) {
        state.commands.push(ref`#`, WS` `, ref`children[]`, KW`extends`, ref`#`, WS` `);
        handle_type_annotation(node.constraint, state);
      }
      break;
    case 'TSTypeQuery':
      state.commands.push(ref`children[]`, KW`typeof`, ref`#`, WS` `);
      handle(node.exprName, state);
      break;
    case 'TSEnumMember':
      handle(node.id, state);
      if (node.initializer) {
        state.commands.push(ref`#`, WS` `, ref`children[]`, PN`=`, ref`#`, WS` `);
        handle(node.initializer, state);
      }
      break;
    case 'TSFunctionType':
      if (node.typeParameters) handle_type_annotation(node.typeParameters, state);

      const parameters = node.parameters;
      state.commands.push(ref`children[]`, PN`(`);
      list(parameters, state, false, handle);

      state.commands.push(
        ref`children[]`,
        PN`)`,
        ref`#`,
        WS` `,
        ref`children[]`,
        PN`=>`,
        ref`#`,
        WS` `,
      );

      handle_type_annotation(node.typeAnnotation.typeAnnotation, state);
      break;
    case 'TSIndexSignature':
      const indexParameters = node.parameters;
      state.commands.push(ref`children[]`, PN`[`);
      list(indexParameters, state, false, handle);
      state.commands.push(ref`children[]`, PN`]`);

      handle_type_annotation(node.typeAnnotation, state);
      break;
    case 'TSMethodSignature':
      handle(node.key, state);

      const parametersSignature = node.parameters;
      state.commands.push(ref`children[]`, PN`(`);
      list(parametersSignature, state, false, handle);
      state.commands.push(ref`children[]`, PN`)`);

      handle_type_annotation(node.typeAnnotation, state);
      break;
    case 'TSExpressionWithTypeArguments':
      handle(node.expression, state);
      break;
    case 'TSTupleType':
      state.commands.push(ref`children[]`, PN`[`);
      list(node.elementTypes, state, false, handle_type_annotation);
      state.commands.push(ref`children[]`, PN`]`);
      break;
    case 'TSNamedTupleMember':
      handle(node.label, state);
      state.commands.push(ref`children[]`, PN`:`, ref`#`, WS` `);
      handle_type_annotation(node.elementType, state);

      break;
    case 'TSUnionType':
      list(node.types, state, false, handle_type_annotation, [
        ref`#`,
        WS` `,
        ref`children[]`,
        PN`|`,
      ]);
      break;
    case 'TSIntersectionType':
      list(node.types, state, false, handle_type_annotation, [
        ref`#`,
        WS` `,
        ref`children[]`,
        PN`&`,
      ]);
      break;
    case 'TSLiteralType':
      handle(node.literal, state);
      break;
    case 'TSConditionalType':
      handle_type_annotation(node.checkType, state);
      state.commands.push(ref`#`, WS` `, ref`children[]`, KW`extends`, ref`#`, WS` `);
      handle_type_annotation(node.extendsType, state);
      state.commands.push(ref`#`, WS` `, ref`children[]`, PN`?`, ref`#`, WS` `);
      handle_type_annotation(node.trueType, state);
      state.commands.push(ref`#`, WS` `, ref`children[]`, PN`:`, ref`#`, WS` `);
      handle_type_annotation(node.falseType, state);
      break;
    default:
      throw new Error(`Not implemented type annotation ${node.type}`);
  }
}

const shared = {
  'ArrayExpression|ArrayPattern': (node, state) => {
    state.commands.push(ref`children[]`, PN`[`);
    list(node.elements, state, false, handle);
    state.commands.push(ref`children[]`, PN`]`);
  },

  'BinaryExpression|LogicalExpression': (node, state) => {
    // TODO
    // const is_in = node.operator === 'in';
    // if (is_in) {
    // 	// Avoids confusion in `for` loops initializers
    // 	chunks.push(c('('));
    // }

    if (needsParens(node.left, node, false)) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.left, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.left, state);
    }

    state.commands.push(ref`#`, WS` `, ref`children[]`, PN(node.operator), ref`#`, WS` `);

    if (needsParens(node.right, node, true)) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.right, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.right, state);
    }
  },

  'BlockStatement|ClassBody': (node, state) => {
    if (node.body.length === 0) {
      state.commands.push(ref`children[]`, PN`{`, ref`children[]`, PN`}`);
      return;
    }

    state.multiline = true;

    state.commands.push(ref`children[]`, PN`{`, indent, newline);
    handle_body(node.body, state);
    state.commands.push(dedent, newline, ref`children[]`, PN`}`);
  },

  'CallExpression|NewExpression': (node, state) => {
    if (node.type === 'NewExpression') {
      state.commands.push(ref`children[]`, KW`new`, ref`#`, WS` `);
    }

    const needsParens =
      expressionPrcedence[node.callee.type] < expressionPrcedence.CallExpression ||
      (node.type === 'NewExpression' && has_call_expression(node.callee));

    if (needsParens) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.callee, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.callee, state);
    }

    if (node.optional) {
      state.commands.push(ref`children[]`, PN`?.`);
    }

    if (node.typeParameters) handle_type_annotation(node.typeParameters, state);

    const open = seq();
    const join = seq();
    const close = seq();

    state.commands.push(ref`children[]`, PN`(`, open);

    // if the final argument is multiline, it doesn't need to force all the
    // other arguments to also be multiline
    const child_state = { ...state, multiline: false };
    const final_state = { ...state, multiline: false };

    for (let i = 0; i < node.arguments.length; i += 1) {
      if (i > 0) {
        if (state.comments.length > 0) {
          state.commands.push(ref`separators[]`, ref`children[]`, PN`,`, ref`#`, WS` `);

          while (state.comments.length) {
            const comment = state.comments.shift();

            state.commands.push({ type: 'Comment', comment });

            if (comment.type === 'Line') {
              child_state.multiline = true;
              state.commands.push(newline);
            } else {
              state.commands.push(ref`#`, WS` `);
            }
          }
        } else {
          state.commands.push(join);
        }
      }

      const p = node.arguments[i];

      handle(p, i === node.arguments.length - 1 ? final_state : child_state);
    }

    state.commands.push(close, ref`children[]`, PN`)`);

    const multiline = child_state.multiline;

    if (multiline || final_state.multiline) {
      state.multiline = true;
    }

    if (multiline) {
      open.children.push(indent, newline);
      join.children.push(ref`separators[]`, ref`children[]`, PN`,`, newline);
      close.children.push(dedent, newline);
    } else {
      join.children.push(ref`separators[]`, ref`children[]`, PN`,`, ref`#`, WS` `);
    }
  },

  'ClassDeclaration|ClassExpression': (node, state) => {
    state.commands.push(ref`children[]`, KW`class`, ref`#`, WS` `);

    if (node.id) {
      handle(node.id, state);
      state.commands.push(ref`#`, WS` `);
    }

    if (node.superClass) {
      state.commands.push(ref`children[]`, KW`extends`, ref`#`, WS` `);
      handle(node.superClass, state);
      state.commands.push(ref`#`, WS` `);
    }

    if (node.implements) {
      state.commands.push(ref`children[]`, KW`implements`, ref`children[]`, PN` `);
      list(node.implements, state, false, handle_type_annotation);
    }

    handle(node.body, state);
  },

  'ForInStatement|ForOfStatement': (node, state) => {
    state.commands.push(ref`children[]`, KW`for`, ref`#`, WS` `);
    if (node.type === 'ForOfStatement' && node.await)
      state.commands.push(ref`children[]`, KW`await`, ref`#`, WS` `);
    state.commands.push(ref`children[]`, PN`(`);

    if (node.left.type === 'VariableDeclaration') {
      handle_var_declaration(node.left, state);
    } else {
      handle(node.left, state);
    }

    state.commands.push(
      ...(node.type === 'ForInStatement'
        ? [ref`#`, WS` `, ref`children[]`, KW`in`, ref`#`, WS` `]
        : [ref`#`, WS` `, ref`children[]`, KW`of`, ref`#`, WS` `]),
    );
    handle(node.right, state);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
    handle(node.body, state);
  },

  'FunctionDeclaration|FunctionExpression': (node, state) => {
    if (node.async) state.commands.push(ref`children[]`, KW`async`, ref`children[]`, PN` `);
    state.commands.push(
      ...(node.generator
        ? [ref`children[]`, KW`function`, ref`children[]`, PN`*`, ref`#`, WS` `]
        : [ref`children[]`, KW`function`, ref`#`, WS` `]),
    );
    if (node.id) handle(node.id, state);

    if (node.typeParameters) {
      handle_type_annotation(node.typeParameters, state);
    }

    state.commands.push(ref`children[]`, PN`(`);
    list(node.params, state, false, handle);
    state.commands.push(ref`children[]`, PN`)`);

    if (node.returnType) handle_type_annotation(node.returnType, state);

    state.commands.push(ref`#`, WS` `);

    handle(node.body, state);
  },

  'RestElement|SpreadElement': (node, state) => {
    state.commands.push(ref`children[]`, PN`...`);
    handle(node.argument, state);

    if (node.typeAnnotation) handle_type_annotation(node.typeAnnotation, state);
  },
};

const handlers = {
  ArrayExpression: shared['ArrayExpression|ArrayPattern'],

  ArrayPattern: shared['ArrayExpression|ArrayPattern'],

  ArrowFunctionExpression: (node, state) => {
    if (node.async) state.commands.push(ref`children[]`, KW`async`, ref`#`, WS` `);

    state.commands.push(ref`children[]`, PN`(`);
    list(node.params, state, false, handle);
    state.commands.push(
      ref`children[]`,
      PN`)`,
      ref`#`,
      WS` `,
      ref`children[]`,
      PN`=>`,
      ref`#`,
      WS` `,
    );

    if (
      node.body.type === 'ObjectExpression' ||
      (node.body.type === 'AssignmentExpression' && node.body.left.type === 'ObjectPattern') ||
      (node.body.type === 'LogicalExpression' && node.body.left.type === 'ObjectExpression') ||
      (node.body.type === 'ConditionalExpression' && node.body.test.type === 'ObjectExpression')
    ) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.body, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.body, state);
    }
  },

  AssignmentExpression(node, state) {
    handle(node.left, state);
    state.commands.push(ref`#`, WS` `, ref`children[]`, PN(node.operator), ref`#`, WS` `);
    handle(node.right, state);
  },

  AssignmentPattern(node, state) {
    handle(node.left, state);
    state.commands.push(ref`#`, WS` `, ref`children[]`, PN`=`, ref`#`, WS` `);
    handle(node.right, state);
  },

  AwaitExpression(node, state) {
    if (node.argument) {
      const precedence = expressionPrcedence[node.argument.type];

      if (precedence && precedence < expressionPrcedence.AwaitExpression) {
        state.commands.push(ref`children[]`, KW`await`, ref`#`, WS` `, ref`children[]`, PN`(`);
        handle(node.argument, state);
        state.commands.push(ref`children[]`, PN`)`);
      } else {
        state.commands.push(ref`children[]`, KW`await`, ref`#`, WS` `);
        handle(node.argument, state);
      }
    } else {
      state.commands.push(ref`children[]`, KW`await`);
    }
  },

  BinaryExpression: shared['BinaryExpression|LogicalExpression'],

  BlockStatement: shared['BlockStatement|ClassBody'],

  BreakStatement(node, state) {
    if (node.label) {
      state.commands.push(ref`children[]`, KW`break`, ref`#`, WS` `);
      handle(node.label, state);
      state.commands.push(ref`statementTerminatorToken`, PN`;`);
    } else {
      state.commands.push(ref`children[]`, KW`break`, ref`statementTerminatorToken`, PN`;`);
    }
  },

  CallExpression: shared['CallExpression|NewExpression'],

  ChainExpression(node, state) {
    handle(node.expression, state);
  },

  ClassBody: shared['BlockStatement|ClassBody'],

  ClassDeclaration: shared['ClassDeclaration|ClassExpression'],

  ClassExpression: shared['ClassDeclaration|ClassExpression'],

  ConditionalExpression(node, state) {
    if (expressionPrcedence[node.test.type] > expressionPrcedence.ConditionalExpression) {
      handle(node.test, state);
    } else {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.test, state);
      state.commands.push(ref`children[]`, PN`)`);
    }

    const if_true = seq();
    const if_false = seq();

    const child_state = { ...state, multiline: false };

    state.commands.push(if_true);
    handle(node.consequent, child_state);
    state.commands.push(if_false);
    handle(node.alternate, child_state);

    const multiline = child_state.multiline;

    if (multiline) {
      if_true.children.push(indent, newline, ref`children[]`, PN`?`, ref`#`, WS` `);
      if_false.children.push(newline, ref`children[]`, PN`:`, ref`#`, WS` `);
      state.commands.push(dedent);
    } else {
      if_true.children.push(ref`#`, WS` `, ref`children[]`, PN`?`, ref`#`, WS` `);
      if_false.children.push(ref`#`, WS` `, ref`children[]`, PN`:`, ref`#`, WS` `);
    }
  },

  ContinueStatement(node, state) {
    if (node.label) {
      state.commands.push(ref`children[]`, KW`continue`, ref`#`, WS` `);
      handle(node.label, state);
      state.commands.push(ref`statementTerminatorToken`, PN`;`);
    } else {
      state.commands.push(ref`children[]`, KW`continue`, ref`statementTerminatorToken`, PN`;`);
    }
  },

  DebuggerStatement(node, state) {
    state.commands.push(ref`children[]`, KW`debugger`, ref`statementTerminatorToken`, PN`;`);
  },

  Decorator(node, state) {
    state.commands.push(ref`children[]`, PN`@`);
    handle(node.expression, state);
    state.commands.push(newline);
  },

  DoWhileStatement(node, state) {
    state.commands.push(ref`children[]`, KW`do`, ref`#`, WS` `);
    handle(node.body, state);
    state.commands.push(ref`#`, WS` `, ref`children[]`, KW`while`, ref`children[]`, PN`(`);
    handle(node.test, state);
    state.commands.push(ref`children[]`, PN`)`, ref`statementTerminatorToken`, PN`;`);
  },

  EmptyStatement(node, state) {
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  ExportAllDeclaration(node, state) {
    state.commands.push(
      ref`children[]`,
      KW`export`,
      ref`#`,
      WS` `,
      ref`children[]`,
      PN`*`,
      ref`#`,
      WS` `,
      ref`children[]`,
      KW`from`,
      ref`#`,
      WS` `,
    );
    handle(node.source, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  ExportDefaultDeclaration(node, state) {
    state.commands.push(
      ref`children[]`,
      KW`export`,
      ref`#`,
      WS` `,
      ref`children[]`,
      KW`default`,
      ref`#`,
      WS` `,
    );

    handle(node.declaration, state);

    if (node.declaration.type !== 'FunctionDeclaration') {
      state.commands.push(ref`statementTerminatorToken`, PN`;`);
    }
  },

  ExportNamedDeclaration(node, state) {
    state.commands.push(ref`children[]`, KW`export`, ref`#`, WS` `);

    if (node.declaration) {
      handle(node.declaration, state);
      return;
    }

    state.commands.push(ref`children[]`, PN`{`);
    list(node.specifiers, state, true, (s, state) => {
      handle(s.local, state);

      if (s.local.name !== s.exported.name) {
        state.commands.push(ref`#`, WS` `, ref`children[]`, KW`as`, ref`#`, WS` `);
        handle(s.exported, state);
      }
    });
    state.commands.push(ref`children[]`, PN`}`);

    if (node.source) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, KW`from`, ref`#`, WS` `);
      handle(node.source, state);
    }

    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  ExpressionStatement(node, state) {
    if (
      node.expression.type === 'ObjectExpression' ||
      (node.expression.type === 'AssignmentExpression' &&
        node.expression.left.type === 'ObjectPattern')
    ) {
      // is an AssignmentExpression to an ObjectPattern
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.expression, state);
      state.commands.push(ref`children[]`, PN`)`, ref`statementTerminatorToken`, PN`;`);
      return;
    }

    handle(node.expression, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  ForStatement: (node, state) => {
    state.commands.push(ref`children[]`, KW`for`, ref`#`, WS` `, ref`children[]`, PN`(`);

    if (node.init) {
      if (node.init.type === 'VariableDeclaration') {
        handle_var_declaration(node.init, state);
      } else {
        handle(node.init, state);
      }
    }

    state.commands.push(ref`initTerminatorToken`, PN`;`, ref`#`, WS` `);
    if (node.test) handle(node.test, state);
    state.commands.push(ref`testTerminatorToken`, PN`;`, ref`#`, WS` `);
    if (node.update) handle(node.update, state);

    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
    handle(node.body, state);
  },

  ForInStatement: shared['ForInStatement|ForOfStatement'],

  ForOfStatement: shared['ForInStatement|ForOfStatement'],

  FunctionDeclaration: shared['FunctionDeclaration|FunctionExpression'],

  FunctionExpression: shared['FunctionDeclaration|FunctionExpression'],

  Identifier(node, state) {
    let name = node.name;
    state.commands.push(ref`children[]`, ID(name));

    if (node.typeAnnotation) handle_type_annotation(node.typeAnnotation, state);
  },

  IfStatement(node, state) {
    state.commands.push(ref`children[]`, KW`if`, ref`#`, WS` `, ref`children[]`, PN`(`);
    handle(node.test, state);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
    handle(node.consequent, state);

    if (node.alternate) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, KW`else`, ref`#`, WS` `);
      handle(node.alternate, state);
    }
  },

  ImportDeclaration(node, state) {
    if (node.specifiers.length === 0) {
      state.commands.push(ref`children[]`, KW`import`, ref`#`, WS` `);
      handle(node.source, state);
      state.commands.push(ref`statementTerminatorToken`, PN`;`);
      return;
    }

    let namespace_specifier = null;

    let default_specifier = null;

    const named_specifiers = [];

    for (const s of node.specifiers) {
      if (s.type === 'ImportNamespaceSpecifier') {
        namespace_specifier = s;
      } else if (s.type === 'ImportDefaultSpecifier') {
        default_specifier = s;
      } else {
        named_specifiers.push(s);
      }
    }

    state.commands.push(ref`children[]`, KW`import`, ref`#`, WS` `);
    if (node.importKind == 'type') state.commands.push(ref`children[]`, KW`type`, ref`#`, WS` `);

    if (default_specifier) {
      state.commands.push(default_specifier.local.name);
      if (namespace_specifier || named_specifiers.length > 0)
        state.commands.push(ref`separators[]`, ref`children[]`, PN`,`, ref`#`, WS` `);
    }

    if (namespace_specifier) {
      state.commands.push(
        ref`children[]`,
        PN`*`,
        ref`#`,
        WS` `,
        ref`children[]`,
        KW`as`,
        ref`#`,
        WS` `,
        ref`children[]`,
        ID(namespace_specifier.local.name),
      );
    }

    if (named_specifiers.length > 0) {
      state.commands.push(ref`children[]`, PN`{`);
      list(named_specifiers, state, true, (s, state) => {
        if (s.local.name !== s.imported.name) {
          handle(s.imported, state);
          state.commands.push(ref`#`, WS` `, ref`children[]`, KW`as`, ref`#`, WS` `);
        }

        if (s.importKind == 'type') state.commands.push(ref`children[]`, KW`type`, ref`#`, WS` `);
        handle(s.local, state);
      });
      state.commands.push(ref`children[]`, PN`}`);
    }

    state.commands.push(ref`#`, WS` `, ref`children[]`, KW`from`, ref`#`, WS` `);
    handle(node.source, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  ImportExpression(node, state) {
    state.commands.push(ref`children[]`, KW`import`, ref`children[]`, PN`(`);
    handle(node.source, state);
    state.commands.push(ref`children[]`, PN`)`);
  },

  LabeledStatement(node, state) {
    handle(node.label, state);
    state.commands.push(ref`children[]`, PN`:`, ref`#`, WS` `);
    handle(node.body, state);
  },

  Literal(node, state) {
    // TODO do we need to handle weird unicode characters somehow?
    // str.replace(/\\u(\d{4})/g, (m, n) => String.fromCharCode(+n))

    let cstNode;

    if (typeof node.value === 'string') {
      cstNode = buildString(node.value);
    } else if (typeof node.value === 'number') {
      cstNode = buildNumber(node.value);
    } else if (typeof node.value === 'boolean') {
      cstNode = buildBoolean(node.value);
    } else if (node.value instanceof RegExp) {
      cstNode = getRoot(re({ raw: [node.value.toString()] }));
    } else if (node.value === null) {
      cstNode = buildNull();
    } else {
      throw new Error('unsupported literal type ' + typeof node.value);
    }

    const tags = [...streamFromTree(cstNode)];

    const innerTags = tags.slice(1, -1);

    state.commands.push(...map(buildAppend, innerTags));
  },

  LogicalExpression: shared['BinaryExpression|LogicalExpression'],

  MemberExpression(node, state) {
    if (expressionPrcedence[node.object.type] < expressionPrcedence.MemberExpression) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.object, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.object, state);
    }

    if (node.computed) {
      if (node.optional) {
        state.commands.push(ref`children[]`, PN`?.`);
      }
      state.commands.push(ref`children[]`, PN`[`);
      handle(node.property, state);
      state.commands.push(ref`children[]`, PN`]`);
    } else {
      state.commands.push(
        ...(node.optional ? [ref`children[]`, PN`?.`] : [ref`children[]`, PN`.`]),
      );
      handle(node.property, state);
    }
  },

  MetaProperty(node, state) {
    handle(node.meta, state);
    state.commands.push(ref`children[]`, PN`.`);
    handle(node.property, state);
  },

  MethodDefinition(node, state) {
    if (node.decorators) {
      for (const decorator of node.decorators) {
        handle(decorator, state);
      }
    }

    if (node.static) {
      state.commands.push(ref`children[]`, KW`static`, ref`#`, WS` `);
    }

    if (node.kind === 'get' || node.kind === 'set') {
      // Getter or setter
      state.commands.push(ref`children[]`, KW(node.kind), ref`#`, WS` `);
    }

    if (node.value.async) {
      state.commands.push(ref`children[]`, KW`async`, ref`#`, WS` `);
    }

    if (node.value.generator) {
      state.commands.push(ref`children[]`, PN`*`);
    }

    if (node.computed) state.commands.push(ref`children[]`, PN`[`);
    handle(node.key, state);
    if (node.computed) state.commands.push(ref`children[]`, PN`]`);

    state.commands.push(ref`children[]`, PN`(`);
    list(node.value.params, state, false, handle);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);

    if (node.value.body) handle(node.value.body, state);
  },

  NewExpression: shared['CallExpression|NewExpression'],

  ObjectExpression(node, state) {
    state.commands.push(ref`children[]`, PN`{`);
    list(node.properties, state, true, (p, state) => {
      if (p.type === 'Property' && p.value.type === 'FunctionExpression') {
        const fn = p.value;

        if (p.kind === 'get' || p.kind === 'set') {
          state.commands.push(ref`children[]`, KW(p.kind) + ref`#`, WS` `);
        } else {
          if (fn.async) state.commands.push(ref`children[]`, KW`async`, ref`#`, WS` `);
          if (fn.generator) state.commands.push(ref`children[]`, PN`*`);
        }

        if (p.computed) state.commands.push(ref`children[]`, PN`[`);
        handle(p.key, state);
        if (p.computed) state.commands.push(ref`children[]`, PN`]`);

        state.commands.push(ref`children[]`, PN`(`);
        list(fn.params, state, false, handle);
        state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);

        handle(fn.body, state);
      } else {
        handle(p, state);
      }
    });
    state.commands.push(ref`children[]`, PN`}`);
  },

  ObjectPattern(node, state) {
    state.commands.push(ref`children[]`, PN`{`);
    list(node.properties, state, true, handle);
    state.commands.push(ref`children[]`, PN`}`);

    if (node.typeAnnotation) handle_type_annotation(node.typeAnnotation, state);
  },

  ParenthesizedExpression(node, state) {
    return handle(node.expression, state);
  },

  PrivateIdentifier(node, state) {
    state.commands.push(ref`children[]`, PN`#`, ref`children[]`, ID(node.name));
  },

  Program(node, state) {
    handle_body(node.body, state);
  },

  Property(node, state) {
    const value = node.value.type === 'AssignmentPattern' ? node.value.left : node.value;

    const shorthand =
      !node.computed &&
      node.kind === 'init' &&
      node.key.type === 'Identifier' &&
      value.type === 'Identifier' &&
      node.key.name === value.name;

    if (shorthand) {
      handle(node.value, state);
      return;
    }

    if (node.computed) state.commands.push(ref`children[]`, PN`[`);
    handle(node.key, state);
    state.commands.push(
      ...(node.computed
        ? [ref`children[]`, PN`]`, ref`children[]`, PN`:`, ref`#`, WS` `]
        : [ref`children[]`, PN`:`, ref`#`, WS` `]),
    );
    handle(node.value, state);
  },

  PropertyDefinition(node, state) {
    if (node.accessibility) {
      state.commands.push(ref`children[]`, KW(node.accessibility), ref`#`, WS` `);
    }

    if (node.static) {
      state.commands.push(ref`children[]`, KW`static`, ref`#`, WS` `);
    }

    if (node.computed) {
      state.commands.push(ref`children[]`, PN`[`);
      handle(node.key, state);
      state.commands.push(ref`children[]`, PN`]`);
    } else {
      handle(node.key, state);
    }

    if (node.typeAnnotation) {
      state.commands.push(ref`children[]`, PN`:`, ref`#`, WS` `);
      handle_type_annotation(node.typeAnnotation.typeAnnotation, state);
    }

    if (node.value) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, PN`=`, ref`#`, WS` `);

      handle(node.value, state);
    }

    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  RestElement: shared['RestElement|SpreadElement'],

  ReturnStatement(node, state) {
    if (node.argument) {
      const argumentWithComment = node.argument;
      const contains_comment =
        argumentWithComment.leadingComments &&
        argumentWithComment.leadingComments.some((comment) => comment.type === 'Line');

      state.commands.push(
        ...(contains_comment
          ? [ref`children[]`, KW`return`, ref`#`, WS` `, ref`children[]`, PN`(`]
          : [ref`children[]`, KW`return`, ref`#`, WS` `]),
      );
      handle(node.argument, state);
      state.commands.push(
        ...(contains_comment
          ? [ref`children[]`, PN`)`, ref`statementTerminatorToken`, PN`;`]
          : [ref`statementTerminatorToken`, PN`;`]),
      );
    } else {
      state.commands.push(ref`children[]`, KW`return`, ref`statementTerminatorToken`, PN`;`);
    }
  },

  SequenceExpression(node, state) {
    state.commands.push(ref`children[]`, PN`(`);
    list(node.expressions, state, false, handle);
    state.commands.push(ref`children[]`, PN`)`);
  },

  SpreadElement: shared['RestElement|SpreadElement'],

  StaticBlock(node, state) {
    state.commands.push(
      indent,
      ref`children[]`,
      KW`static`,
      ref`#`,
      WS` `,
      ref`children[]`,
      PN`{`,
      newline,
    );

    handle_body(node.body, state);

    state.commands.push(dedent, newline, ref`children[]`, PN`}`);
  },

  Super(node, state) {
    state.commands.push(ref`children[]`, KW`super`);
  },

  SwitchStatement(node, state) {
    state.commands.push(ref`children[]`, KW`switch`, ref`#`, WS` `, ref`children[]`, PN`(`);
    handle(node.discriminant, state);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `, ref`children[]`, PN`{`, indent);

    let first = true;

    for (const block of node.cases) {
      if (!first) state.commands.push(ref`#`, WS`\n`);
      first = false;

      if (block.test) {
        state.commands.push(newline, ref`children[]`, KW`case`, ref`#`, WS` `);
        handle(block.test, state);
        state.commands.push(ref`children[]`, PN`:`);
      } else {
        state.commands.push(newline, ref`children[]`, KW`default`, ref`children[]`, PN`:`);
      }

      state.commands.push(indent);

      for (const statement of block.consequent) {
        state.commands.push(newline);
        handle(statement, state);
      }

      state.commands.push(dedent);
    }

    state.commands.push(dedent, newline, ref`children[]`, PN`}`);
  },

  TaggedTemplateExpression(node, state) {
    handle(node.tag, state);
    handle(node.quasi, state);
  },

  TemplateLiteral(node, state) {
    state.commands.push(ref`children[]`, PN('`'));

    const { quasis, expressions } = node;

    for (let i = 0; i < expressions.length; i++) {
      const raw = quasis[i].value.raw;

      state.commands.push(ref`children[]`, LIT(raw), ref`children[]`, PN('${'));
      handle(expressions[i], state);
      state.commands.push(ref`children[]`, PN`}`);

      if (/\n/.test(raw)) state.multiline = true;
    }

    const raw = quasis[quasis.length - 1].value.raw;

    state.commands.push(ref`children[]`, LIT(raw), ref`children[]`, PN('`'));
    if (/\n/.test(raw)) state.multiline = true;
  },

  ThisExpression(node, state) {
    state.commands.push(ref`children[]`, KW`this`);
  },

  ThrowStatement(node, state) {
    state.commands.push(ref`children[]`, KW`throw`, ref`#`, WS` `);
    if (node.argument) handle(node.argument, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  TryStatement(node, state) {
    state.commands.push(ref`children[]`, KW`try`, ref`#`, WS` `);
    handle(node.block, state);

    if (node.handler) {
      if (node.handler.param) {
        state.commands.push(ref`#`, WS` `, ref`children[]`, KW`catch`, ref`children[]`, PN`(`);
        handle(node.handler.param, state);
        state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
      } else {
        state.commands.push(ref`#`, WS` `, ref`children[]`, KW`catch`, ref`#`, WS` `);
      }

      handle(node.handler.body, state);
    }

    if (node.finalizer) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, KW`finally`, ref`#`, WS` `);
      handle(node.finalizer, state);
    }
  },

  TSAsExpression(node, state) {
    if (node.expression) {
      const needsParens =
        expressionPrcedence[node.expression.type] < expressionPrcedence.TSAsExpression;

      if (needsParens) {
        state.commands.push(ref`children[]`, PN`(`);
        handle(node.expression, state);
        state.commands.push(ref`children[]`, PN`)`);
      } else {
        handle(node.expression, state);
      }
    }
    state.commands.push(ref`#`, WS` `, ref`children[]`, KW`as`, ref`children[]`, PN` `);
    handle_type_annotation(node.typeAnnotation, state);
  },

  TSEnumDeclaration(node, state) {
    state.commands.push(ref`children[]`, KW`enum`, ref`#`, WS` `);
    handle(node.id, state);
    state.commands.push(ref`#`, WS` `, ref`children[]`, PN`{`, indent, newline);
    list(node.members, state, false, handle_type_annotation);
    state.commands.push(dedent, newline, ref`children[]`, PN`}`, newline);
  },

  TSNonNullExpression(node, state) {
    handle(node.expression, state);
    state.commands.push(ref`children[]`, PN`!`);
  },

  TSInterfaceBody(node, state) {
    list(node.body, state, false, handle_type_annotation, [ref`statementTerminatorToken`, PN`;`]);
  },

  TSInterfaceDeclaration(node, state) {
    state.commands.push(ref`children[]`, KW`interface`, ref`#`, WS` `);
    handle(node.id, state);
    if (node.typeParameters) handle_type_annotation(node.typeParameters, state);
    if (node.extends) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, KW`extends`, ref`#`, WS` `);
      list(node.extends, state, false, handle_type_annotation);
    }
    state.commands.push(ref`#`, WS` `, ref`children[]`, PN`{`);
    handle(node.body, state);
    state.commands.push(ref`children[]`, PN`}`);
  },

  TSSatisfiesExpression(node, state) {
    if (node.expression) {
      const needsParens =
        expressionPrcedence[node.expression.type] < expressionPrcedence.TSSatisfiesExpression;

      if (needsParens) {
        state.commands.push(ref`children[]`, PN`(`);
        handle(node.expression, state);
        state.commands.push(ref`children[]`, PN`)`);
      } else {
        handle(node.expression, state);
      }
    }
    state.commands.push(ref`#`, WS` `, ref`children[]`, KW`satisfies`, ref`#`, WS` `);
    handle_type_annotation(node.typeAnnotation, state);
  },

  TSTypeAliasDeclaration(node, state) {
    state.commands.push(ref`children[]`, KW`type`, ref`#`, WS` `);
    handle(node.id, state);
    if (node.typeParameters) handle_type_annotation(node.typeParameters, state);
    state.commands.push(ref`#`, WS` `, ref`children[]`, PN`=`, ref`#`, WS` `);
    handle_type_annotation(node.typeAnnotation, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  TSQualifiedName(node, state) {
    handle(node.left, state);
    state.commands.push(ref`children[]`, PN`.`);
    handle(node.right, state);
  },

  UnaryExpression(node, state) {
    state.commands.push(ref`children[]`, PN(node.operator));

    if (node.operator.length > 1) {
      state.commands.push(ref`#`, WS` `);
    }

    if (expressionPrcedence[node.argument.type] < expressionPrcedence.UnaryExpression) {
      state.commands.push(ref`children[]`, PN`(`);
      handle(node.argument, state);
      state.commands.push(ref`children[]`, PN`)`);
    } else {
      handle(node.argument, state);
    }
  },

  UpdateExpression(node, state) {
    if (node.prefix) {
      state.commands.push(ref`children[]`, PN(node.operator));
      handle(node.argument, state);
    } else {
      handle(node.argument, state);
      state.commands.push(ref`children[]`, PN(node.operator));
    }
  },

  VariableDeclaration(node, state) {
    handle_var_declaration(node, state);
    state.commands.push(ref`statementTerminatorToken`, PN`;`);
  },

  VariableDeclarator(node, state) {
    handle(node.id, state);

    if (node.init) {
      state.commands.push(ref`#`, WS` `, ref`children[]`, PN`=`, ref`#`, WS` `);
      handle(node.init, state);
    }
  },

  WhileStatement(node, state) {
    state.commands.push(ref`children[]`, KW`while`, ref`#`, WS` `, ref`children[]`, PN`(`);
    handle(node.test, state);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
    handle(node.body, state);
  },

  WithStatement(node, state) {
    state.commands.push(ref`children[]`, KW`with`, ref`#`, WS` `, ref`children[]`, PN`(`);
    handle(node.object, state);
    state.commands.push(ref`children[]`, PN`)`, ref`#`, WS` `);
    handle(node.body, state);
  },

  YieldExpression(node, state) {
    if (node.argument) {
      state.commands.push(
        ...(node.delegate
          ? [ref`children[]`, KW`yield`, ref`children[]`, PN`*`, ref`#`, WS` `]
          : [ref`children[]`, KW`yield`, ref`#`, WS` `]),
      );
      handle(node.argument, state);
    } else {
      state.commands.push(
        ...(node.delegate
          ? [ref`children[]`, KW`yield`, ref`children[]`, PN`*`]
          : [ref`children[]`, KW`yield`]),
      );
    }
  },
};
