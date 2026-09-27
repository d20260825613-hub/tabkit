/**
 * Hand-written argument parser.
 *
 * Knows nothing about files or output and never prints. It turns argv into
 * { command, values, positional } plus a hint on failure, so the CLI layer owns
 * reporting and the tests can assert on the parse alone.
 *
 * Commands:
 *   peek     describe the columns of a table
 *   cat      read a table and write it out, possibly reshaped
 *   query    filter rows with an expression
 *   convert  rewrite a file in another format
 */

export const USAGE = `tabkit — look at, reshape and convert tables without writing code

Usage
  tabkit peek    [file] [options]        describe the columns
  tabkit cat     [file] [options]        read and write, optionally reshaped
  tabkit query   <expression> [file]     keep the rows an expression accepts
  tabkit convert [file] --to <format>    rewrite in another format

Anywhere a [file] is expected, "-" or nothing means standard input.

Input
      --from <format>      force the input format: csv, tsv, json, jsonl
                           (default: detect from the content and the extension)
      --delimiter <char>   field separator for delimited input (default , or tab)
      --header / --no-header
                           the first row is column names (default), or data
      --empty-as <what>    what an empty unquoted field means:
                           empty-string (default) or null

Output
  -t, --to <format>        csv, tsv, json, jsonl, markdown, table
                           (default: json for convert, table for the rest)
      --json               shorthand for --to json
      --pretty             indent JSON output
      --no-header-out      omit the header row from csv/tsv output
                           (--no-header is about the input, this is the output)

Shaping
  -s, --select <columns>   keep only these columns, in this order
                           e.g. --select id,name,price
  -w, --where <expr>       keep rows matching the expression
      --sort <columns>     sort by these, e.g. --sort -price,name
      --unique [columns]   drop duplicate rows, optionally only comparing these
      --limit <n>          stop after n rows
      --rename old=new     rename a column (repeatable)
      --flatten <columns>  join a nested JSON value into a compact string

Other
      --max-width <n>      truncate wide table columns (default 32)
      --color / --no-color force or disable ANSI colours in table output
      --quiet              suppress warnings on stderr
  -h, --help               show this help
  -v, --version            print the version

Expressions
  Columns are named directly: price > 10, status = "open"
  Operators:  = != < <= > >=  and or not  + - * / %
              contains  startswith  endswith  matches  in
  Lists:      status in ["open", "closed"]
  Spacing:    bracketName("a column with spaces")
  Values:     numbers, "strings", 'strings', true, false, null
  Both sides compare as numbers when both look numeric, otherwise as text.
  An empty field is NOT zero: price > 0 skips rows where price is blank.

Examples
  tabkit peek sales.csv
  tabkit cat sales.csv --select region,total --sort -total --limit 10
  tabkit query 'status = "open" and total > 1000' tickets.csv
  tabkit query 'region in ["EU", "APAC"]' sales.csv -t csv > subset.csv
  tabkit convert data.json --to csv
  cat data.tsv | tabkit cat -t markdown

Exit codes
  0  the command succeeded
  1  reading or writing failed
  2  the arguments or the expression were wrong

Notes
  * The input format is detected, and the guess is reported on stderr so a wrong
    one is visible rather than mysterious. --from overrides it.
  * Data is processed in memory. This is a tool for tables that fit.
`;

/** Option definitions shared by every command. */
const SPEC = {
  from: { type: 'string' },
  to: { type: 'string', short: 't' },
  // `--json` is what everyone types; it is shorthand for `--to json`.
  json: { type: 'boolean', default: false },
  delimiter: { type: 'string' },
  header: { type: 'boolean', default: true, negatable: true },
  'empty-as': { type: 'string', default: 'empty-string' },
  pretty: { type: 'boolean', default: false },
  select: { type: 'string', short: 's' },
  where: { type: 'string', short: 'w' },
  sort: { type: 'string' },
  unique: { type: 'optionalList' },
  limit: { type: 'number', min: 0 },
  rename: { type: 'string', repeat: true },
  flatten: { type: 'string' },
  'max-width': { type: 'number', default: 32, min: 4, max: 200 },
  color: { type: 'boolean', default: undefined, negatable: true },
  quiet: { type: 'boolean', default: false },
  'no-header-out': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

export const OPTION_NAMES = Object.keys(SPEC);

export const ALIASES = new Map([
  ['t', 'to'],
  ['s', 'select'],
  ['w', 'where'],
  ['h', 'help'],
  ['v', 'version'],
]);

// `help` is a command as well as a flag: `tabkit help` is what a user types
// after a failed attempt, and rejecting it as an unknown command is a poor
// greeting.
export const COMMANDS = ['peek', 'cat', 'query', 'convert', 'help'];
export const INPUT_FORMATS = ['csv', 'tsv', 'json', 'jsonl'];
export const OUTPUT_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'markdown', 'table'];
export const EMPTY_AS = ['empty-string', 'null'];

export function parseArgs(argv) {
  const values = {};
  for (const [name, def] of Object.entries(SPEC)) {
    if (def.default !== undefined) values[name] = def.default;
    if (def.repeat) values[name] = [];
  }

  const args = [...argv];
  let command = null;

  if (args.length > 0 && !args[0].startsWith('-')) {
    command = args.shift();
    if (!COMMANDS.includes(command)) {
      return {
        ok: false,
        command: null,
        message: `unknown command: ${command}`,
        hint: `expected one of: ${COMMANDS.join(', ')}`,
      };
    }
  } else if (args.includes('--help') || args.includes('-h')) {
    command = 'help';
  } else if (args.includes('--version') || args.includes('-v')) {
    command = 'help';
  } else {
    return { ok: false, command: null, message: 'no command given', hint: `expected one of: ${COMMANDS.join(', ')}` };
  }

  const positional = [];

  while (args.length > 0) {
    const token = args.shift();

    if (token === '--') {
      positional.push(...args);
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? null : body.slice(eq + 1);

      let name = rawName;
      let negated = false;
      if (!SPEC[name] && rawName.startsWith('no-')) {
        const bare = rawName.slice(3);
        if (SPEC[bare]?.negatable) {
          name = bare;
          negated = true;
        }
      }

      const def = SPEC[name];
      if (!def) {
        return { ok: false, command, message: `unknown option: --${rawName}`, hint: 'run "tabkit --help" to see every option' };
      }

      if (def.type === 'boolean') {
        values[name] = !negated;
        continue;
      }
      if (negated) return { ok: false, command, message: `--no-${name} is not valid`, hint: `--${name} takes a value` };

      if (def.type === 'optionalList') {
        // `--unique` may stand alone (every column), take `=a,b`, or take the
        // next word when that word is not another option.
        if (inline !== null) {
          values.unique = inline === '' ? true : splitList(inline);
          continue;
        }
        const following = args[0];
        // Consume the next word unless it is another option. Testing for a
        // leading "-" is not enough: a column list like "region,product" never
        // starts with one, but neither does a single column, and only a value
        // that *looks* like a flag should be left alone.
        if (following === undefined || isOptionToken(following)) {
          values.unique = true;
          continue;
        }
        args.shift();
        values.unique = splitList(following);
        continue;
      }

      let value = inline;
      if (value === null) {
        if (args.length === 0) {
          return { ok: false, command, message: `option --${name} requires a value`, hint: `for example --${name} <value>` };
        }
        value = args.shift();
      }
      const problem = applyValue(values, name, def, value);
      if (problem) return { ok: false, command, ...problem };
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const chars = [...token.slice(1)];
      let pending = null;
      for (let i = 0; i < chars.length; i += 1) {
        const mapped = ALIASES.get(chars[i]);
        if (!mapped) {
          return { ok: false, command, message: `unknown option: -${chars[i]}`, hint: 'run "tabkit --help" to see every option' };
        }
        const def = SPEC[mapped];
        if (def.type === 'boolean') {
          values[mapped] = true;
          continue;
        }
        const rest = chars.slice(i + 1).join('');
        if (rest !== '') {
          const problem = applyValue(values, mapped, def, rest);
          if (problem) return { ok: false, command, ...problem };
        } else {
          pending = mapped;
        }
        break;
      }
      if (pending !== null) {
        if (args.length === 0) {
          return { ok: false, command, message: `option -${SPEC[pending].short} (--${pending}) requires a value`, hint: `for example -${SPEC[pending].short} <value>` };
        }
        const problem = applyValue(values, pending, SPEC[pending], args.shift());
        if (problem) return { ok: false, command, ...problem };
      }
      continue;
    }

    positional.push(token);
  }

  // --- command-specific validation -----------------------------------------
  if (command === 'query') {
    // The expression may be given as the first positional, or via --where
    if (values.where === undefined && positional.length > 0) {
      values.where = positional.shift();
    }
    if (!values.where) {
      return {
        ok: false,
        command,
        message: 'query needs an expression',
        hint: 'for example: tabkit query \'status = "open"\' data.csv',
      };
    }
    if (positional.length > 1) {
      return { ok: false, command, message: `query takes at most one file, got ${positional.length}`, hint: 'pipe several inputs through one file' };
    }
  } else if (command === 'convert') {
    if (!values.to) {
      return {
        ok: false,
        command,
        message: 'convert needs --to <format>',
        hint: `one of: ${OUTPUT_FORMATS.join(', ')}`,
      };
    }
  } else if (command && command !== 'help') {
    if (positional.length > 1) {
      return { ok: false, command, message: `${command} takes at most one file, got ${positional.length}`, hint: 'use "-" for standard input' };
    }
    if (values.where !== undefined) {
      return { ok: false, command, message: `--where is not part of ${command}`, hint: 'use the query command instead' };
    }
  }

  // --- value validation ----------------------------------------------------
  if (values.json) {
    // `--json` wins over nothing, but must not silently contradict an explicit
    // `--to`. Saying both is a mistake worth reporting.
    if (values.to && values.to !== 'json') {
      return { ok: false, command, message: `--json conflicts with --to ${values.to}`, hint: 'use one or the other' };
    }
    values.to = 'json';
  }
  if (values.from && !INPUT_FORMATS.includes(values.from)) {
    return { ok: false, command, message: `--from must be one of: ${INPUT_FORMATS.join(', ')}`, hint: `got "${values.from}"` };
  }
  if (values.to && !OUTPUT_FORMATS.includes(values.to)) {
    return { ok: false, command, message: `--to must be one of: ${OUTPUT_FORMATS.join(', ')}`, hint: `got "${values.to}"` };
  }
  if (!EMPTY_AS.includes(values['empty-as'])) {
    return { ok: false, command, message: `--empty-as must be one of: ${EMPTY_AS.join(', ')}`, hint: `got "${values['empty-as']}"` };
  }
  if (values.delimiter && values.delimiter.length !== 1) {
    return { ok: false, command, message: '--delimiter must be a single character', hint: 'for example --delimiter ";"' };
  }
  for (const pair of values.rename ?? []) {
    if (!pair.includes('=')) {
      return { ok: false, command, message: `--rename needs old=new, got "${pair}"`, hint: 'for example --rename total=amount' };
    }
  }

  return { ok: true, command, values, positional };
}

/** Split a comma-separated list, tolerating spaces after the commas. */
export function splitList(text) {
  return String(text ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Is this token another option rather than a value?
 *
 * `--name`, `-n` and `--` are options; `region,product` and `-5` are not. The
 * distinction matters for the options that take an optional list, where taking
 * the next word when it is really a flag would swallow it.
 */
export function isOptionToken(token) {
  return /^--?[A-Za-z]/.test(String(token ?? '')) || token === '--';
}

function applyValue(values, name, def, raw) {
  switch (def.type) {
    case 'string':
      if (def.repeat) values[name].push(String(raw));
      else values[name] = String(raw);
      return null;
    case 'optionalList':
      values[name] = raw === '' ? true : splitList(raw);
      return null;
    case 'number': {
      if (!/^\d+$/.test(String(raw).trim())) {
        return { message: `--${name} expects a whole number, got "${raw}"`, hint: `for example --${name} ${def.min ?? 1}` };
      }
      const value = Number(raw);
      if (def.min !== undefined && value < def.min) return { message: `--${name} must be >= ${def.min}`, hint: `the smallest accepted value is ${def.min}` };
      if (def.max !== undefined && value > def.max) return { message: `--${name} must be <= ${def.max}`, hint: `the largest accepted value is ${def.max}` };
      values[name] = value;
      return null;
    }
    default:
      return { message: `internal: unhandled option type for --${name}`, hint: null };
  }
}
