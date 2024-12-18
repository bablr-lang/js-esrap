import { parse } from 'meriyah';
import { expect } from 'expect';
import { cstmlFromESTree } from '@bablr/js-esrap';
import { readFileSync } from 'fs';
import { URL } from 'node:url';
import { printSource } from '@bablr/agast-helpers/tree';

const rel = (path) => `${new URL('.', import.meta.url).pathname}/${path[0]}`;

const source = readFileSync(rel`../lib/handlers.js`, 'utf8');

describe('parsing own source code', () => {
  it('parses as CSTML', () => {
    expect(printSource(cstmlFromESTree(parse(source, { module: true })))).toEqual(source);
  });
});
