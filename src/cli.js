/**
 * CLI orchestration: argv in, exit code out.
 *
 * The only layer that touches streams, and the only one that decides an exit
 * code. `io` is injectable so the tests drive the real code path instead of
 * spawning a process, and input is read from `io.readStdin` when it is supplied
 * — which is also what makes stdin testable without a pipe.
 */

import fs from 'node:fs';
import process from 'node:process';

import { USAGE, parseArgs } from './args.js';
import { writeRows } from './output.js';
import { readTable } from './parse.js';
import { profileTable, shapeTable } from './shape.js';

export const VERSION = '0.1.0';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 };

const ANSI = { reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m', cyan: '\u001b[36m', yellow: '\u001b[33m', red: '\u001b[31m', green: '\u001b[32m' };

export function shouldUseColor({ flag, stream, env = process.env } = {}) {
  if (flag === false) return false;
  if (flag === true) return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return Boolean(stream?.isTTY);
}

/** Read a file, or standard input when the path is "-" or absent. */
export async function readInput(path, io = {}) {
  if (path === undefined || path === null || path === '-') {
    if (typeof io.readStdin === 'function') return { text: await io.readStdin(), name: null };
    const chunks = [];
    for await (const chunk of io.stdin ?? process.stdin) chunks.push(chunk);
    return { text: Buffer.concat(chunks).toString('utf8'), name: null };
  }
  const text = fs.readFileSync(path, 'utf8');
  return { text, name: path };
}

/** Default output format per command. */
function defaultFormat(command) {
  return command === 'convert' ? 'json' : 'table';
}

/** Run tabkit. Returns the exit code and never calls process.exit. */
export async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    stderr.write(`tabkit: ${parsed.message}\n`);
    if (parsed.hint) stderr.write(`  ${parsed.hint}\n`);
    stderr.write('Run "tabkit --help" for usage.\n');
    return EXIT.USAGE;
  }

  const { command, values, positional } = parsed;
  const color = shouldUseColor({ flag: values.color, stream: stdout, env });
  const paint = (text, name) => (color ? `${ANSI[name]}${text}${ANSI.reset}` : text);

  // A bare `help` is a deliberate request and exits 0. The two flags must be
  // checked before the `command === 'help'` branch, because a bare
  // `--version`/`--help` parses to the help command as well — checking the
  // command first would make `--version` print the usage text.
  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (values.help || command === 'help') {
    stdout.write(USAGE);
    return EXIT.OK;
  }

  // --- read -----------------------------------------------------------------
  let input;
  try {
    input = await readInput(positional[0], io);
  } catch (error) {
    stderr.write(`tabkit: cannot read ${positional[0]}: ${error.message}\n`);
    return EXIT.FAILED;
  }

  if (input.text.trim() === '') {
    stderr.write('tabkit: the input is empty\n');
    return EXIT.USAGE;
  }

  let table;
  try {
    table = readTable(input.text, {
      format: values.from ?? null,
      filename: input.name,
      delimiter: values.delimiter ?? null,
      header: values.header,
      emptyAs: values['empty-as'],
      // A malformed line in a JSONL file should be reported, not fatal: one bad
      // line in a 100k-line export is normal.
      onError: 'collect',
    });
  } catch (error) {
    stderr.write(`tabkit: cannot parse the input: ${error.message}\n`);
    return EXIT.FAILED;
  }

  // Two kinds of message, and the difference matters. `warn` is suppressed by
  // --quiet because it is advisory (which format was detected, which option had
  // to be ignored). `complain` is never suppressed: a malformed file that loses
  // rows, or an unterminated quote that loses the whole table, is the one thing
  // the user must be told about — swallowing it because they also asked for
  // quiet output would make the tool silently lie about their data.
  const warn = (message) => {
    if (!values.quiet) stderr.write(`${paint('tabkit:', 'yellow')} ${message}\n`);
  };
  const complain = (message) => {
    stderr.write(`${paint('tabkit:', 'red')} ${message}\n`);
  };

  if (values.from === undefined) {
    warn(`read as ${table.format} (${table.detection.reason})`);
  }
  for (const error of table.errors ?? []) complain(error);
  if (table.unwrapped) warn(`unwrapped the array in "${table.unwrapped}"`);

  // --- peek -----------------------------------------------------------------
  if (command === 'peek') {
    const profile = profileTable(table.header, table.rows);
    const format = values.to ?? 'table';
    // A parse that produced nothing usable still has to report the file size,
    // and readTable may have returned early for a malformed file.
    const bytes = table.meta?.bytes ?? Buffer.byteLength(input.text, 'utf8');

    if (format === 'json') {
      stdout.write(
        `${JSON.stringify(
          {
            format: table.format,
            file: input.name,
            bytes,
            rows: profile.rows,
            columns: profile.columns,
            warnings: table.errors ?? [],
          },
          null,
          values.pretty ? 2 : 0,
        )}\n`,
      );
      return EXIT.OK;
    }

    const lines = [];
    lines.push(
      `${paint('tabkit', 'bold')} ${input.name ?? '<stdin>'} — ${table.format}, ` +
        `${profile.rows} row(s), ${profile.columns.length} column(s), ${bytes} byte(s)`,
    );
    lines.push('');
    const header = ['COLUMN', 'TYPE', 'FILLED', 'MISSING', 'DISTINCT', 'MIN', 'MAX', 'SAMPLES'];
    const rows = profile.columns.map((column) => ({
      COLUMN: column.name,
      TYPE: column.type,
      FILLED: column.filled,
      MISSING: column.missing,
      DISTINCT: column.distinct,
      MIN: column.min === null ? '' : column.min,
      MAX: column.max === null ? '' : column.max,
      SAMPLES: column.samples.join(' | '),
    }));
    lines.push(writeRows(header, rows, { format: 'table', color, maxWidth: values['max-width'] }).trimEnd());
    lines.push('');
    if (profile.emptyColumns.length > 0) {
      lines.push(paint(`  every value is empty: ${profile.emptyColumns.join(', ')}`, 'yellow'));
    }
    if (profile.nestedColumns.length > 0) {
      lines.push(
        paint(
          `  nested JSON in: ${profile.nestedColumns.join(', ')} (write as JSON to keep it structured)`,
          'dim',
        ),
      );
    }
    stdout.write(`${lines.join('\n')}\n`);
    return EXIT.OK;
  }

  // --- reshape --------------------------------------------------------------
  const shaped = shapeTable(table.header, table.rows, {
    rename: values.rename,
    flatten: values.flatten,
    where: values.where,
    sort: values.sort,
    unique: values.unique,
    select: values.select,
    limit: values.limit,
  });

  if (shaped.error) {
    stderr.write(`tabkit: ${shaped.error}\n`);
    return EXIT.USAGE;
  }
  for (const note of shaped.notes ?? []) warn(note);

  // --- write ----------------------------------------------------------------
  const format = values.to ?? defaultFormat(command);
  const text = writeRows(shaped.header, shaped.rows, {
    format,
    pretty: values.pretty,
    color,
    // `--no-header-out` is separate from `--no-header`, which describes the
    // *input*; "read a headerless file and write a headerless file" needs both.
    header: !values['no-header-out'],
  });

  try {
    stdout.write(text);
  } catch (error) {
    stderr.write(`tabkit: cannot write the output: ${error.message}\n`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
}
