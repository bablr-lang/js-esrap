# @bablr/js-esrap

A utility for converting ESTree ASTs into CSTML CSTs

## Usage

```js
import { parse } from '@babel/parse'; // or your favorite ESTree-compliant parser
import { printSource } from '@bablr/agast-helpers/tree';

printSource(cstmlFromESTree(parse(text)));
```
