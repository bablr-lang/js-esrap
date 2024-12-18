# @bablr/js-esrap

A utility for converting ESTree ASTs into CSTML CSTs

## Usage

```js
import { parse } from '@babel/parse'; // or your favorite ESTree-compliant parser
import { printSource } from '@bablr/agast-helpers/tree';
import { cstmlFromESTree } from '@bablr/js-esrap';

const source = '1 + 2';

const ast = parse(source);

const cst = cstmlFromESTree(ast);

printSource(cst);
```
