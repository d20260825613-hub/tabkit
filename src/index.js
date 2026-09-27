/**
 * Library entry point. Everything exported here is supported API; the CLI is a
 * thin wrapper over it, so both front ends behave the same way.
 */

export { EXIT, VERSION, readInput, run, shouldUseColor } from './cli.js';
export {
  ALIASES,
  COMMANDS,
  EMPTY_AS,
  INPUT_FORMATS,
  OPTION_NAMES,
  OUTPUT_FORMATS,
  USAGE,
  parseArgs,
  splitList,
} from './args.js';

export { parseCsv, quoteField, toCsv, uniqueNames } from './csv.js';
export { FORMATS, VALUE_COLUMN, columnsFor, detectFormat, parseJson, parseJsonl, readTable, rowsFromValues } from './parse.js';
export {
  OUTPUT_FORMATS as WRITE_FORMATS,
  cellText,
  describeColumn,
  displayWidth,
  fitCell,
  inferType,
  writeDelimited,
  writeJson,
  writeJsonl,
  writeMarkdown,
  writeRows,
  writeTable,
} from './output.js';
export {
  compare,
  compileFilter,
  evaluateExpression,
  parseExpression,
  referencedColumns,
  tokenize,
  toNumber,
  truthy,
} from './query.js';
export {
  compareCells,
  filterRows,
  flattenColumns,
  limitRows,
  profileColumns,
  profileTable,
  renameColumns,
  selectColumns,
  shapeTable,
  sortRows,
  uniqueRows,
} from './shape.js';
