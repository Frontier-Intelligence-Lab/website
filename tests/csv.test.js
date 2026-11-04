import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited } from '../web/src/app/csv.js';

test('quoted separators, doubled quotes and line breaks stay inside one cell', () => {
  const { rows } = parseDelimited('name,qty\n"ACME, Inc",42\n"say ""hi""",1\n"two\nlines",3\n');
  assert.deepEqual(rows, [['name', 'qty'], ['ACME, Inc', '42'], ['say "hi"', '1'], ['two\nlines', '3']]);
});

test('empty cells, CRLF, tabs and a last line without a newline', () => {
  assert.deepEqual(parseDelimited('a,,c\r\n,2,').rows, [['a', '', 'c'], ['', '2', '']]);
  assert.deepEqual(parseDelimited('x\ty\n1\t"2\t3"', { separator: '\t' }).rows, [['x', 'y'], ['1', '2\t3']]);
});

test('a cut-off record at the end of a partial read is dropped, never guessed', () => {
  const head = 'id,note\n1,"complete"\n2,"this note conti';
  assert.deepEqual(parseDelimited(head, { cut: true }), { rows: [['id', 'note'], ['1', 'complete']], partial: true });
  assert.deepEqual(parseDelimited('a,b\n1,2', { cut: true }).rows, [['a', 'b']]);
  assert.equal(parseDelimited('a\n"open', {}).partial, true, 'an unterminated quote in a whole file is reported, not closed');
});

test('stops after maxRows', () => {
  assert.deepEqual(parseDelimited('1\n2\n3\n4\n', { maxRows: 2 }), { rows: [['1'], ['2']], partial: true });
});
