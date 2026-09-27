/**
 * Reshaping operations, kept as pure functions on { header, rows }.
 *
 * All of them return a new object and never mutate the input, because the CLI
 * applies several in sequence and a mutating step would make the result depend
 * on the order the caller happened to write them in.
 */

import { compileFilter, referencedColumns, toNumber } from './query.js';
import { cellText, inferType } from './output.js';

/** Keep only the named columns, in the order given. */
export function selectColumns(header, rows, columns) {
  const wanted = columns.filter((name) => header.includes(name));
  const missing = columns.filter((name) => !header.includes(name));
  return {
    header: wanted,
    rows: rows.map((row) => {
      const out = {};
      for (const name of wanted) out[name] = row?.[name] ?? null;
      return out;
    }),
    missing,
  };
}

/** Rename columns. `pairs` is a list of "old=new" strings. */
export function renameColumns(header, rows, pairs) {
  const mapping = new Map();
  const unknown = [];
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    const from = pair.slice(0, index).trim();
    const to = pair.slice(index + 1).trim();
    if (from === '' || to === '') continue;
    if (!header.includes(from)) unknown.push(from);
    mapping.set(from, to);
  }

  const renamed = header.map((name) => mapping.get(name) ?? name);
  // A rename onto an existing name would silently merge two columns, so make it
  // unique instead of losing data.
  const seen = new Map();
  const finalNames = renamed.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}_${count}`;
  });

  const rows2 = rows.map((row) => {
    const out = {};
    header.forEach((name, index) => {
      out[finalNames[index]] = row?.[name] ?? null;
    });
    return out;
  });

  return { header: finalNames, rows: rows2, unknown };
}

/** Keep the rows a compiled predicate accepts. */
export function filterRows(header, rows, predicate) {
  return { header, rows: rows.filter((row) => predicate(row)) };
}

/**
 * Compare two cell values.
 *
 * Numbers compare as numbers and everything else as text, so `--sort price`
 * orders 9 before 10 rather than after it. Blanks always sort last regardless
 * of direction, because a blank is not a small value and putting it first makes
 * a sorted table look broken.
 */
export function compareCells(a, b) {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const aNumber = toNumber(a);
  const bNumber = toNumber(b);
  if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : aNumber > bNumber ? 1 : 0;

  const aText = String(a);
  const bText = String(b);
  // localeCompare with numeric collation gives "item2" < "item10", which is what
  // a human expects; plain < would not.
  return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort rows by a list of signed column names: `price`, `-price`, `a,-b`.
 *
 * The sort is stable (Array.prototype.sort is stable in every supported Node),
 * so equal rows keep their input order and two runs agree.
 */
export function sortRows(header, rows, spec) {
  const terms = spec.map((term) => {
    const text = String(term).trim();
    const descending = text.startsWith('-');
    const name = descending ? text.slice(1) : text.startsWith('+') ? text.slice(1) : text;
    return { name, descending };
  });

  const missing = terms.filter((term) => !header.includes(term.name)).map((term) => term.name);
  const usable = terms.filter((term) => header.includes(term.name));
  if (usable.length === 0) return { header, rows, missing };

  const sorted = rows.slice().sort((left, right) => {
    for (const term of usable) {
      const a = left?.[term.name];
      const b = right?.[term.name];
      const aEmpty = a === null || a === undefined || a === '';
      const bEmpty = b === null || b === undefined || b === '';
      // Blanks last in both directions
      if (aEmpty && bEmpty) continue;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      const result = compareCells(a, b);
      if (result !== 0) return term.descending ? -result : result;
    }
    return 0;
  });

  return { header, rows: sorted, missing };
}

/**
 * Drop duplicate rows.
 *
 * `columns === true` compares whole rows; a list compares only those columns,
 * keeping the first row of each group.
 */
export function uniqueRows(header, rows, columns) {
  const keys = columns === true ? header : columns.filter((name) => header.includes(name));
  const effective = keys.length > 0 ? keys : header;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = effective.map((name) => JSON.stringify(row?.[name] ?? null)).join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return { header, rows: out, columns: effective, removed: rows.length - out.length };
}

/** Keep the first n rows. */
export function limitRows(header, rows, limit) {
  if (limit === null || limit === undefined) return { header, rows };
  return { header, rows: rows.slice(0, limit) };
}

/**
 * Replace a nested value with a compact string.
 *
 * Only the named columns are touched. Doing it globally would quietly destroy
 * structure the user asked for by choosing JSON output, so it is opt-in per
 * column and reported.
 */
export function flattenColumns(header, rows, columns) {
  const targets = columns.filter((name) => header.includes(name));
  const missing = columns.filter((name) => !header.includes(name));
  if (targets.length === 0) return { header, rows, missing };

  const flattened = rows.map((row) => {
    const out = { ...row };
    for (const name of targets) {
      const value = out[name];
      if (value !== null && typeof value === 'object') out[name] = cellText(value);
    }
    return out;
  });
  return { header, rows: flattened, missing };
}

/**
 * Apply every shaping option in a fixed order.
 *
 * The order is part of the contract, not an implementation detail:
 *   rename → flatten → where → sort → unique → select → limit
 *
 * `where` runs before `select` so an expression may reference a column that the
 * output does not include — filtering on a column and not printing it is
 * ordinary. `select` runs after `unique` for the mirror-image reason: dedup on
 * the full row and then project. `limit` is last so it means "the first n rows of
 * the final result", which is what `--limit` reads as.
 *
 * Returns { header, rows, notes, error }.
 */
export function shapeTable(header, rows, options = {}) {
  const notes = [];
  let current = { header, rows };

  if (options.rename && options.rename.length > 0) {
    const result = renameColumns(current.header, current.rows, options.rename);
    current = result;
    if (result.unknown.length > 0) notes.push(`--rename: no such column: ${result.unknown.join(', ')}`);
  }

  if (options.flatten) {
    const columns = Array.isArray(options.flatten) ? options.flatten : String(options.flatten).split(',').map((s) => s.trim()).filter(Boolean);
    const result = flattenColumns(current.header, current.rows, columns);
    current = result;
    if (result.missing.length > 0) notes.push(`--flatten: no such column: ${result.missing.join(', ')}`);
  }

  if (options.where) {
    let predicate;
    try {
      predicate = compileFilter(options.where);
    } catch (error) {
      return { ...current, notes, error: `cannot understand the expression: ${error.message}` };
    }
    // A column that does not exist is almost always a typo, and it makes the
    // filter select nothing — which looks like "no matching rows".
    const referenced = referencedColumns(predicate.ast);
    const unknown = referenced.filter((name) => !current.header.includes(name));
    if (unknown.length > 0) notes.push(`--where references unknown column(s): ${unknown.join(', ')}`);
    current = filterRows(current.header, current.rows, predicate);
  }

  if (options.sort) {
    const terms = Array.isArray(options.sort) ? options.sort : String(options.sort).split(',');
    const result = sortRows(current.header, current.rows, terms);
    current = result;
    if (result.missing && result.missing.length > 0) notes.push(`--sort: no such column: ${result.missing.join(', ')}`);
  }

  if (options.unique) {
    const columns = options.unique === true ? true : Array.isArray(options.unique) ? options.unique : [options.unique];
    const result = uniqueRows(current.header, current.rows, columns);
    current = result;
    if (result.removed > 0) notes.push(`--unique removed ${result.removed} duplicate row(s)`);
  }

  if (options.select) {
    const columns = Array.isArray(options.select) ? options.select : String(options.select).split(',').map((s) => s.trim()).filter(Boolean);
    const result = selectColumns(current.header, current.rows, columns);
    current = result;
    if (result.missing.length > 0) notes.push(`--select: no such column: ${result.missing.join(', ')}`);
    if (result.header.length === 0) {
      return { ...current, notes, error: `--select matched no columns (available: ${header.join(', ')})` };
    }
  }

  if (options.limit !== undefined && options.limit !== null) {
    current = limitRows(current.header, current.rows, options.limit);
  }

  return { ...current, notes };
}

/** Per-column facts for `peek`. */
export function profileColumns(header, rows) {
  return header.map((name) => {
    const values = rows.map((row) => row?.[name] ?? null);
    const present = values.filter((value) => value !== null && value !== undefined && value !== '');
    const type = inferType(values);
    const numbers = type === 'number' ? present.map((v) => Number(v)).filter(Number.isFinite) : null;
    return {
      name,
      type,
      filled: present.length,
      missing: values.length - present.length,
      distinct: new Set(values.map((value) => JSON.stringify(value ?? null))).size,
      min: numbers && numbers.length > 0 ? Math.min(...numbers) : null,
      max: numbers && numbers.length > 0 ? Math.max(...numbers) : null,
      samples: present.slice(0, 3).map((value) => cellText(value)),
      hasNested: present.some((value) => value !== null && typeof value === 'object'),
    };
  });
}

/** Whole-table facts for `peek`. */
export function profileTable(header, rows) {
  const columns = profileColumns(header, rows);
  return {
    columns,
    rows: rows.length,
    emptyColumns: columns.filter((column) => column.type === 'empty').map((column) => column.name),
    nestedColumns: columns.filter((column) => column.hasNested).map((column) => column.name),
  };
}
