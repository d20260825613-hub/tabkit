/**
 * A small, safe expression language for filtering rows.
 *
 * Why not `eval`, or a JS snippet, or a dependency like jsonata: a filter string
 * is data that arrives with the file, and `eval` on data is remote code
 * execution. There is no sandbox that makes that acceptable in a tool whose job
 * is "look at this file somebody sent me".
 *
 * So this is a real tokenizer plus a recursive-descent parser producing a tree
 * that only this file can evaluate. It supports exactly the operations a filter
 * needs and nothing that can reach the outside world.
 *
 * Grammar (lowest precedence first):
 *   or      := and ( "or" | "||" ) and
 *   and     := not ( "and" | "&&" ) not
 *   not     := ( "not" | "!" ) not | comparison
 *   comparison := sum ( ( "=" | "!=" | "<" | "<=" | ">" | ">="
 *                       | "contains" | "startswith" | "endswith"
 *                       | "matches" | "in" ) sum )?
 *   sum     := product ( ( "+" | "-" ) product )*
 *   product := unary ( ( "*" | "/" | "%" ) unary )*
 *   unary   := "-" unary | primary
 *   primary := number | string | "true" | "false" | "null"
 *            | list | identifier | bracketName | "(" or ")"
 *   list    := "[" ( or ( "," or )* )? "]"
 *
 * Identifiers are column names. A name containing spaces or punctuation is
 * written as `bracketName("column name")`; help says `bracketName` rather than
 * a bare `[...]` because brackets are list literals.
 *
 * Truthiness follows the obvious reading rather than JavaScript's: `0`, `""`,
 * `null`, `false` and an empty list are false; everything else is true. An
 * unknown column evaluates to null rather than throwing, so a filter that names
 * a typo selects nothing and the caller can report it separately.
 */

/** Token kinds produced by the tokenizer. */
const PUNCTUATION = [
  ['<=', 'lte'],
  ['>=', 'gte'],
  ['!=', 'neq'],
  ['==', 'eq'],
  ['&&', 'and'],
  ['||', 'or'],
  ['(', 'lparen'],
  [')', 'rparen'],
  ['[', 'lbracket'],
  [']', 'rbracket'],
  [',', 'comma'],
  ['<', 'lt'],
  ['>', 'gt'],
  ['=', 'eq'],
  ['!', 'not'],
  ['+', 'plus'],
  ['-', 'minus'],
  ['*', 'star'],
  ['/', 'slash'],
  ['%', 'percent'],
];

const WORD_OPERATORS = new Map([
  ['and', 'and'],
  ['or', 'or'],
  ['not', 'not'],
  ['contains', 'contains'],
  ['startswith', 'startswith'],
  ['endswith', 'endswith'],
  ['matches', 'matches'],
  ['in', 'in'],
  ['true', 'true'],
  ['false', 'false'],
  ['null', 'null'],
]);

/**
 * Split an expression into tokens.
 *
 * Throws on an unterminated string, because silently treating the rest of the
 * expression as a string literal produces a filter that matches nothing and
 * looks like a data problem.
 */
export function tokenize(input) {
  const text = String(input ?? '');
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // Quoted string: 'single' or "double"
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      let closed = false;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          // A doubled quote inside a quoted string is one literal quote
          if (text[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      if (!closed) throw new Error(`unterminated string starting at position ${i - value.length - 1}`);
      tokens.push({ type: 'string', value });
      continue;
    }

    // Number, including a leading minus handled by the unary rule
    if (/[0-9]/.test(char)) {
      let raw = '';
      while (i < text.length && /[0-9._]/.test(text[i])) {
        if (text[i] !== '_') raw += text[i];
        i += 1;
      }
      // Scientific notation and decimals
      if (text[i] === 'e' || text[i] === 'E') {
        raw += text[i];
        i += 1;
        if (text[i] === '+' || text[i] === '-') {
          raw += text[i];
          i += 1;
        }
        while (i < text.length && /[0-9]/.test(text[i])) {
          raw += text[i];
          i += 1;
        }
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`not a number: ${raw}`);
      tokens.push({ type: 'number', value });
      continue;
    }

    // Identifier or word operator
    if (/[A-Za-z_\u0080-\uffff]/.test(char)) {
      let raw = '';
      while (i < text.length && /[A-Za-z0-9_\u0080-\uffff]/.test(text[i])) {
        raw += text[i];
        i += 1;
      }
      const keyword = WORD_OPERATORS.get(raw.toLowerCase());
      if (keyword) tokens.push({ type: keyword, value: raw });
      else tokens.push({ type: 'identifier', value: raw });
      continue;
    }

    const punctuation = PUNCTUATION.find(([symbol]) => text.startsWith(symbol, i));
    if (punctuation) {
      tokens.push({ type: punctuation[1], value: punctuation[0] });
      i += punctuation[0].length;
      continue;
    }

    throw new Error(`unexpected character ${JSON.stringify(char)} at position ${i}`);
  }

  tokens.push({ type: 'eof', value: null });
  return tokens;
}

/** Parse an expression into an AST. Throws with a position on a syntax error. */
export function parseExpression(input) {
  const tokens = tokenize(input);
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (type, what) => {
    const token = peek();
    if (token.type !== type) {
      throw new Error(`expected ${what} at token ${position + 1}, found ${token.type}${token.value === null ? '' : ` (${token.value})`}`);
    }
    return next();
  };

  function parseOr() {
    let left = parseAnd();
    while (peek().type === 'or') {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek().type === 'and') {
      next();
      left = { type: 'and', left, right: parseNot() };
    }
    return left;
  }

  function parseNot() {
    if (peek().type === 'not') {
      next();
      return { type: 'not', operand: parseNot() };
    }
    return parseComparison();
  }

  const COMPARISONS = new Set([
    'eq', 'neq', 'lt', 'lte', 'gt', 'gte',
    'contains', 'startswith', 'endswith', 'matches', 'in',
  ]);

  function parseComparison() {
    const left = parseSum();
    if (COMPARISONS.has(peek().type)) {
      const operator = next().type;
      const right = parseSum();
      return { type: 'compare', operator, left, right };
    }
    return left;
  }

  function parseSum() {
    let left = parseProduct();
    while (peek().type === 'plus' || peek().type === 'minus') {
      const operator = next().type;
      left = { type: 'arithmetic', operator, left, right: parseProduct() };
    }
    return left;
  }

  function parseProduct() {
    let left = parseUnary();
    while (peek().type === 'star' || peek().type === 'slash' || peek().type === 'percent') {
      const operator = next().type;
      left = { type: 'arithmetic', operator, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary() {
    if (peek().type === 'minus') {
      next();
      return { type: 'negate', operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = peek();
    switch (token.type) {
      case 'number':
        next();
        return { type: 'literal', value: token.value };
      case 'string':
        next();
        return { type: 'literal', value: token.value };
      case 'true':
        next();
        return { type: 'literal', value: true };
      case 'false':
        next();
        return { type: 'literal', value: false };
      case 'null':
        next();
        return { type: 'literal', value: null };
      case 'identifier':
        next();
        // `bracketName("a column with spaces")` reaches a column the bare
        // identifier syntax cannot express.
        if (token.value.toLowerCase() === 'bracketname' && peek().type === 'lparen') {
          next();
          const inner = peek();
          if (inner.type !== 'string' && inner.type !== 'identifier') {
            throw new Error('bracketName(...) needs a column name');
          }
          next();
          expect('rparen', ')');
          return { type: 'column', name: inner.value };
        }
        return { type: 'column', name: token.value };
      case 'lbracket': {
        // A list literal, e.g. `status in ["open", "closed"]`. Column names are
        // written bare, or as bracketName("...") when they contain spaces.
        next();
        const items = [];
        if (peek().type !== 'rbracket') {
          for (;;) {
            items.push(parseSum());
            if (peek().type === 'comma') {
              next();
              continue;
            }
            break;
          }
        }
        expect('rbracket', ']');
        return { type: 'list', items };
      }
      case 'lparen': {
        next();
        const inner = parseOr();
        expect('rparen', ')');
        return inner;
      }
      default:
        throw new Error(`unexpected ${token.type}${token.value === null ? '' : ` (${token.value})`}`);
    }
  }

  const ast = parseOr();
  if (peek().type !== 'eof') {
    throw new Error(`unexpected trailing input at token ${position + 1}: ${peek().type}`);
  }
  return ast;
}

/**
 * JS truthiness with the surprises removed.
 *
 * `0` and `""` are false here, as in the expression language people expect.
 * An empty list is false. Everything else is true.
 */
export function truthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return !Number.isNaN(value);
  return true;
}

/** Numbers when both sides are numeric, otherwise strings. */
function compareValues(left, right) {
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (leftNumber !== null && rightNumber !== null) return { a: leftNumber, b: rightNumber, numeric: true };
  return { a: left === null || left === undefined ? '' : String(left), b: right === null || right === undefined ? '' : String(right), numeric: false };
}

/** A number, or null when the value is not one. Empty string is not zero. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value).trim();
  if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * Evaluate an expression against one row and return the value.
 *
 * `compileFilter` wraps this in truthiness for filtering; this is for callers
 * that want the value itself (an arithmetic result, a column's contents).
 */
export function evaluateExpression(expression, row) {
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  return evaluateAst(ast, row);
}

/**
 * The evaluator itself, shared by `compileFilter` and `evaluateExpression`.
 *
 * `evaluate` is defined inside so it can close over nothing else; the function
 * is pure given (node, row).
 */
function evaluateAst(ast, row) {
  return buildEvaluator()(ast, row);
}

/**
 * Build the recursive evaluator.
 *
 * Kept as a factory so the switch below stays a function rather than a method
 * with state — there is no state to carry between rows.
 */
function buildEvaluator() {
  const evaluate = (node, row) => {
    switch (node.type) {
      case 'literal':
        return node.value;
      case 'list':
        return node.items.map((item) => evaluate(item, row));
      case 'column':
        return Object.prototype.hasOwnProperty.call(row, node.name) ? row[node.name] : null;
      case 'not':
        return !truthy(evaluate(node.operand, row));
      case 'and': {
        // Short-circuit: `a and b` must not evaluate b when a is false, so a
        // filter like `x != 0 and 10 / x > 1` cannot blow up on x = 0.
        const left = evaluate(node.left, row);
        if (!truthy(left)) return false;
        return truthy(evaluate(node.right, row));
      }
      case 'or': {
        const left = evaluate(node.left, row);
        if (truthy(left)) return true;
        return truthy(evaluate(node.right, row));
      }
      case 'negate': {
        const value = toNumber(evaluate(node.operand, row));
        return value === null ? null : -value;
      }
      case 'arithmetic': {
        const left = toNumber(evaluate(node.left, row));
        const right = toNumber(evaluate(node.right, row));
        if (left === null || right === null) {
          // String concatenation is the one useful string operation
          if (node.operator === 'plus') {
            const a = evaluate(node.left, row);
            const b = evaluate(node.right, row);
            if (a === null || b === null) return null;
            return `${a}${b}`;
          }
          return null;
        }
        switch (node.operator) {
          case 'plus':
            return left + right;
          case 'minus':
            return left - right;
          case 'star':
            return left * right;
          case 'slash':
            return right === 0 ? null : left / right;
          case 'percent':
            return right === 0 ? null : left % right;
          default:
            return null;
        }
      }
      case 'compare': {
        const left = evaluate(node.left, row);
        const right = evaluate(node.right, row);
        return compare(node.operator, left, right);
      }
      default:
        return null;
    }
  };
  return evaluate;
}

/**
 * Build a predicate from an expression.
 *
 * The returned function takes a row object. It never throws for ordinary
 * data — a type mismatch just compares as strings — so one bad cell cannot
 * abort a scan.
 */
export function compileFilter(expression) {
  const ast = typeof expression === 'string' ? parseExpression(expression) : expression;
  const evaluate = buildEvaluator();
  const predicate = (row) => truthy(evaluate(ast, row));
  predicate.ast = ast;
  return predicate;
}

/** Apply one comparison operator. */
export function compare(operator, left, right) {
  switch (operator) {
    case 'eq':
      return looseEquals(left, right);
    case 'neq':
      return !looseEquals(left, right);
    case 'contains': {
      if (left === null || left === undefined) return false;
      if (Array.isArray(left)) return left.some((item) => looseEquals(item, right));
      return String(left).includes(String(right ?? ''));
    }
    case 'startswith':
      return left === null || left === undefined ? false : String(left).startsWith(String(right ?? ''));
    case 'endswith':
      return left === null || left === undefined ? false : String(left).endsWith(String(right ?? ''));
    case 'matches': {
      if (left === null || left === undefined) return false;
      let pattern;
      try {
        pattern = new RegExp(String(right ?? ''));
      } catch (error) {
        throw new Error(`invalid regular expression: ${error.message}`);
      }
      return pattern.test(String(left));
    }
    case 'in': {
      if (Array.isArray(right)) return right.some((item) => looseEquals(item, left));
      if (right === null || right === undefined) return false;
      return String(right).includes(String(left ?? ''));
    }
    default: {
      const { a, b, numeric } = compareValues(left, right);
      if (numeric) {
        switch (operator) {
          case 'lt':
            return a < b;
          case 'lte':
            return a <= b;
          case 'gt':
            return a > b;
          case 'gte':
            return a >= b;
          default:
            return false;
        }
      }
      const order = a < b ? -1 : a > b ? 1 : 0;
      switch (operator) {
        case 'lt':
          return order < 0;
        case 'lte':
          return order <= 0;
        case 'gt':
          return order > 0;
        case 'gte':
          return order >= 0;
        default:
          return false;
      }
    }
  }
}

/** Equality that treats "1" and 1 as equal but null as distinct from "". */
function looseEquals(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    const a = typeof left === 'boolean' ? left : truthy(left);
    const b = typeof right === 'boolean' ? right : truthy(right);
    return a === b;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  if (a !== null && b !== null) return a === b;
  return String(left) === String(right);
}

/**
 * Column names mentioned in an expression, so a caller can warn about a typo
 * before running a filter that would silently select nothing.
 */
export function referencedColumns(ast) {
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'column') names.add(node.name);
    for (const key of ['left', 'right', 'operand']) {
      if (node[key]) walk(node[key]);
    }
  };
  walk(typeof ast === 'string' ? parseExpression(ast) : ast);
  return [...names];
}
