/**
 * End-to-end checks: run the real CLI against real files and assert on stdout.
 *
 * The CLI is driven in-process rather than spawned, which keeps the assertions
 * about tabkit rather than about Node's spawn path. Note on the shell: a
 * PowerShell caller must escape the quotes inside an expression
 * (`` --where "status = \`"open\`"" ``), and getting that wrong passes a
 * stripped expression and looks exactly like a filter bug. This script avoids
 * the question by calling `run()` directly.
 *
 * Usage: node scripts/e2e.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const { run } = await import('../src/cli.js');

const SAMPLE_CSV = `region,product,units,unit_price,status,note
EU,Widget,120,9.99,open,
APAC,"Gadget, large",45,149.50,open,needs customs form
EU,Widget,80,9.99,closed,
US,"Thing ""Pro""",300,19.95,open,
APAC,Widget,15,9.99,open,
EU,Gadget,60,149.50,closed,discontinued
US,Widget,0,9.99,open,free sample
`;

const SAMPLE_JSON = JSON.stringify(
  [
    { id: 1, user: { name: 'ada', lang: 'js' }, tags: ['a', 'b'], score: 91 },
    { id: 2, user: { name: 'bob', lang: 'py' }, tags: [], score: 74 },
    { id: 3, user: { name: 'cyd', lang: 'js' }, tags: ['b'], score: 88 },
  ],
  null,
  1,
);

async function cli(argv, stdin = '') {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: { write: (c) => (stdout += c), isTTY: false },
    stderr: { write: (c) => (stderr += c), isTTY: false },
    env: { NO_COLOR: '1' },
    readStdin: async () => stdin,
  });
  return { code, stdout, stderr };
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabkit-e2e-'));
const csvPath = path.join(dir, 'sales.csv');
const jsonPath = path.join(dir, 'records.json');
fs.writeFileSync(csvPath, SAMPLE_CSV);
fs.writeFileSync(jsonPath, SAMPLE_JSON);

try {
  // 1. peek ---------------------------------------------------------------
  const peek = await cli(['peek', csvPath]);
  check('peek exits 0', peek.code === 0, `exit ${peek.code}`);
  check('peek found all 6 columns', ['region', 'product', 'units', 'unit_price', 'status', 'note'].every((n) => peek.stdout.includes(n)));
  check('peek reports the row count', /7 row\(s\)/.test(peek.stdout));
  check('peek reports the detected format on stderr', /read as csv/.test(peek.stderr));

  const peekJson = await cli(['peek', csvPath, '--json', '--quiet']);
  const profile = JSON.parse(peekJson.stdout);
  check('peek --json is valid JSON', profile.rows === 7 && profile.columns.length === 6);
  const note = profile.columns.find((c) => c.name === 'note');
  check('peek counts missing values', note.missing === 4, `missing ${note.missing}`);

  // 2. query -------------------------------------------------------------
  const query = await cli(['query', 'status = "open" and region in ["EU", "APAC"]', csvPath, '--to', 'csv', '--quiet']);
  const queryLines = query.stdout.trim().split('\n');
  check('query keeps exactly the matching rows', queryLines.length === 4, `${queryLines.length} lines`);
  check('query kept the EU row', query.stdout.includes('EU,Widget,120'));
  check('query dropped the closed rows', query.stdout.includes('closed') === false);

  const arithmetic = await cli(['query', 'units * unit_price > 5000', csvPath, '--to', 'csv', '--quiet']);
  check('arithmetic on two columns works', arithmetic.stdout.includes('300,19.95') && arithmetic.stdout.includes('60,149.50'));

  const emptyIsNotZero = await cli(['query', 'note != null and note contains "customs"', csvPath, '--to', 'csv', '--quiet']);
  check('string operators work', emptyIsNotZero.stdout.includes('customs form'));

  // 3. reshape -----------------------------------------------------------
  const shaped = await cli(['cat', csvPath, '--select', 'region,units', '--sort', '-units', '--limit', '2', '--to', 'csv', '--quiet']);
  check('select+sort+limit compose', shaped.stdout === 'region,units\nUS,300\nEU,120\n', JSON.stringify(shaped.stdout));

  const deduped = await cli(['cat', csvPath, '--unique', 'region,product', '--to', 'csv', '--quiet']);
  const dedupedLines = deduped.stdout.trim().split('\n');
  // Six distinct region+product pairs, so six data rows plus the header.
  check('unique on two columns collapses the duplicate EU/Widget', dedupedLines.length === 7, `${dedupedLines.length} lines`);
  check('unique kept the first of the duplicate pair', deduped.stdout.includes('EU,Widget,120') && !deduped.stdout.includes('EU,Widget,80'));

  const renamed = await cli(['cat', csvPath, '--rename', 'unit_price=price', '--to', 'csv', '--quiet']);
  check('rename changes the header', renamed.stdout.startsWith('region,product,units,price,status,note'));

  // 4. formats -----------------------------------------------------------
  const markdown = await cli(['cat', csvPath, '--select', 'product,units', '--to', 'markdown', '--quiet']);
  check('markdown output is a table', markdown.stdout.startsWith('| product | units |\n| --- | --- |'));
  check('a comma inside a value does not break the CSV', (await cli(['cat', csvPath, '--to', 'csv', '--quiet'])).stdout.includes('"Gadget, large"'));

  const jsonOut = JSON.parse((await cli(['cat', csvPath, '--to', 'json', '--quiet'])).stdout);
  check('json output is an array of objects', Array.isArray(jsonOut) && jsonOut.length === 7);
  check('a blank cell is an empty string by default', jsonOut[0].note === '');

  const nullOut = JSON.parse((await cli(['cat', csvPath, '--empty-as', 'null', '--to', 'json', '--quiet'])).stdout);
  check('--empty-as null makes blanks null', nullOut[0].note === null);

  // 5. nested JSON -------------------------------------------------------
  const nested = JSON.parse((await cli(['cat', jsonPath, '--to', 'json', '--quiet'])).stdout);
  check('nested JSON survives as structure', typeof nested[0].user === 'object' && Array.isArray(nested[0].tags));

  const flat = await cli(['cat', jsonPath, '--flatten', 'user,tags', '--to', 'csv', '--quiet']);
  check('--flatten stringifies only the named columns', flat.stdout.includes('"{""name"":""ada"",""lang"":""js""}"'));

  const jsonToCsv = await cli(['convert', jsonPath, '--to', 'csv', '--quiet']);
  check('convert json to csv works', jsonToCsv.code === 0 && jsonToCsv.stdout.startsWith('id,user,tags,score'));

  // 6. stdin -------------------------------------------------------------
  const piped = await cli(['cat', '--to', 'csv', '--quiet'], SAMPLE_CSV);
  check('reading from stdin works when no file is given', piped.stdout.startsWith('region,product'));

  const pipedDash = await cli(['cat', '-', '--to', 'csv', '--quiet'], SAMPLE_CSV);
  check('"-" also means stdin', pipedDash.stdout === piped.stdout);

  // 7. failures are reported, not hidden ---------------------------------
  const badExpression = await cli(['query', 'units >', csvPath, '--quiet']);
  check('a broken expression is exit 2', badExpression.code === 2, `exit ${badExpression.code}`);
  check('the expression error names the problem', /cannot understand the expression/.test(badExpression.stderr));

  const unknownColumn = await cli(['query', 'nosuch = 1', csvPath, '--to', 'csv']);
  check('an unknown column still exits 0', unknownColumn.code === 0);
  check('but says the column is unknown', /unknown column/.test(unknownColumn.stderr), unknownColumn.stderr.trim());

  const quietUnknown = await cli(['query', 'nosuch = 1', csvPath, '--to', 'csv', '--quiet']);
  check('--quiet suppresses the advisory unknown-column warning', quietUnknown.stderr === '', quietUnknown.stderr.trim());

  const badTo = await cli(['cat', csvPath, '--to', 'yaml', '--quiet']);
  check('an invalid output format is refused', badTo.code === 2 && /--to must be one of/.test(badTo.stderr));

  const missingFile = await cli(['peek', path.join(dir, 'nope.csv'), '--quiet']);
  check('a missing file is exit 1', missingFile.code === 1, `exit ${missingFile.code}`);

  const malformed = await cli(['cat', '--to', 'csv', '--quiet'], 'a,b\n1,"unclosed\n');
  check('an unterminated quote is reported even with --quiet', /unterminated/.test(malformed.stderr), malformed.stderr.trim());

  const empty = await cli(['cat', '--quiet'], '   \n');
  check('empty input is a usage error', empty.code === 2 && /the input is empty/.test(empty.stderr));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nend-to-end: all checks passed' : `\nend-to-end: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
