import { parse } from 'meriyah';
import { expect } from 'expect';
import { cstmlFromESTree } from '@bablr/js-esrap';
import { readFileSync } from 'fs';

const source = readFileSync('../lib/handlers.js', 'utf8');

describe('parsing own source code', () => {
  it('parses as CSTML', () => {
    expect(cstmlFromESTree(parse(source, { module: true }))).toEqual({});
  });
});
