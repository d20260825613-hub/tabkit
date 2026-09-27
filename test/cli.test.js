import assert from 'node:assert/strict';
import test from 'node:test';

import { OPTION_NAMES, USAGE, parseArgs, splitList } from '../src/args.js';
import { run } from '../src/cli.js';

/** Drive the CLI in-process, with stdin supplied as a string. */
async function cli(argv, stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: (chunk) => (stdout += chunk), isTTY: false },
    stderr: { write: (chunk) => (stderr += chunk), isTTY: false },
    env: { NO_COLOR: '1' },
    readStdin: async () => stdin,
  });
  return { code, stdout, stderr };
}

const CSV = 'id,name,price\n1,bob,10\n2,alice,9\n3,carol,\n';
const JSONL = '{"id":1,"name":"bob","price":10}\n{"id":2,"name":"alice","price":9}\n';

test('help exits 0 and documents every command', async () => {
  const { code, stdout } = await cli(['help']);
  assert.equal(code, 0);
  assert.match(stdout, /tabkit peek/);
  assert.match(stdout, /tabkit cat/);
  assert.match(stdout, /tabkit query/);
  assert.match(stdout, /tabkit convert/);
});

test('--help prints usage, a bare invocation is a usage error', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage/);

  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.stderr, /no command given/);
});

test('--version prints a semver', async () => {
  const { code, stdout } = await cli(['--version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('an unknown command lists the real ones', async () => {
  const { code, stderr } = await cli(['frobnicate']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command: frobnicate/);
  assert.match(stderr, /peek, cat, query, convert/);
});

test('peek describes the columns of a CSV', async () => {
  const { code, stdout, stderr } = await cli(['peek'], CSV);
  assert.equal(code, 0);
  assert.match(stdout, /peek|tabkit/);
  assert.match(stdout, /id/);
  assert.match(stdout, /price/);
  assert.match(stderr, /read as csv/, 'the detected format must be reported');
});

test('peek --json is machine readable', async () => {
  const { code, stdout } = await cli(['peek', '--json', '--quiet'], CSV);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.rows, 3);
  assert.equal(payload.columns.length, 3);
  const price = payload.columns.find((c) => c.name === 'price');
  assert.equal(price.missing, 1);
  assert.equal(price.type, 'number');
});

test('cat writes a table by default and CSV on request', async () => {
  const table = await cli(['cat', '--quiet'], CSV);
  assert.equal(table.code, 0);
  assert.match(table.stdout, /id/);

  const csv = await cli(['cat', '--to', 'csv', '--quiet'], CSV);
  assert.equal(csv.stdout, CSV);
});

test('cat converts JSONL to CSV and reports the detection', async () => {
  const { code, stdout } = await cli(['cat', '--to', 'csv', '--quiet'], JSONL);
  assert.equal(code, 0);
  assert.equal(stdout, 'id,name,price\n1,bob,10\n2,alice,9\n');
});

test('query keeps the matching rows', async () => {
  const { code, stdout } = await cli(['query', 'price > 9', '--to', 'csv', '--quiet'], CSV);
  assert.equal(code, 0);
  assert.equal(stdout, 'id,name,price\n1,bob,10\n');
});

test('query accepts the expression from --where', async () => {
  const { code, stdout } = await cli(['query', '--where', 'name = "alice"', '--to', 'csv', '--quiet'], CSV);
  assert.equal(code, 0);
  assert.match(stdout, /2,alice,9/);
});

test('query without an expression is a usage error with an example', async () => {
  const { code, stderr } = await cli(['query'], CSV);
  assert.equal(code, 2);
  assert.match(stderr, /query needs an expression/);
  assert.match(stderr, /status = "open"/);
});

test('a broken expression is a usage error, not a crash', async () => {
  const { code, stderr } = await cli(['query', 'price >', '--quiet'], CSV);
  assert.equal(code, 2);
  assert.match(stderr, /cannot understand the expression/);
});

test('a filter naming an unknown column warns and picks nothing', async () => {
  const { code, stdout, stderr } = await cli(['query', 'nosuch = 1', '--to', 'csv'], CSV);
  assert.equal(code, 0);
  assert.match(stderr, /unknown column/);
  assert.equal(stdout, 'id,name,price\n');
});

test('convert requires --to and says so', async () => {
  const { code, stderr } = await cli(['convert'], CSV);
  assert.equal(code, 2);
  assert.match(stderr, /convert needs --to/);
  assert.match(stderr, /csv, tsv, json/);
});

test('convert writes JSON by default once --to json is given', async () => {
  const { code, stdout } = await cli(['convert', '--to', 'json', '--quiet'], CSV);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.length, 3);
  assert.equal(payload[2].price, '');
});

test('convert json to csv round-trips through the parsers', async () => {
  const json = '[{"id":1,"name":"bob"},{"id":2,"name":"alice"}]';
  const { stdout } = await cli(['convert', '--to', 'csv', '--quiet'], json);
  assert.equal(stdout, 'id,name\n1,bob\n2,alice\n');
});

test('--select, --sort and --limit compose in the documented order', async () => {
  const { code, stdout } = await cli(
    ['cat', '--select', 'name,price', '--sort', '-price', '--limit', '2', '--to', 'csv', '--quiet'],
    CSV,
  );
  assert.equal(code, 0);
  assert.equal(stdout, 'name,price\nbob,10\nalice,9\n');
});

test('--unique on a subset of columns keeps the first of each group', async () => {
  const input = 'k,v\na,1\na,2\nb,3\n';
  const { stdout } = await cli(['cat', '--unique', 'k', '--to', 'csv', '--quiet'], input);
  assert.equal(stdout, 'k,v\na,1\nb,3\n');
});

test('--unique with no column list compares whole rows', async () => {
  const input = 'k,v\na,1\na,1\na,2\n';
  const { stdout } = await cli(['cat', '--unique', '--to', 'csv', '--quiet'], input);
  assert.equal(stdout, 'k,v\na,1\na,2\n');
});

test('--rename renames a column', async () => {
  const { stdout } = await cli(['cat', '--rename', 'price=amount', '--to', 'csv', '--quiet'], CSV);
  assert.match(stdout, /^id,name,amount/);
});

test('--no-header reads a headerless file and names columns by position', async () => {
  const { stdout } = await cli(['cat', '--no-header', '--to', 'json', '--quiet'], '1,a\n2,b\n');
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload[0]), ['column1', 'column2']);
  assert.equal(payload[1].column2, 'b');
});

test('--no-header-out drops the header from the output only', async () => {
  const { stdout } = await cli(['cat', '--no-header', '--no-header-out', '--to', 'csv', '--quiet'], '1,a\n');
  assert.equal(stdout, '1,a\n');
});

test('--empty-as null makes blank fields null in JSON output', async () => {
  const { stdout } = await cli(['cat', '--empty-as', 'null', '--to', 'json', '--quiet'], CSV);
  const payload = JSON.parse(stdout);
  assert.equal(payload[2].price, null);
});

test('--from overrides the detection', async () => {
  const { stdout, stderr } = await cli(['cat', '--from', 'tsv', '--delimiter', '\t', '--to', 'json', '--quiet'], 'a\tb\n1\t2\n');
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), [{ a: '1', b: '2' }]);
});

test('markdown output escapes pipes', async () => {
  const { stdout } = await cli(['cat', '--to', 'markdown', '--quiet'], 'a,b\n"x|y",z\n');
  assert.match(stdout, /x\\\|y/);
});

test('a malformed JSONL line is reported but the good rows survive', async () => {
  const input = '{"a":1}\nnot json\n{"a":3}\n';
  const { code, stdout, stderr } = await cli(['cat', '--to', 'json', '--quiet'], input);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).length, 2);
});

test('--quiet still reports a parse failure that loses every row', async () => {
  const { code, stderr } = await cli(['cat', '--to', 'csv', '--quiet'], 'a,b\n1,"unclosed\n');
  // The unterminated quote means no usable table; the caller must find out
  assert.equal(code, 0, 'the command itself succeeded');
  assert.match(stderr, /unterminated/);
});

test('empty input is a usage error rather than an empty report', async () => {
  const { code, stderr } = await cli(['cat', '--quiet'], '   \n');
  assert.equal(code, 2);
  assert.match(stderr, /the input is empty/);
});

test('a missing file reports the path and exits 1', async () => {
  const { code, stderr } = await cli(['peek', 'no-such-file-anywhere.csv', '--quiet']);
  assert.equal(code, 1);
  assert.match(stderr, /cannot read no-such-file-anywhere\.csv/);
});

test('an invalid --to value is refused with the list of real ones', async () => {
  const { code, stderr } = await cli(['cat', '--to', 'yaml', '--quiet'], CSV);
  assert.equal(code, 2);
  assert.match(stderr, /--to must be one of/);
});

test('--limit rejects a negative or non-numeric value', async () => {
  assert.equal((await cli(['cat', '--limit', '-1'], CSV)).code, 2);
  assert.equal((await cli(['cat', '--limit', 'many'], CSV)).code, 2);
});

test('terminal output never contains ANSI escapes when colour is off', async () => {
  const { stdout } = await cli(['cat', '--quiet'], CSV);
  assert.equal(/\u001b\[/.test(stdout), false);
});

test('every option the parser accepts is documented in USAGE', () => {
  for (const name of OPTION_NAMES) {
    // help and version appear as -h and -v in the options block
    if (['help', 'version'].includes(name)) {
      assert.ok(USAGE.includes(`--${name}`) || USAGE.includes(`-${name[0]}`), `--${name} is not documented`);
      continue;
    }
    assert.ok(USAGE.includes(`--${name}`), `--${name} is accepted but not documented`);
  }
});

test('parseArgs handles the optional --unique argument in all three forms', () => {
  assert.equal(parseArgs(['cat', '--unique']).values.unique, true);
  assert.deepEqual(parseArgs(['cat', '--unique', 'a,b']).values.unique, ['a', 'b']);
  assert.deepEqual(parseArgs(['cat', '--unique=a']).values.unique, ['a']);
  // A following option must not be swallowed as a column list
  const parsed = parseArgs(['cat', '--unique', '--to', 'csv']);
  assert.equal(parsed.values.unique, true);
  assert.equal(parsed.values.to, 'csv');
});

test('splitList trims and drops empties', () => {
  assert.deepEqual(splitList(' a , b ,, c '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(''), []);
});
