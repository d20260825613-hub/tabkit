import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCsv, quoteField, toCsv, uniqueNames } from '../src/csv.js';

test('parseCsv reads a simple table with a header', () => {
  const { header, rows, errors } = parseCsv('id,name\n1,alice\n2,bob\n');
  assert.deepEqual(header, ['id', 'name']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: '1', name: 'alice' });
  assert.deepEqual(rows[1], { id: '2', name: 'bob' });
  assert.deepEqual(errors, []);
});

test('a quoted field may contain the delimiter', () => {
  const { rows } = parseCsv('name,city\n"Smith, John",Berlin\n');
  assert.equal(rows[0].name, 'Smith, John');
  assert.equal(rows[0].city, 'Berlin');
});

test('a quoted field may contain newlines', () => {
  const { header, rows } = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');
  assert.deepEqual(header, ['id', 'note']);
  assert.equal(rows[0].note, 'line one\nline two');
  assert.equal(rows[1].note, 'plain');
});

test('a doubled quote inside a quoted field is one quote', () => {
  const { rows } = parseCsv('quote\n"she said ""hi"""\n');
  assert.equal(rows[0].quote, 'she said "hi"');
});

test('CRLF, LF and a missing final newline all parse the same', () => {
  const expected = [
    { id: '1', name: 'a' },
    { id: '2', name: 'b' },
  ];
  for (const text of ['id,name\r\n1,a\r\n2,b\r\n', 'id,name\n1,a\n2,b\n', 'id,name\r\n1,a\r\n2,b']) {
    const { rows } = parseCsv(text);
    assert.deepEqual(rows, expected, `failed for ${JSON.stringify(text)}`);
  }
});

test('a UTF-8 BOM does not become part of the first column name', () => {
  const { header } = parseCsv('\uFEFFid,name\n1,a\n');
  assert.deepEqual(header, ['id', 'name']);
});

test('a semicolon delimiter works when asked for', () => {
  const { header, rows } = parseCsv('a;b\n1;2\n', { delimiter: ';' });
  assert.deepEqual(header, ['a', 'b']);
  assert.equal(rows[0].b, '2');
});

test('empty fields are empty strings by default and null when asked', () => {
  const asString = parseCsv('a,b,c\n1,,3\n');
  assert.equal(asString.rows[0].b, '');

  const asNull = parseCsv('a,b,c\n1,,3\n', { emptyAs: 'null' });
  assert.equal(asNull.rows[0].b, null);
});

test('an explicitly quoted empty field stays an empty string even with emptyAs null', () => {
  // "" means "the value is an empty string"; a bare empty field means "no
  // value". Collapsing the two is how a missing value becomes indistinguishable
  // from a deliberately blank one.
  const { rows } = parseCsv('a,b\n1,""\n', { emptyAs: 'null' });
  assert.equal(rows[0].b, '');
});

test('header: false names columns by position', () => {
  const { header, rows } = parseCsv('1,a\n2,b\n', { header: false });
  assert.deepEqual(header, ['column1', 'column2']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { column1: '1', column2: 'a' });
});

test('blank lines are skipped', () => {
  const { rows } = parseCsv('a,b\n1,2\n\n\n3,4\n');
  assert.equal(rows.length, 2);
});

test('a ragged row is padded and reported instead of dropped', () => {
  const { header, rows, errors } = parseCsv('a,b,c\n1,2\n');
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].c, '');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /wrong number of fields/);
  assert.match(errors[0], /line 2/);
});

test('a row with too many fields is reported and the extra values are kept as unnamed', () => {
  const { header, rows, errors } = parseCsv('a,b\n1,2,3\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].b, '2');
  assert.equal(errors.length, 1);
});

test('an unterminated quote is reported rather than silently swallowing the file', () => {
  const result = parseCsv('a,b\n1,"never closed\n2,x\n');
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unterminated quoted field/);
});

test('maxRows stops early', () => {
  const { rows } = parseCsv('a\n1\n2\n3\n4\n', { maxRows: 2 });
  assert.equal(rows.length, 2);
});

test('uniqueNames fixes blank and duplicate column names', () => {
  assert.deepEqual(uniqueNames(['a', 'a', '', 'b']), ['a', 'a_2', 'column3', 'b']);
  assert.deepEqual(uniqueNames(['  ', 'x']), ['column1', 'x']);
  // A generated name that collides must keep walking until it is free
  assert.deepEqual(uniqueNames(['a', 'a', 'a']), ['a', 'a_2', 'a_3']);
});

test('duplicate column names do not lose data', () => {
  const { header, rows } = parseCsv('id,id\n1,2\n');
  assert.deepEqual(header, ['id', 'id_2']);
  assert.deepEqual(rows[0], { id: '1', id_2: '2' });
});

test('a single column file parses', () => {
  const { header, rows } = parseCsv('name\nalice\nbob\n');
  assert.deepEqual(header, ['name']);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['alice', 'bob'],
  );
});

test('quoted fields survive a round trip through toCsv', () => {
  const header = ['name', 'note'];
  const rows = [
    { name: 'Smith, John', note: 'has "quotes"' },
    { name: 'plain', note: 'line one\nline two' },
  ];
  const text = toCsv(header, rows);
  const reparsed = parseCsv(text);
  assert.deepEqual(reparsed.header, header);
  assert.deepEqual(reparsed.rows, rows);
});

test('toCsv writes a null as an empty field and keeps 0 and false', () => {
  const text = toCsv(['a', 'b', 'c'], [{ a: null, b: 0, c: false }]);
  assert.equal(text, 'a,b,c\n,0,false\n');
});

test('quoteField only quotes when it has to', () => {
  assert.equal(quoteField('plain'), 'plain');
  assert.equal(quoteField('has,comma'), '"has,comma"');
  assert.equal(quoteField('has"quote'), '"has""quote"');
  assert.equal(quoteField('has\nnewline'), '"has\nnewline"');
  assert.equal(quoteField(null), '');
  assert.equal(quoteField(0), '0');
});

test('toCsv can omit the header row', () => {
  const text = toCsv(['a', 'b'], [{ a: '1', b: '2' }], { header: false });
  assert.equal(text, '1,2\n');
});

test('toCsv uses LF endings regardless of platform', () => {
  const text = toCsv(['a'], [{ a: '1' }]);
  assert.equal(text.includes('\r'), false);
  assert.equal(text, 'a\n1\n');
});

test('parseCsv rejects a bad option instead of guessing', () => {
  assert.throws(() => parseCsv('a\n1\n', { delimiter: ';;' }), /single character/);
  assert.throws(() => parseCsv('a\n1\n', { emptyAs: 'maybe' }), /emptyAs must be/);
});
