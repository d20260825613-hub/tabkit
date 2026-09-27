import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellText,
  displayWidth,
  fitCell,
  inferType,
  writeDelimited,
  writeJson,
  writeJsonl,
  writeMarkdown,
  writeRows,
  writeTable,
} from '../src/output.js';

const header = ['id', 'name'];
const rows = [
  { id: 1, name: 'alice' },
  { id: 2, name: 'bob' },
];

test('writeDelimited writes CSV with LF endings and a header', () => {
  const text = writeDelimited(header, rows, { format: 'csv' });
  assert.equal(text, 'id,name\n1,alice\n2,bob\n');
});

test('writeDelimited writes TSV with tabs', () => {
  const text = writeDelimited(header, rows, { format: 'tsv' });
  assert.equal(text, 'id\tname\n1\talice\n2\tbob\n');
});

test('writeDelimited quotes only what needs it', () => {
  const text = writeDelimited(['a', 'b'], [{ a: 'x,y', b: 'plain' }], { format: 'csv' });
  assert.equal(text, 'a,b\n"x,y",plain\n');
});

test('writeDelimited can omit the header', () => {
  assert.equal(writeDelimited(header, rows, { format: 'csv', header: false }), '1,alice\n2,bob\n');
});

test('a null cell is empty, and 0 and false are preserved', () => {
  const text = writeDelimited(['a', 'b', 'c'], [{ a: null, b: 0, c: false }], { format: 'csv' });
  assert.equal(text, 'a,b,c\n,0,false\n');
});

test('a nested value is written as JSON in a delimited cell, not dropped', () => {
  const text = writeDelimited(['id', 'tags'], [{ id: 1, tags: ['a', 'b'] }], { format: 'csv' });
  // The cell is quoted because JSON contains commas — visible rather than lost
  assert.equal(text, 'id,tags\n1,"[""a"",""b""]"\n');
});

test('writeJson emits an array of objects and fills missing keys with null', () => {
  const text = writeJson(['a', 'b'], [{ a: 1 }]);
  assert.deepEqual(JSON.parse(text), [{ a: 1, b: null }]);
});

test('writeJson pretty-prints when asked', () => {
  const compact = writeJson(['a'], [{ a: 1 }]);
  const pretty = writeJson(['a'], [{ a: 1 }], { pretty: true });
  assert.equal(compact.includes('\n  '), false);
  assert.equal(pretty.includes('\n  '), true);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(compact));
});

test('writeJsonl writes one object per line with no array wrapper', () => {
  const text = writeJsonl(['a'], [{ a: 1 }, { a: 2 }]);
  assert.equal(text, '{"a":1}\n{"a":2}\n');
  // Every line must be independently parseable — that is the contract of JSONL
  for (const line of text.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

test('writeJsonl of nothing is empty, not a stray newline', () => {
  assert.equal(writeJsonl(['a'], []), '');
});

test('writeMarkdown escapes pipes and newlines so the table cannot break', () => {
  const text = writeMarkdown(['a', 'b'], [{ a: 'x|y', b: 'line1\nline2' }]);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\| a \| b \|$/);
  assert.match(lines[1], /^\| --- \| --- \|$/);
  assert.equal(lines[2], '| x\\|y | line1<br>line2 |');
  // The body row must have exactly the same number of separators as the header
  assert.equal((lines[2].match(/(?<!\\)\|/g) ?? []).length, 3);
});

test('fitCell pads to a display width and truncates with an ellipsis', () => {
  assert.equal(fitCell('ab', 4), 'ab  ');
  assert.equal(fitCell('abcdef', 4), 'abc…');
  // A newline would break every non-JSON format, so whitespace is collapsed
  assert.equal(fitCell('a\nb', 4), 'a b ');
  assert.equal(fitCell(null, 3), '   ');
  // Padding uses display width, not character count
  assert.equal(fitCell('中文', 6), '中文  ');
});

test('writeTable aligns columns and reports CJK width correctly', () => {
  const text = writeTable(['名', 'v'], [{ 名: '中文', v: 'x' }], { color: false });
  const lines = text.trimEnd().split('\n');
  // The header and the row must be the same display width, which requires
  // counting 中文 as four columns rather than two characters.
  assert.equal(displayWidth(lines[0]), displayWidth(lines[2]));
  assert.match(lines[1], /─/);
});

test('displayWidth counts wide characters as two', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('中a'), 3);
  assert.equal(displayWidth(''), 0);
});

test('writeTable truncates a very long value instead of pushing the table wide', () => {
  const text = writeTable(['a'], [{ a: 'x'.repeat(200) }], { maxWidth: 10 });
  assert.ok(text.includes('…'), 'a truncated cell should be marked');
  for (const line of text.trimEnd().split('\n')) assert.ok(displayWidth(line) < 40, `line too wide: ${line}`);
});

test('writeTable handles an empty row set', () => {
  const text = writeTable(header, [], {});
  assert.match(text, /id/);
  assert.equal(text.trimEnd().split('\n').length, 2, 'header and rule only');
});

test('inferType names the column type', () => {
  assert.equal(inferType(['1', '2', '3']), 'number');
  assert.equal(inferType(['1', 'x']), 'string');
  assert.equal(inferType(['', '', '']), 'empty');
  assert.equal(inferType([null, undefined, '']), 'empty');
  assert.equal(inferType([1.5, '2e3']), 'number');
  assert.equal(inferType([true, false]), 'boolean');
  assert.equal(inferType([{ a: 1 }]), 'json');
});

test('cellText renders objects as JSON and null as empty', () => {
  assert.equal(cellText(null), '');
  assert.equal(cellText(undefined), '');
  assert.equal(cellText(0), '0');
  assert.equal(cellText(['a']), '["a"]');
  assert.equal(cellText({ a: 1 }), '{"a":1}');
});

test('writeRows dispatches to every format', () => {
  assert.match(writeRows(header, rows, { format: 'csv' }), /^id,name/);
  assert.match(writeRows(header, rows, { format: 'tsv' }), /^id\tname/);
  assert.equal(JSON.parse(writeRows(header, rows, { format: 'json' })).length, 2);
  assert.match(writeRows(header, rows, { format: 'jsonl' }), /^\{"id":1/);
  assert.match(writeRows(header, rows, { format: 'markdown' }), /^\| id \| name \|/);
  assert.match(writeRows(header, rows, { format: 'table' }), /id/);
});

test('writeRows falls back to a table for an unknown format', () => {
  assert.match(writeRows(header, rows, { format: 'nonsense' }), /id/);
});

test('a value containing every awkward character survives a CSV round trip', () => {
  const nasty = 'comma, quote" newline\n tab\t pipe| unicode中文';
  const text = writeDelimited(['v'], [{ v: nasty }], { format: 'csv' });
  // Re-read with the parser rather than eyeballing the escaping
  return import('../src/csv.js').then(({ parseCsv }) => {
    const parsed = parseCsv(text);
    assert.equal(parsed.rows[0].v, nasty);
  });
});
