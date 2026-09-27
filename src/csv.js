/**
 * RFC 4180 CSV reading, with the extensions real files actually use.
 *
 * A character-at-a-time state machine rather than a split on commas and
 * newlines, because the naive version breaks on the two things that are
 * everywhere in real data:
 *
 *   - a quoted field containing the delimiter: `"Smith, John"`
 *   - a quoted field containing a newline: `"line one\nline two"`
 *
 * It also handles the extensions that show up in files exported from Excel and
 * from other tools: CRLF or LF or CR line endings, an optional UTF-8 BOM, a
 * doubled quote inside a quoted field (`""`), and a final row with no trailing
 * newline.
 *
 * The whole input is processed as a string. That is a deliberate limit: this is
 * a tool for tables that fit in memory, and pretending otherwise would mean a
 * streaming API that nothing here needs.
 */

/** Values a caller can choose for what an empty unquoted field means. */
export const EMPTY_AS = ['empty-string', 'null'];

/**
 * Parse CSV text into { header, rows, errors }.
 *
 * With `header: true` the first row names the columns; duplicate and blank
 * names are made unique so a row object never silently loses a field. With
 * `header: false` columns are named `column1`, `column2`, ... by position.
 */
export function parseCsv(text, options = {}) {
  const {
    delimiter = ',',
    quote = '"',
    header = true,
    emptyAs = 'empty-string',
    skipEmptyLines = true,
    columns = null,
    maxRows = null,
  } = options;

  if (!EMPTY_AS.includes(emptyAs)) {
    throw new Error(`emptyAs must be one of ${EMPTY_AS.join(', ')}`);
  }
  if (String(delimiter).length !== 1) throw new Error('delimiter must be a single character');
  if (String(quote).length !== 1) throw new Error('quote must be a single character');

  let input = String(text ?? '');
  // A BOM turns the first column name into "\uFEFFid", which then never matches
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let quotedField = false;
  let fieldStarted = false;
  let line = 1;
  let recordStartLine = 1;

  const pushField = () => {
    // An empty *unquoted* field is the "missing value" case; an empty quoted
    // field ("") is an explicit empty string. Keeping them apart is what lets
    // emptyAs mean anything.
    if (!quotedField && field === '' && emptyAs === 'null') record.push(null);
    else record.push(field);
    field = '';
    quotedField = false;
    fieldStarted = false;
  };

  const pushRecord = () => {
    // A record with a single empty field is a blank line
    if (record.length === 1 && record[0] === '' && field === '') {
      record = [];
      return;
    }
    pushField();
    if (skipEmptyLines && record.length === 1 && (record[0] === '' || record[0] === null)) {
      record = [];
      return;
    }
    records.push({ values: record, line: recordStartLine });
    record = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === quote) {
        if (input[i + 1] === quote) {
          field += quote; // a doubled quote is one literal quote
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === quote && field === '') {
      inQuotes = true;
      quotedField = true;
      fieldStarted = true;
      continue;
    }

    if (char === delimiter) {
      pushField();
      fieldStarted = true;
      continue;
    }

    if (char === '\r' || char === '\n') {
      // Treat CRLF as one terminator
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
      recordStartLine = line;
      continue;
    }

    field += char;
    fieldStarted = true;
  }

  // A file that does not end with a newline still has a final record
  if (fieldStarted || field !== '' || record.length > 0) {
    pushRecord();
  }

  if (inQuotes) {
    // No usable table at all: report it rather than returning whatever was
    // parsed so far, which would be a silently truncated file.
    return {
      header: [],
      rows: [],
      errors: [`unterminated quoted field starting near line ${recordStartLine}`],
      records: 0,
      meta: { bytes: Buffer.byteLength(input, 'utf8'), columns: 0, records: 0 },
    };
  }

  const errors = [];
  let names;
  let dataRecords;

  if (header) {
    if (records.length === 0) return { header: [], rows: [], errors, records: 0 };
    names = uniqueNames(records[0].values);
    dataRecords = records.slice(1);
  } else {
    const width = records.reduce((max, r) => Math.max(max, r.values.length), 0);
    names = columns ?? Array.from({ length: width }, (_, i) => `column${i + 1}`);
    dataRecords = records;
  }

  if (columns) names = uniqueNames(columns);

  const raggedy = [];
  let rows = [];
  for (const record of dataRecords) {
    if (record.values.length !== names.length) {
      raggedy.push({ line: record.line, got: record.values.length, expected: names.length });
      // Pad short rows with the empty value rather than dropping them: a missing
      // trailing field is common and the row is still useful.
      if (record.values.length < names.length) {
        const padded = record.values.slice();
        while (padded.length < names.length) padded.push(emptyAs === 'null' ? null : '');
        record.values = padded;
      }
    }
    const row = {};
    for (let i = 0; i < names.length; i += 1) {
      row[names[i]] = record.values[i] === undefined ? (emptyAs === 'null' ? null : '') : record.values[i];
    }
    rows.push(row);
    if (maxRows !== null && rows.length >= maxRows) break;
  }

  if (raggedy.length > 0) {
    const first = raggedy[0];
    errors.push(
      `${raggedy.length} row(s) had the wrong number of fields; first at line ${first.line} ` +
        `(got ${first.got}, expected ${first.expected})`,
    );
  }

  return { header: names, rows, errors, records: rows.length };
}

/**
 * Make column names usable as object keys and as query identifiers.
 * Blank names become `columnN`; duplicates get a `_2`, `_3` suffix.
 */
export function uniqueNames(names) {
  const seen = new Map();
  const result = [];
  for (let i = 0; i < names.length; i += 1) {
    let name = String(names[i] ?? '').trim();
    if (name === '') name = `column${i + 1}`;
    if (seen.has(name)) {
      const next = seen.get(name) + 1;
      seen.set(name, next);
      name = `${name}_${next}`;
      // A generated name could itself collide; keep walking until it is free
      while (seen.has(name)) {
        const again = seen.get(name) + 1;
        seen.set(name, again);
        name = `${name}_${again}`;
      }
    }
    seen.set(name, 1);
    result.push(name);
  }
  return result;
}

/** Characters that force a field to be quoted in CSV output. */
function needsQuoting(value, delimiter, quote) {
  const text = String(value ?? '');
  if (text === '') return false;
  if (text.includes(delimiter) || text.includes(quote)) return true;
  return /[\r\n]/.test(text);
}

/** Quote one field for CSV output. */
export function quoteField(value, { delimiter = ',', quote = '"' } = {}) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!needsQuoting(text, delimiter, quote)) return text;
  return `${quote}${text.split(quote).join(quote + quote)}${quote}`;
}

/**
 * Convert rows to CSV text.
 *
 * All values are stringified here rather than by JSON rules, because `String(0)`
 * is "0" and `String(false)` is "false" — the two cases where a JSON shortcut
 * would quietly produce something a spreadsheet cannot read.
 */
export function toCsv(header, rows, options = {}) {
  const { delimiter = ',', quote = '"', eol = '\n' } = options;
  const lines = [];
  if (options.header !== false && header.length > 0) {
    lines.push(header.map((name) => quoteField(name, { delimiter, quote })).join(delimiter));
  }
  for (const row of rows) {
    const values = Array.isArray(row) ? row : header.map((name) => row?.[name]);
    lines.push(values.map((value) => quoteField(value, { delimiter, quote })).join(delimiter));
  }
  return lines.join(eol) + (lines.length > 0 ? eol : '');
}
