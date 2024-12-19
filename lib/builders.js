import { buildFilledGapFunction } from '@bablr/agast-helpers/template';
import * as t from '@bablr/agast-helpers/shorthand';
import { buildLiteralTag as agastBuildLiteralTag } from '@bablr/agast-helpers/builders';
import { treeFromStreamSync as treeFromStream } from '@bablr/agast-helpers/tree';
import { buildToken } from '@bablr/agast-vm-helpers/builders';
import { concat } from '@bablr/agast-vm-helpers/iterable';

export const canonicalURL = 'https://bablr.org/languages/universe/estree-javascript';

export let l = canonicalURL;
let { isArray } = Array;
const isString = (val) => typeof val === 'string';

const escapables = {
  '\r': 'r',
  '\n': 'n',
  '\t': 't',
  '\0': '0',
};

const buildAppendTokenCommand = (tokenType) => (tokenValue) => {
  return buildSequence(
    buildAppend(t.nodeOpen(t.tokenFlags, canonicalURL, tokenType)),
    buildAppend(t.lit(tokenValue)),
    buildAppend(t.nodeClose()),
  );
};

export function buildAppend(content) {
  return { type: 'Append', content };
}

export function buildSequence(...children) {
  return { type: 'Sequence', children };
}

export const seq = buildSequence;

export const ref = (...args) => buildAppend(t.ref(...args));

export let PN = buildAppendTokenCommand('PunctuatorToken'),
  WS = buildAppendTokenCommand('WhitespaceToken'),
  KW = buildAppendTokenCommand('KeywordToken'),
  ID = buildAppendTokenCommand('IdentifierToken'),
  LIT = buildAppendTokenCommand('LiteralToken');

export const buildKeyword = (name) => {
  return buildToken(l, 'Keyword', name);
};

export const buildString = (value) => {
  const pieces = isArray(value) ? value : [value];
  let lit = '';

  if (pieces.length === 1 && pieces[0] === "'") {
    const expressions = [];
    const gap = buildFilledGapFunction(expressions);
    return treeFromStream(
      [
        t.nodeOpen(t.nodeFlags, l, 'String'),
        t.ref`openToken`,
        gap(buildToken(l, 'Punctuator', '"')),
        t.ref`content`,
        gap(buildToken(l, 'StringContent', value)),
        t.ref`closeToken`,
        gap(buildToken(l, 'Punctuator', '"')),
        t.nodeClose(),
      ],
      { expressions },
    );
  }

  const expressions = [];
  const gap = buildFilledGapFunction(expressions);

  return treeFromStream(
    (function* () {
      yield t.nodeOpen(t.nodeFlags, l, 'String');
      yield t.ref`openToken`;
      const tok = buildToken(l, 'Punctuator', "'");
      yield gap(tok);
      yield t.ref`content`;
      yield t.nodeOpen(t.tokenFlags, l, 'StringContent');

      for (const piece of pieces) {
        if (isString(piece)) {
          const value = piece;

          for (const chr of value) {
            if (
              chr === '\\' ||
              chr === "'" ||
              chr === '\n' ||
              chr === '\r' ||
              chr === '\t' ||
              chr === '\0' ||
              chr.charCodeAt(0) < 32
            ) {
              if (lit) {
                yield agastBuildLiteralTag(lit);
                lit = '';
              }

              let value;

              if (escapables[chr]) {
                const expressions = [];
                const gap = buildFilledGapFunction(expressions);

                value = treeFromStream(
                  [
                    t.nodeOpen(t.nodeFlags, l, 'EscapeCode'),
                    t.ref`sigilToken`,
                    gap(buildKeyword(escapables[chr])),
                    t.ref`digits[]`,
                    t.arr(),
                    t.nodeClose(),
                  ],
                  { expressions },
                );
              } else if (chr.charCodeAt(0) < 32) {
                const hexDigits = chr.charCodeAt(0).toString(16).padStart(4, '0');
                const expressions = [];
                const gap = buildFilledGapFunction(expressions);

                value = treeFromStream(
                  [
                    t.nodeOpen(t.nodeFlags, l, 'EscapeCode'),
                    t.ref`sigilToken`,
                    gap(buildKeyword('u')),
                    t.ref`digits[]`,
                    t.arr(),
                    [...hexDigits].flatMap((digit) => [t.ref`digits[]`, gap(buildDigit(digit))]),
                    t.nodeClose(),
                  ],
                  { expressions },
                );
              } else {
                value = buildKeyword(chr);
              }

              yield t.ref`@`;
              yield t.nodeOpen(t.nodeFlags, l, 'EscapeSequence', { cooked: chr });
              yield t.ref`escape`;
              yield gap(buildToken(l, 'Punctuator', '\\'));
              yield t.ref`value`;
              yield gap(value);
              yield t.nodeClose();
            } else {
              lit += chr;
            }
          }
        } else {
          yield agastBuildLiteralTag(lit);
          lit = '';

          if (piece == null) {
            throw new Error('not implemented');
          } else if (isString(piece.type)) {
            yield piece;
          } else {
            throw new Error();
          }
        }
      }

      if (lit) yield agastBuildLiteralTag(lit);
      lit = '';

      yield t.nodeClose();
      yield t.ref`closeToken`;
      yield gap(buildToken(l, 'Punctuator', "'"));
      yield t.nodeClose();
    })(),
    { expressions },
  );
};

export const buildNumber = (value) => {
  if (Number.isFinite(value)) {
    return buildInteger(value);
  } else {
    return buildInfinity(value);
  }
};

export const buildDigit = (value) => {
  return buildToken(l, 'Digit', value);
};

export const buildInteger = (value, base = 10) => {
  const expressions = [];
  const gap = buildFilledGapFunction(expressions);

  const digits = value.toString(base).split('');

  return treeFromStream(
    concat(
      [t.nodeOpen(t.nodeFlags, l, 'Integer'), t.ref`digits[]`, t.arr()],
      digits.flatMap((digit) => [t.ref`digits[]`, gap(buildDigit(digit))]),
      [t.nodeClose()],
    ),
    { expressions },
  );
};

export const buildInfinity = (value) => {
  let sign;
  if (value === Infinity) {
    sign = '+';
  } else if (value === -Infinity) {
    sign = '-';
  } else {
    throw new Error();
  }

  const expressions = [];
  const gap = buildFilledGapFunction(expressions);

  return treeFromStream(
    [
      t.nodeOpen(t.nodeFlags, l, 'Infinity'),
      t.ref`sign`,
      gap(buildToken(l, 'Punctuator', sign)),
      t.ref`value`,
      gap(buildToken(l, 'Keyword', 'Infinity')),
      t.nodeClose(),
    ],
    { expressions },
  );
};

export const buildBoolean = (value) => {
  const expressions = [];
  const gap = buildFilledGapFunction(expressions);

  return treeFromStream(
    [
      t.nodeOpen(t.nodeFlags, l, 'Boolean'),
      t.ref`sigilToken`,
      gap(buildToken(l, 'Keyword', value ? 'true' : 'false')),
      t.nodeClose(),
    ],
    { expressions },
  );
};

export const buildNull = () => {
  const expressions = [];
  const gap = buildFilledGapFunction(expressions);

  return treeFromStream(
    [
      t.nodeOpen(t.nodeFlags, l, 'Null'),
      t.ref`sigilToken`,
      gap(buildToken(l, 'Keyword', 'null')),
      t.nodeClose(),
    ],
    { expressions },
  );
};
