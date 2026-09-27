#!/usr/bin/env node
/**
 * Test entry point. The file list is explicit because `node --test test/`
 * behaves differently on Node 18, 20, 22 and 24.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILES = [
  'test/csv.test.js',
  'test/parse.test.js',
  'test/query.test.js',
  'test/shape.test.js',
  'test/output.test.js',
  'test/cli.test.js',
];

const result = spawnSync(process.execPath, ['--test', ...TEST_FILES], {
  cwd: projectRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
