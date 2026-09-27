/**
 * Reading: figure out what a file is, then turn it into tables.
 *
 * The format is *detected*, not demanded, because the whole point of a tool like
 * this is being handed a file by someone else. Detection is also reported, so a
 * wrong guess is visible and overridable rather than silent.
 */

import { parseCsv } from './csv.js';

export const FORMATS = ['csv', 'tsv', 'json', 'jsonl'];

/** Column name used when a JSON array holds bare values rather than objects. */
export const VALUE_COLUMN = 'value';

/**
 * Guess the format from the text itself.
 *
 * Order matters: JSON and JSONL are checked first because valid JSON is rarely
 * valid CSV in a useful way, while the reverse is common (a single-column CSV
 * of numbers is also valid JSONL if every line is a number — checking JSONL
 * first would misread it).
 */
export function detectFormat(text, { filename = null } = {}) {
  const sample = String(text ?? '').slice(0, 64 * 1024);
  const trimmed = sample.replace(/^\uFEFF/, '').trimStart();

  // Explicit extensions win over content sniffing
  const extension = filename ? String(filename).toLowerCase().split('.').pop() : null;
  if (extension === 'tsv' || extension === 'tab') return { format: 'tsv', reason: 'file extension' };
  if (extension === 'csv') return { format: 'csv', reason: 'file extension' };
  if (extension === 'ndjson' || extension === 'jsonl') return { format: 'jsonl', reason: 'file extension' };
  if (extension === 'json') return { format: 'json', reason: 'file extension' };

  if (trimmed === '') return { format: 'csv', reason: 'empty input defaults to csv' };

  // A leading { or [ is JSON: either an object, an array of objects, or a
  // pretty-printed stream that JSON.parse will reject and JSONL will accept.
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return { format: 'json', reason: 'starts with { and parses as JSON' };
    } catch {
      return { format: 'jsonl', reason: 'starts with { but does not parse as one JSON value' };
    }
  }
  if (trimmed.startsWith('[')) {
    // Could be a JSON array or a line starting with a bracketed CSV field;
    // only treat it as JSON when it parses.
    try {
      JSON.parse(text);
      return { format: 'json', reason: 'starts with [ and parses as JSON' };
    } catch {
      /* fall through to delimited */
    }
  }

  // Delimited: whichever of tab/comma/semicolon appears most in the first line
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
  const counts = {
    tsv: (firstLine.match(/\t/g) ?? []).length,
    csv: (firstLine.match(/,/g) ?? []).length,
    semicolon: (firstLine.match(/;/g) ?? []).length,
  };
  if (counts.tsv > 0 && counts.tsv >= counts.csv) return { format: 'tsv', reason: `${counts.tsv} tab(s) on the first line` };
  if (counts.semicolon > counts.csv && counts.semicolon > 0) {
    return { format: 'csv', delimiter: ';', reason: `${counts.semicolon} semicolon(s) on the first line` };
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length > 1 && lines.every((l) => looksLikeJsonLine(l))) {
    return { format: 'jsonl', reason: 'every non-empty line parses as JSON' };
  }
  return { format: 'csv', reason: `${counts.csv} comma(s) on the first line` };
}

function looksLikeJsonLine(line) {
  const text = line.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Collect the column order for a set of objects, first-seen order first. */
export function columnsFor(objects) {
  const names = [];
  const seen = new Set();
  for (const object of objects) {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) continue;
    for (const key of Object.keys(object)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

/**
 * Rows from a list of JSON values.
 *
 * A bare array of scalars becomes a single `value` column, because that is what
 * the user meant and dropping the data would be worse than naming the column
 * something generic. Nested objects and arrays are kept as objects and rendered
 * by the writer (JSON output keeps them structured, delimited output does not
 * silently flatten them).
 */
export function rowsFromValues(values) {
  const objects = values.filter((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
  const header = columnsFor(objects);
  const allScalar = values.every((v) => v === null || typeof v !== 'object' || Array.isArray(v));

  if (allScalar) {
    return {
      header: [VALUE_COLUMN],
      rows: values.map((value) => ({ [VALUE_COLUMN]: value })),
    };
  }

  const extra = new Set();
  for (const value of values) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) extra.add(true);
  }
  const names = extra.size > 0 ? [...header, VALUE_COLUMN] : header;

  const rows = values.map((value) => {
    const row = {};
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of names) row[name] = Object.prototype.hasOwnProperty.call(value, name) ? value[name] : null;
    } else {
      for (const name of names) row[name] = null;
      row[VALUE_COLUMN] = value;
    }
    return row;
  });

  return { header: names, rows };
}

/** Parse JSON Lines: one JSON value per non-empty line. */
export function parseJsonl(text, { maxRows = null, onError = 'throw' } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const values = [];
  const errors = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      const message = `line ${i + 1}: ${error.message}`;
      if (onError === 'throw') throw new Error(`invalid JSON on ${message}`);
      errors.push(message);
      continue;
    }
    if (maxRows !== null && values.length >= maxRows) break;
  }
  const { header, rows } = rowsFromValues(values);
  return { header, rows, errors, records: rows.length };
}

/** Parse a whole JSON document: an array of objects, or a single object. */
export function parseJson(text, { maxRows = null } = {}) {
  let value;
  try {
    value = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`);
  }

  if (Array.isArray(value)) {
    const limited = maxRows === null ? value : value.slice(0, maxRows);
    const { header, rows } = rowsFromValues(limited);
    return { header, rows, errors: [], records: rows.length };
  }

  if (value !== null && typeof value === 'object') {
    // A wrapper object like { "data": [...] } is extremely common in API
    // exports, and reading it as a one-row table is never what anyone wants.
    // Only unwrap when the array is the *only* array-valued key: with two of
    // them there is no way to know which was meant, and guessing loses data.
    const arrayKeys = Object.keys(value).filter((key) => Array.isArray(value[key]));

    if (arrayKeys.length === 1 && Object.keys(value).length === 1) {
      const inner = value[arrayKeys[0]];
      const limited = maxRows === null ? inner : inner.slice(0, maxRows);
      const { header, rows } = rowsFromValues(limited);
      return { header, rows, errors: [], records: rows.length, unwrapped: arrayKeys[0] };
    }
    const { header, rows } = rowsFromValues([value]);
    return { header, rows, errors: [], records: rows.length };
  }

  // A bare scalar document
  return { header: [VALUE_COLUMN], rows: [{ [VALUE_COLUMN]: value }], errors: [], records: 1 };
}

/**
 * Read any supported input into { header, rows, format, errors, meta }.
 *
 * This is the single entry point the CLI uses; the format-specific parsers
 * exist for callers who already know what they have.
 */
export function readTable(text, options = {}) {
  const {
    format = null,
    filename = null,
    delimiter = null,
    header = true,
    emptyAs = 'empty-string',
    maxRows = null,
    onError = 'throw',
  } = options;

  const detected = format ? { format, reason: 'requested' } : detectFormat(text, { filename });
  const chosen = detected.format;
  const effectiveDelimiter = delimiter ?? detected.delimiter ?? (chosen === 'tsv' ? '\t' : ',');

  let parsed;
  if (chosen === 'json') parsed = parseJson(text, { maxRows });
  else if (chosen === 'jsonl') parsed = parseJsonl(text, { maxRows, onError });
  else {
    parsed = parseCsv(text, {
      delimiter: effectiveDelimiter,
      header,
      emptyAs,
      maxRows,
    });
  }

  return {
    ...parsed,
    format: chosen,
    delimiter: chosen === 'csv' || chosen === 'tsv' ? effectiveDelimiter : null,
    detection: detected,
    meta: {
      bytes: Buffer.byteLength(String(text ?? ''), 'utf8'),
      columns: parsed.header.length,
      records: parsed.rows.length,
    },
  };
}
