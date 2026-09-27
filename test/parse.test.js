import assert from 'node:assert/strict';
import test from 'node:test';

import { VALUE_COLUMN, columnsFor, detectFormat, parseJson, parseJsonl, readTable, rowsFromValues } from '../src/parse.js';

test('detectFormat recognises the declared formats', () => {
  assert.equal(detectFormat('a,b\n1,2\n').format, 'csv');
  assert.equal(detectFormat('a\tb\n1\t2\n').format, 'tsv');
  assert.equal(detectFormat('{"a": 1}').format, 'json');
  assert.equal(detectFormat('[{"a": 1}]').format, 'json');
  assert.equal(detectFormat('{"a": 1}\n{"a": 2}\n').format, 'jsonl');
});

test('a semicolon-separated first line is detected with its delimiter', () => {
  const detected = detectFormat('a;b;c\n1;2;3\n');
  assert.equal(detected.format, 'csv');
  assert.equal(detected.delimiter, ';');
});

test('the file extension overrides content sniffing', () => {
  assert.equal(detectFormat('a,b\n1,2\n', { filename: 'data.tsv' }).format, 'tsv');
  assert.equal(detectFormat('a,b\n1,2\n', { filename: 'data.json' }).format, 'json');
  assert.equal(detectFormat('whatever', { filename: 'x.ndjson' }).format, 'jsonl');
});

test('a single line of JSON is not mistaken for JSONL', () => {
  // Both are plausible; the object form is far more common in a .json file and
  // the distinction matters because JSONL output has one object per line.
  assert.equal(detectFormat('{"a": 1}').format, 'json');
});

test('parseJson reads an array of objects', () => {
  const { header, rows } = parseJson('[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
  assert.deepEqual(header, ['id', 'name']);
  assert.deepEqual(rows[1], { id: 2, name: 'b' });
});

test('parseJson collects columns across objects that do not share keys', () => {
  const { header, rows } = parseJson('[{"a":1},{"b":2},{"a":3,"c":4}]');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows[0], { a: 1, b: null, c: null });
  assert.deepEqual(rows[1], { a: null, b: 2, c: null });
  assert.deepEqual(rows[2], { a: 3, b: null, c: 4 });
});

test('parseJson unwraps a single-key object holding an array', () => {
  // { "data": [...] } is the shape of most API exports; reading it as one row
  // with a giant array column is never what the user wants.
  const { header, rows, unwrapped } = parseJson('{"data":[{"id":1},{"id":2}]}');
  assert.equal(unwrapped, 'data');
  assert.deepEqual(header, ['id']);
  assert.equal(rows.length, 2);
});

test('parseJson does not unwrap when the object holds other keys too', () => {
  // With a sibling "meta" key there is no way to know the array was meant, and
  // guessing would silently drop the metadata.
  const { header, rows, unwrapped } = parseJson('{"data":[{"id":1}],"meta":{"page":1}}');
  assert.equal(unwrapped, undefined);
  assert.deepEqual(header, ['data', 'meta']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].data, [{ id: 1 }]);
});

test('parseJson reads a bare object as one row', () => {
  const { header, rows } = parseJson('{"id":1,"tags":["a","b"]}');
  assert.deepEqual(header, ['id', 'tags']);
  assert.deepEqual(rows[0].tags, ['a', 'b']);
});

test('parseJson reads an array of scalars into a value column', () => {
  const { header, rows } = parseJson('[1,2,3]');
  assert.deepEqual(header, [VALUE_COLUMN]);
  assert.deepEqual(rows.map((r) => r[VALUE_COLUMN]), [1, 2, 3]);
});

test('parseJson keeps a mixed array usable', () => {
  const { header, rows } = parseJson('[{"a":1},2]');
  assert.deepEqual(header, ['a', VALUE_COLUMN]);
  assert.equal(rows[0].a, 1);
  assert.equal(rows[1][VALUE_COLUMN], 2);
});

test('parseJson reports invalid JSON with the parser message', () => {
  assert.throws(() => parseJson('{oops}'), /invalid JSON/);
});

test('parseJsonl reads one object per line and skips blanks', () => {
  const { header, rows } = parseJsonl('{"a":1}\n\n{"a":2}\n{"a":3}\n');
  assert.deepEqual(header, ['a']);
  assert.equal(rows.length, 3);
});

test('parseJsonl collects a malformed line instead of aborting', () => {
  const { rows, errors } = parseJsonl('{"a":1}\nnot json\n{"a":3}\n', { onError: 'collect' });
  assert.equal(rows.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line 2/);
});

test('parseJsonl throws on a malformed line when asked to', () => {
  assert.throws(() => parseJsonl('{"a":1}\nnot json\n', { onError: 'throw' }), /line 2/);
});

test('rowsFromValues ignores array values when choosing columns', () => {
  const header = columnsFor([{ a: 1 }, [1, 2, 3], { b: 2 }]);
  assert.deepEqual(header, ['a', 'b']);
});

test('readTable detects and parses in one call, and reports what it did', () => {
  const table = readTable('id,name\n1,alice\n');
  assert.equal(table.format, 'csv');
  assert.deepEqual(table.header, ['id', 'name']);
  assert.equal(table.rows.length, 1);
  assert.equal(table.meta.columns, 2);
  assert.equal(table.meta.records, 1);
  assert.match(table.detection.reason, /comma/);
});

test('readTable honours an explicit format over detection', () => {
  const table = readTable('a\tb\n1\t2\n', { format: 'csv', delimiter: '\t' });
  assert.equal(table.format, 'csv');
  assert.deepEqual(table.header, ['a', 'b']);
});

test('readTable passes header and emptyAs through to the CSV reader', () => {
  const table = readTable('1,a\n2,\n', { format: 'csv', header: false, emptyAs: 'null' });
  assert.deepEqual(table.header, ['column1', 'column2']);
  assert.equal(table.rows[1].column2, null);
});

test('readTable caps rows across every format', () => {
  assert.equal(readTable('a\n1\n2\n3\n', { format: 'csv', maxRows: 2 }).rows.length, 2);
  assert.equal(readTable('[1,2,3,4]', { format: 'json', maxRows: 2 }).rows.length, 2);
  assert.equal(readTable('{"a":1}\n{"a":2}\n{"a":3}\n', { format: 'jsonl', maxRows: 1 }).rows.length, 1);
});
