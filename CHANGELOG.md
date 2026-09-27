# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-27

First release. 148 tests across 6 files plus 30 end-to-end checks.

### Added

- **`tabkit peek`**: describe a table's columns — type, filled and missing
  counts, distinct count, numeric range, and sample values — with column widths
  that count CJK characters as two, so a table of Chinese values lines up.
- **`tabkit cat`**: read, reshape and write. Options for selecting columns,
  filtering, sorting, deduplicating, limiting, renaming and flattening.
- **`tabkit query <expression>`**: a real expression language — comparisons,
  `and`/`or`/`not`, arithmetic, `contains`/`startswith`/`endswith`/`matches`,
  list membership, and list literals.
- **`tabkit convert --to <format>`**: CSV, TSV, JSON, JSONL, Markdown and
  aligned plain text.
- **Format detection** from the extension and the content, with the guess
  reported on stderr and `--from` to override it.
- **RFC 4180 CSV** including quoted delimiters, embedded newlines, doubled
  quotes, a UTF-8 BOM, CRLF/LF/CR line endings, and a final row without a
  trailing newline.
- **Nothing runs through `eval`.** A filter string is data that arrives with the
  file; the expression language is a real tokenizer and recursive-descent parser
  producing a tree only this package can evaluate.
- Library API: `readTable`, `parseCsv`, `shapeTable`, `writeRows`,
  `compileFilter`, `parseExpression`, `evaluateExpression`, `profileTable`.
- Zero runtime dependencies. Requires Node >= 18.17.

### Design decisions worth stating

- **An empty field is not zero.** `price > 0` skips rows where price is blank,
  because a blank CSV cell almost always means "no value", not "the value zero".
- **`0` is falsy and `"0"` is truthy**, matching the obvious reading rather than
  JavaScript's.
- **A value that looks numeric compares numerically**, so `price > 9` does not
  order `9` after `10` as text would.
- **The shaping order is a contract**: rename → flatten → where → sort → unique →
  select → limit. `where` runs before `select` so a filter may name a column the
  output does not include.
- **An unknown column warns instead of failing.** A typo in a filter selects
  nothing, and the warning says so on stderr; exiting non-zero would break the
  pipelines this tool is meant to sit in.
- **`--quiet` does not silence data loss.** It suppresses advisory messages, but
  a malformed file that dropped rows is always reported.

### Fixed during development

Each was found by running the real CLI against real files; the tests now pin them:

- **`--unique <columns>` with a comma list was ignored.** The optional argument
  was only consumed when the next token did not start with `-`, and a column
  list such as `region,product` was fine — but the original check used a broader
  test that treated any non-option as absent. It now distinguishes an option
  token from a value, so `--unique region,product` and `--unique --to csv` both
  behave.
- **`tabkit help` was rejected as an unknown command.** `help` is what a user
  types after a failed attempt, and it was not in the command list.
- **`--version` printed the usage text.** Both flags parse to the same command
  name, and the help branch ran first.
- **`--quiet` suppressed a parse failure that lost every row.** An unterminated
  quote produced no table at all, and the message went through the advisory path.
  Data-losing problems now use an always-on channel.
- **`fitCell` counted characters instead of display width**, so a column of CJK
  values drifted one column wider per value. It now pads by display width and
  truncates without splitting a wide character.
- **`readTable` returned no `meta` for a malformed file**, so `peek` reported a
  byte count of `undefined`.
- **A single-key wrapper object was unwrapped even with sibling keys**, which
  silently dropped the siblings. It only unwraps when the array is the only key.

[Unreleased]: https://github.com/d20260825613-hub/tabkit/commits/main
[0.1.0]: https://github.com/d20260825613-hub/tabkit/releases/tag/v0.1.0
