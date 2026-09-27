import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareCells,
  filterRows,
  flattenColumns,
  limitRows,
  profileTable,
  renameColumns,
  selectColumns,
  shapeTable,
  sortRows,
  uniqueRows,
} from '../src/shape.js';
import { compileFilter } from '../src/query.js';

const header = ['id', 'name', 'price'];
const rows = [
  { id: '1', name: 'bob', price: '10' },
  { id: '2', name: 'alice', price: '9' },
  { id: '3', name: 'carol', price: '' },
];

test('selectColumns keeps the requested order and reports unknown names', () => {
  const result = selectColumns(header, rows, ['price', 'id']);
  assert.deepEqual(result.header, ['price', 'id']);
  assert.deepEqual(result.rows[0], { price: '10', id: '1' });

  const missing = selectColumns(header, rows, ['id', 'nope']);
  assert.deepEqual(missing.header, ['id']);
  assert.deepEqual(missing.missing, ['nope']);
});

test('renameColumns renames and does not overwrite a collision', () => {
  const result = renameColumns(header, rows, ['price=name']);
  // Renaming price onto an existing "name" would drop a column, so the duplicate
  // gets a suffix instead.
  assert.deepEqual(result.header, ['id', 'name', 'name_2']);
  assert.equal(result.rows[0].name, 'bob');
  assert.equal(result.rows[0].name_2, '10');
});

test('renameColumns reports an unknown source column', () => {
  const result = renameColumns(header, rows, ['nope=x']);
  assert.deepEqual(result.unknown, ['nope']);
  assert.deepEqual(result.header, header);
});

test('filterRows keeps only the matching rows', () => {
  const result = filterRows(header, rows, compileFilter('price > 9'));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, 'bob');
  assert.deepEqual(result.header, header);
});

test('sortRows sorts numbers numerically and blanks last', () => {
  const ascending = sortRows(header, rows, ['price']);
  assert.deepEqual(ascending.rows.map((r) => r.name), ['alice', 'bob', 'carol'], 'blank sorts last going up');

  const descending = sortRows(header, rows, ['-price']);
  assert.deepEqual(descending.rows.map((r) => r.name), ['bob', 'alice', 'carol'], 'blank still sorts last going down');
});

test('sortRows sorts text with numeric collation', () => {
  const data = ['item10', 'item2', 'item1'].map((name) => ({ name }));
  const sorted = sortRows(['name'], data, ['name']);
  assert.deepEqual(sorted.rows.map((r) => r.name), ['item1', 'item2', 'item10']);
});

test('sortRows is stable, so equal rows keep their input order', () => {
  const data = [
    { k: 'a', n: '1' },
    { k: 'a', n: '2' },
    { k: 'a', n: '3' },
  ];
  const sorted = sortRows(['k', 'n'], data, ['k']);
  assert.deepEqual(sorted.rows.map((r) => r.n), ['1', '2', '3']);
});

test('sortRows can sort by several keys with mixed directions', () => {
  const data = [
    { g: 'a', v: '2' },
    { g: 'b', v: '1' },
    { g: 'a', v: '1' },
  ];
  const sorted = sortRows(['g', 'v'], data, ['g', '-v']);
  assert.deepEqual(
    sorted.rows.map((r) => `${r.g}${r.v}`),
    ['a2', 'a1', 'b1'],
  );
});

test('sortRows reports an unknown column and leaves the order alone', () => {
  const result = sortRows(header, rows, ['nope']);
  assert.deepEqual(result.missing, ['nope']);
  assert.deepEqual(result.rows.map((r) => r.id), ['1', '2', '3']);
});

test('compareCells treats blanks as last whichever side they are on', () => {
  assert.equal(compareCells('', 'a'), 1);
  assert.equal(compareCells('a', ''), -1);
  assert.equal(compareCells('', ''), 0);
  assert.equal(compareCells(null, undefined), 0);
});

test('uniqueRows removes duplicates and reports how many went', () => {
  const data = [
    { id: '1', name: 'a' },
    { id: '1', name: 'a' },
    { id: '2', name: 'b' },
  ];
  const result = uniqueRows(['id', 'name'], data, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.removed, 1);
});

test('uniqueRows can compare on a subset of columns, keeping the first', () => {
  const data = [
    { id: '1', name: 'a' },
    { id: '1', name: 'b' },
    { id: '2', name: 'c' },
  ];
  const result = uniqueRows(['id', 'name'], data, ['id']);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'a', 'the first of each group is kept');
});

test('limitRows slices', () => {
  assert.equal(limitRows(header, rows, 2).rows.length, 2);
  assert.equal(limitRows(header, rows, 0).rows.length, 0);
  assert.equal(limitRows(header, rows, null).rows.length, 3);
});

test('flattenColumns turns nested values into strings and leaves others alone', () => {
  const data = [{ id: '1', tags: ['a', 'b'], meta: { x: 1 } }];
  const result = flattenColumns(['id', 'tags', 'meta'], data, ['tags', 'meta']);
  assert.equal(result.rows[0].tags, '["a","b"]');
  assert.equal(result.rows[0].meta, '{"x":1}');
  assert.equal(result.rows[0].id, '1');
});

test('shapeTable applies the documented order', () => {
  // where before select, so an expression may name a column the output drops
  const result = shapeTable(header, rows, {
    where: 'price > 9',
    select: 'name',
  });
  assert.deepEqual(result.header, ['name']);
  assert.deepEqual(result.rows.map((r) => r.name), ['bob']);
});

test('shapeTable sorts after filtering and limits last', () => {
  const result = shapeTable(header, rows, { sort: '-price', limit: 2 });
  assert.deepEqual(result.rows.map((r) => r.name), ['bob', 'alice']);
});

test('shapeTable dedups before projecting', () => {
  const data = [
    { id: '1', name: 'a' },
    { id: '1', name: 'b' },
  ];
  // unique on all columns keeps both; then select projects to name
  const result = shapeTable(['id', 'name'], data, { unique: true, select: 'name' });
  assert.deepEqual(result.header, ['name']);
  assert.equal(result.rows.length, 2);
});

test('shapeTable returns an error for an unparseable expression', () => {
  const result = shapeTable(header, rows, { where: 'price >' });
  assert.match(result.error, /cannot understand the expression/);
});

test('shapeTable warns about an unknown column in a filter', () => {
  const result = shapeTable(header, rows, { where: 'nosuch = 1' });
  assert.equal(result.rows.length, 0);
  assert.ok(result.notes.some((n) => /unknown column/.test(n)), result.notes.join('; '));
});

test('shapeTable errors when select matches nothing at all', () => {
  const result = shapeTable(header, rows, { select: 'nope' });
  assert.match(result.error, /matched no columns/);
});

test('shapeTable collects notes for every option that had to be ignored', () => {
  const result = shapeTable(header, rows, {
    rename: ['nope=x'],
    sort: 'alsonope',
    select: 'id,nope',
  });
  assert.ok(result.notes.some((n) => /--rename/.test(n)));
  assert.ok(result.notes.some((n) => /--sort/.test(n)));
  assert.ok(result.notes.some((n) => /--select/.test(n)));
});

test('shapeTable does not mutate its input', () => {
  const original = rows.map((row) => ({ ...row }));
  shapeTable(header, rows, { sort: '-price', where: 'price > 0', rename: ['id=identifier'] });
  assert.deepEqual(rows, original, 'the caller\'s rows must be untouched');
});

test('profileTable describes columns, blanks and nesting', () => {
  const data = [
    { id: '1', price: '10', tags: ['a'] },
    { id: '2', price: '', tags: [] },
  ];
  const profile = profileTable(['id', 'price', 'tags', 'empty_column'], data);
  assert.equal(profile.rows, 2);

  const id = profile.columns.find((c) => c.name === 'id');
  assert.equal(id.type, 'number');
  assert.equal(id.missing, 0);

  const price = profile.columns.find((c) => c.name === 'price');
  assert.equal(price.missing, 1);
  assert.equal(price.min, 10);
  assert.equal(price.max, 10);

  assert.deepEqual(profile.emptyColumns, ['empty_column']);
  assert.deepEqual(profile.nestedColumns, ['tags']);
});
