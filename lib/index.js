import { treeFromStreamSync } from '@bablr/agast-helpers/tree';
import * as t from '@bablr/agast-helpers/shorthand';
import { handle } from './handlers.js';
import { buildAppend, buildSequence, ref, canonicalURL } from './builders.js';

export function cstmlFromESTree(node, opts = {}) {
  if (Array.isArray(node)) {
    return cstmlFromESTree(
      {
        type: 'Program',
        body: node,
        sourceType: 'module',
      },
      opts,
    );
  }

  const state = {
    commands: [],
    comments: [],
    multiline: false,
  };

  state.commands.push(buildAppend(t.doctype({ 'bablr-language': canonicalURL })));
  state.commands.push(buildAppend(t.fragOpen()));
  // state.commands.push(buildAppend(t.ref`.`));
  state.commands.push(buildAppend(t.ref`children[]`));
  state.commands.push(buildAppend(t.buildArrayInitializerTag()));

  handle(node, state);

  state.commands.push(buildAppend(t.fragClose()));

  let tags = [];

  function append(tag) {
    tags.push(tag);
  }

  let newline = '\n';

  function run(command) {
    if (typeof command === 'string') {
      throw new Error();
    }

    switch (command.type) {
      case 'Append':
        append(command.content);
        break;

      case 'Newline':
        append(t.ref`#`);
        append(t.nodeOpen(t.tokenFlags, canonicalURL, 'Whitespace'));
        append(t.lit(newline));
        append(t.nodeClose());
        break;

      case 'Indent':
        newline += '\t';
        break;

      case 'Dedent':
        newline = newline.slice(0, -1);
        break;

      case 'Sequence':
        for (let i = 0; i < command.children.length; i += 1) {
          run(command.children[i]);
        }

        break;

      case 'Comment':
        if (command.comment.type === 'Line') {
          append(`//${command.comment.value}`);
        } else {
          append(`/*${command.comment.value.replace(/\n/g, newline)}*/`);
        }

        break;
    }
  }

  for (let i = 0; i < state.commands.length; i += 1) {
    run(state.commands[i]);
  }

  return treeFromStreamSync(tags);
}
