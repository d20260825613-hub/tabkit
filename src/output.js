/**
 * Writing: the table back out in whichever shape is needed.
 *
 * Delimited output and JSON output disagree about one thing on purpose. In JSON,
 * a nested object or array stays structured, because JSON can hold it. In CSV it
 * would have to be flattened or dropped, and both are lossy in a way the user
 * cannot see, so a nested value is written as compact JSON in the cell — visible
 * in the output rather than silently missing.
 */

import { quoteField } from './csv.js';

export const OUTPUT_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'markdown', 'table'];

const DELIMITERS = { csv: ',', tsv: '\t' };

/** Cell text for a value in a delimited or textual format. */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Serialise rows to CSV or TSV.
 *
 * `eol` defaults to "\n" and is not platform-dependent: a file written on
 * Windows and read on Linux with "\r\n" line endings shows up as a stray
 * character in the last column of every row.
 */
export function writeDelimited(header, rows, { format = 'csv', eol = '\n', header: withHeader = true } = {}) {
  const delimiter = DELIMITERS[format] ?? ',';
  const lines = [];
  if (withHeader) {
    lines.push(header.map((name) => quoteField(name, { delimiter })).join(delimiter));
  }
  for (const row of rows) {
    const values = header.map((name) => cellText(row?.[name]));
    lines.push(values.map((value) => quoteField(value, { delimiter })).join(delimiter));
  }
  return lines.join(eol) + (lines.length > 0 ? eol : '');
}

/** Serialise rows to a JSON array. `pretty` indents, as `--pretty` implies. */
export function writeJson(header, rows, { pretty = false } = {}) {
  const objects = rows.map((row) => {
    const object = {};
    for (const name of header) object[name] = row?.[name] ?? null;
    return object;
  });
  return `${JSON.stringify(objects, null, pretty ? 2 : 0)}\n`;
}

/** Serialise rows to JSON Lines: one object per line, no outer array. */
export function writeJsonl(header, rows) {
  return rows
    .map((row) => {
      const object = {};
      for (const name of header) object[name] = row?.[name] ?? null;
      return JSON.stringify(object);
    })
    .join('\n')
    .concat(rows.length > 0 ? '\n' : '');
}

/**
 * Render a Markdown table.
 *
 * Cell pipes are escaped, because an unescaped `|` inside a value silently adds
 * a column to the table — the most common way a generated Markdown table ends
 * up wrong. Newlines become `<br>` for the same reason: a raw newline ends the
 * table row.
 */
export function writeMarkdown(header, rows) {
  if (header.length === 0) return '';
  const escape = (value) =>
    cellText(value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');

  const lines = [];
  lines.push(`| ${header.map((name) => escape(name)).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${header.map((name) => escape(row?.[name])).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Pad or truncate a cell to a display width.
 *
 * Whitespace is collapsed (a newline would break every format that is not JSON),
 * and padding uses display width rather than character count, so a column of CJK
 * values lines up instead of drifting by one column per character.
 */
export function fitCell(value, width) {
  const text = cellText(value).replace(/\s+/g, ' ').trim();
  const visible = displayWidth(text);
  if (visible <= width) return text + ' '.repeat(width - visible);
  // Truncating needs to respect display width too, or a wide character can
  // overshoot the column it was supposed to fit in.
  let out = '';
  let used = 0;
  for (const character of text) {
    const charWidth = displayWidth(character);
    if (used + charWidth > width - 1) break;
    out += character;
    used += charWidth;
  }
  return `${out}…`;
}

/**
 * Render an aligned plain-text table.
 *
 * Column widths are computed from the data, capped so one long value does not
 * push everything off screen. CJK characters are counted as double width, which
 * is why the width maths uses code points rather than `.length`.
 */
export function writeTable(header, rows, { maxWidth = 32, color = false } = {}) {
  if (header.length === 0) return '';
  const widths = header.map((name, index) => {
    let width = displayWidth(name);
    for (const row of rows) {
      width = Math.max(width, Math.min(maxWidth, displayWidth(cellText(row?.[name]))));
    }
    void index;
    return Math.min(maxWidth, Math.max(width, 3));
  });

  const paint = (text, code) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const line = (values, transform) =>
    values
      .map((value, index) => transform(fitCell(value, widths[index]), index))
      .join('  ')
      .trimEnd();

  const lines = [];
  lines.push(line(header, (text) => paint(text, '1')));
  lines.push(widths.map((width) => '─'.repeat(width)).join('──'));
  for (const row of rows) {
    lines.push(line(header.map((name) => row?.[name]), (text) => text));
  }
  return `${lines.join('\n')}\n`;
}

/** Rough display width: East Asian wide characters occupy two columns. */
export function displayWidth(text) {
  let width = 0;
  for (const character of String(text ?? '')) {
    const code = character.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x20000 && code <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/** Render rows in any supported output format. */
export function writeRows(header, rows, { format = 'table', pretty = false, color = false, header: withHeader = true } = {}) {
  switch (format) {
    case 'csv':
    case 'tsv':
      return writeDelimited(header, rows, { format, header: withHeader });
    case 'json':
      return writeJson(header, rows, { pretty });
    case 'jsonl':
      return writeJsonl(header, rows);
    case 'markdown':
      return writeMarkdown(header, rows);
    case 'table':
    default:
      return writeTable(header, rows, { color });
  }
}

/**
 * Infer the type of a column from its values.
 *
 * "empty" is its own type rather than being merged into string, because a column
 * of nothing but blanks is usually a parsing problem worth seeing.
 */
export function inferType(values) {
  const present = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (present.length === 0) return 'empty';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'number' || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(String(value).trim()))) {
    return 'number';
  }
  if (present.every((value) => typeof value === 'object')) return 'json';
  return 'string';
}

/** A short description of a column, for `peek`. */
export function describeColumn(name, values) {
  const type = inferType(values);
  const nulls = values.filter((value) => value === null || value === undefined || value === '').length;
  const distinct = new Set(values.map((value) => (value === null || value === undefined ? '\u0000null' : JSON.stringify(value))));
  const samples = [];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const text = cellText(value);
    if (!samples.includes(text)) samples.push(text);
    if (samples.length >= 3) break;
  }
  const numbers = type === 'number' ? values.map((v) => Number(v)).filter((n) => Number.isFinite(n)) : null;
  return {
    name,
    type,
    nulls,
    distinct: distinct.size,
    samples,
    min: numbers && numbers.length > 0 ? Math.min(...numbers) : null,
    max: numbers && numbers.length > 0 ? Math.max(...numbers) : null,
  };
}
