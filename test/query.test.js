import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compare,
  compileFilter,
  evaluateExpression,
  parseExpression,
  referencedColumns,
  tokenize,
  toNumber,
  truthy,
} from '../src/query.js';

const row = { id: '3', name: 'Alice', price: '19.99', qty: '0', status: 'open', blank: '', tags: ['a', 'b'], note: null };

const matches = (expression, candidate = row) => compileFilter(expression)(candidate);

test('tokenize handles strings, numbers, names and operators', () => {
  const tokens = tokenize('price > 10 and name = "Ali ce"');
  assert.deepEqual(
    tokens.map((t) => t.type),
    ['identifier', 'gt', 'number', 'and', 'identifier', 'eq', 'string', 'eof'],
  );
  assert.equal(tokens[2].value, 10);
  assert.equal(tokens[6].value, 'Ali ce');
});

test('tokenize treats single and double quotes the same and unescapes \\n', () => {
  assert.equal(tokenize("x = 'a'")[2].value, 'a');
  assert.equal(tokenize('x = "a\\nb"')[2].value, 'a\nb');
  // A doubled quote inside a string is a literal quote
  assert.equal(tokenize('x = "a""b"')[2].value, 'a"b');
});

test('tokenize rejects an unterminated string instead of inventing one', () => {
  assert.throws(() => tokenize('name = "never closed'), /unterminated string/);
});

test('tokenize rejects an unexpected character with its position', () => {
  assert.throws(() => tokenize('a ? b'), /unexpected character/);
});

test('parseExpression builds the tree with the documented precedence', () => {
  // or is loosest, then and, then comparison
  const ast = parseExpression('a = 1 or b = 2 and c = 3');
  assert.equal(ast.type, 'or');
  assert.equal(ast.left.type, 'compare');
  assert.equal(ast.right.type, 'and');
});

test('parseExpression treats not and ! the same', () => {
  assert.equal(parseExpression('not a').type, 'not');
  assert.equal(parseExpression('!a').type, 'not');
});

test('parseExpression reads a list literal', () => {
  const ast = parseExpression('status in ["open", "closed"]');
  assert.equal(ast.operator, 'in');
  assert.equal(ast.right.type, 'list');
  assert.deepEqual(ast.right.items.map((item) => item.value), ['open', 'closed']);
});

test('bracketName reaches a column whose name has spaces', () => {
  assert.equal(matches('bracketName("first name") = "Ada"', { 'first name': 'Ada' }), true);
});

test('parseExpression reports a syntax error rather than guessing', () => {
  assert.throws(() => parseExpression('a = '), /unexpected eof/);
  assert.throws(() => parseExpression('(a = 1'), /expected \)/);
  assert.throws(() => parseExpression('a = 1)'), /trailing input/);
});

test('equality compares numerically when both sides look numeric', () => {
  // CSV gives strings; `price = 19.99` must still match
  assert.equal(matches('price = 19.99'), true);
  assert.equal(matches('price = "19.99"'), true);
  assert.equal(matches('id = 3'), true);
  assert.equal(matches('id = "3"'), true);
});

test('relational operators compare numerically, not lexically', () => {
  // The whole reason toNumber exists: "9" < "10" is false as text
  assert.equal(matches('id > 10', { id: '9' }), false);
  assert.equal(matches('id < 10', { id: '9' }), true);
  assert.equal(matches('id >= 3'), true);
  assert.equal(matches('id <= 3'), true);
});

test('an empty field is not zero', () => {
  // Treating "" as 0 would make `price > 0` match rows with no price at all
  assert.equal(matches('price > 0', { price: '' }), false);
  assert.equal(matches('price = 0', { price: '' }), false);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('  '), null);
  assert.equal(toNumber('0'), 0);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber('1e3'), 1000);
});

test('null equals null but not an empty string', () => {
  assert.equal(matches('note = null'), true);
  assert.equal(matches('blank = null'), false);
  assert.equal(matches('blank = ""'), true);
});

test('and and or short-circuit', () => {
  // If `and` did not short-circuit, this would divide by zero on qty = 0
  assert.equal(matches('qty != 0 and 10 / qty > 1'), false);
  assert.equal(matches('qty = 0 or 10 / qty > 1'), true);
});

test('arithmetic works on numeric strings and yields null on nonsense', () => {
  assert.equal(matches('price + 1 > 20'), true);
  assert.equal(matches('id * 2 = 6'), true);
  assert.equal(matches('id % 2 = 1'), true);
  // evaluateExpression gives the value; compileFilter gives the truthiness
  assert.equal(evaluateExpression('price - 1', row), 18.99);
  assert.equal(evaluateExpression('name - 1', row), null, 'text minus a number is null, not NaN');
  assert.equal(evaluateExpression('1 / qty', row), null, 'division by zero is null, not Infinity');
  assert.equal(evaluateExpression('name + "!"', row), 'Alice!', 'plus concatenates when a side is text');
  assert.equal(evaluateExpression('price + 1', row), 20.99);
  assert.equal(matches('qty = 0 or 1 / qty > 0'), true, 'or short-circuits past the division');
});

test('string operators work as documented', () => {
  assert.equal(matches('name contains "lic"'), true);
  assert.equal(matches('name contains "zzz"'), false);
  assert.equal(matches('name startswith "Al"'), true);
  assert.equal(matches('name endswith "ce"'), true);
  assert.equal(matches('name matches "^A.*e$"'), true);
  assert.equal(matches('name matches "^a"'), false, 'regex is case-sensitive by default');
});

test('contains searches a list value', () => {
  assert.equal(matches('tags contains "a"'), true);
  assert.equal(matches('tags contains "z"'), false);
});

test('in works with a list literal', () => {
  assert.equal(matches('status in ["open", "closed"]'), true);
  assert.equal(matches('status in ["closed"]'), false);
});

test('in falls back to a substring test against a plain string', () => {
  assert.equal(matches('status in "open,closed"'), true);
  assert.equal(matches('status in "other"'), false);
});

test('an invalid regular expression is reported, not swallowed', () => {
  assert.throws(() => matches('name matches "("'), /invalid regular expression/);
});

test('an unknown column is null, so a typo selects nothing', () => {
  assert.equal(matches('nosuch = 1'), false);
  assert.equal(matches('nosuch = null'), true);
  assert.deepEqual(referencedColumns(parseExpression('a = 1 and b > 2')), ['a', 'b']);
});

test('truthy follows the documented rules, not JavaScript\'s', () => {
  assert.equal(truthy(0), false, '0 is false here');
  assert.equal(truthy('0'), true, 'the string "0" is a value');
  assert.equal(truthy(''), false);
  assert.equal(truthy(null), false);
  assert.equal(truthy([]), false);
  assert.equal(truthy([1]), true);
  assert.equal(truthy(NaN), false);
  assert.equal(truthy('false'), true);
});

test('a bare column is a valid filter', () => {
  assert.equal(matches('status'), true, 'a non-empty string is truthy');
  // "0" is the string "0", which is a value, so it is truthy. Only the number 0
  // and the empty string are falsy — see the truthy() test below. This is the
  // one place the language deliberately differs from loose JavaScript.
  assert.equal(matches('qty'), true);
  assert.equal(matches('not qty'), false);
  assert.equal(matches('blank'), false, 'an empty string is falsy');
  assert.equal(matches('!blank'), true);
  assert.equal(matches('note'), false, 'null is falsy');
  assert.equal(matches('nope'), false, 'a missing column is null, which is falsy');
  assert.equal(matches('not nope'), true);
});

test('compare() is usable directly', () => {
  assert.equal(compare('gt', '10', '9'), true);
  assert.equal(compare('eq', 1, '1'), true);
  assert.equal(compare('contains', 'hello', 'ell'), true);
  assert.equal(compare('lte', 'b', 'a'), false);
});

test('a filter never throws on a row missing every column', () => {
  assert.equal(compileFilter('a = 1 and b contains "x"')({}), false);
  assert.equal(compileFilter('a + 1 > 0')({}), false);
});
