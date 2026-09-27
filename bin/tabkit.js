#!/usr/bin/env node
/**
 * tabkit CLI entry point.
 *
 * Process-level concerns live here: EPIPE, unexpected errors, and turning the
 * code from `run()` into an exit status. The library stays free of them.
 */

import process from 'node:process';

import { run } from '../src/cli.js';

const debug = process.argv.includes('--debug') || process.env.TABKIT_DEBUG === '1';

// `tabkit cat big.csv | head` should exit quietly. This matters more here than
// in most tools: the whole point is piping tabkit into other commands.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  throw error;
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`tabkit: unexpected error: ${error?.message ?? error}\n`);
  if (debug) process.stderr.write(`${error?.stack ?? ''}\n`);
  else process.stderr.write('  re-run with --debug for a stack trace\n');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`tabkit: unexpected rejection: ${reason?.message ?? reason}\n`);
  if (debug) process.stderr.write(`${reason?.stack ?? ''}\n`);
  process.exit(1);
});

process.exitCode = await run(process.argv.slice(2));
