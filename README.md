# tabkit

**看一眼、改一改、转个格式** —— 给那些真实工作里堆积起来的表格用的小工具集。零依赖。

```bash
$ tabkit peek sales.csv
tabkit sales.csv — csv, 7 row(s), 6 column(s), 285 byte(s)

COLUMN      TYPE    FILLED  MISSING  DISTINCT  MIN   MAX    SAMPLES
─────────────────────────────────────────────────────────────────────────
region      string  7       0        3                      EU | APAC | EU
product     string  7       0        4                      Widget | Gadget, large | Widget
units       number  7       0        7         0     300    120 | 45 | 80
unit_price  number  7       0        3         9.99  149.5  9.99 | 149.50 | 9.99
status      string  7       0        2                      open | open | closed
note        string  3       4        4                      needs customs form | discontinu…
```

```bash
$ tabkit query 'status = "open" and region in ["EU", "APAC"]' sales.csv -t csv
region,product,units,unit_price,status,note
EU,Widget,120,9.99,open,
APAC,"Gadget, large",45,149.50,open,needs customs form
APAC,Widget,15,9.99,open,
```

*上面的输出是真实运行的（含表头列宽与 CJK 宽度处理），不是示意图。*

---

## 为什么又写一个 CSV 工具

`csvkit`、`xsv`、`miller` 都很好，但在这个场景下都不合适：

| | tabkit | csvkit / xsv / miller |
| --- | --- | --- |
| 安装 | `npx tabkit`，零依赖 | Python 环境或 Rust 二进制 |
| 过滤 | 内建表达式，**不用 eval** | 多半要接 `sqlite`、`jq` 或写脚本 |
| 多格式 | CSV/TSV/JSON/JSONL/Markdown 互转 | 各家支持不一 |
| 定位 | 一个文件、一次读取、够用就走 | 完整数据处理流水线 |

tabkit 不做连接、不做聚合、不做流式处理。它做的是"这个文件里有什么、我要的那几行、换个格式给别人"。

## 安装

```bash
npx tabkit peek data.csv     # 不安装直接跑
npm install -g tabkit        # 或全局安装
```

要求 **Node ≥ 18.17**，零运行时依赖。

## 四个命令

| 命令 | 做什么 |
| --- | --- |
| `peek` | 描述每一列：类型、非空/缺失数、去重数、数值范围、样例 |
| `cat` | 读进来、按选项重塑、写出去 |
| `query <表达式>` | 只保留表达式为真的行 |
| `convert --to <格式>` | 换个格式写出来 |

任何需要文件的地方，写 `-` 或不写就是标准输入。

```bash
tabkit peek data.tsv
tabkit cat data.csv --select region,units --sort -units --limit 10
tabkit query 'units * price > 5000' orders.csv -t csv > big-orders.csv
tabkit convert api.json --to csv
cat events.jsonl | tabkit cat -t markdown
```

## 选项

### 输入

| 选项 | 说明 |
| --- | --- |
| `--from <format>` | 强制输入格式：`csv`/`tsv`/`json`/`jsonl`；默认自动识别 |
| `--delimiter <char>` | 分隔符，默认按格式决定（逗号或制表符） |
| `--header` / `--no-header` | 首行是列名（默认）还是数据 |
| `--empty-as <what>` | 空字段的含义：`empty-string`（默认）或 `null` |

### 输出

| 选项 | 说明 |
| --- | --- |
| `-t, --to <format>` | `csv`/`tsv`/`json`/`jsonl`/`markdown`/`table` |
| `--json` | 等价于 `--to json` |
| `--pretty` | JSON 缩进 |
| `--no-header-out` | csv/tsv 输出不要表头（`--no-header` 管的是**输入**） |

### 重塑

| 选项 | 说明 |
| --- | --- |
| `-s, --select <列>` | 只保留这些列，按给定顺序 |
| `-w, --where <表达式>` | 只保留匹配的行 |
| `--sort <列>` | 排序，`-` 前缀表示降序，如 `--sort -price,name` |
| `--unique [列]` | 去重，可只比较指定列；不给列名则比较整行 |
| `--limit <n>` | 只取前 n 行 |
| `--rename 旧=新` | 重命名列，可重复 |
| `--flatten <列>` | 把嵌套 JSON 值压成紧凑字符串 |

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 读或写失败 |
| 2 | 参数或表达式有错 |

## 表达式语言

这是 tabkit 与 shell 管道配合的关键，也是最需要解释的部分。

```
price > 10                        数值比较
status = "open"                   字符串（单双引号都可以）
region in ["EU", "APAC"]          列表成员
name contains "lic"               子串
name startswith "Al" / endswith "e"
name matches "^A.*e$"             正则
units > 0 and not status = "closed"
units * price > 5000              算术
bracketName("first name") = "Ada" 列名含空格时
```

**两边都是数字时按数字比较，否则按文本比较。** 所以 `--sort price` 会把 9 排在 10 前面，而不是按字典序。

**空字段不是 0。** 这是刻意的：CSV 里的空单元格通常表示"没有这个值"，而不是"值是零"。如果 `price > 0` 把空价格也算进去，几乎每个人的第一份数据清洗都会被坑。

**`0` 是假值，`"0"` 是真值。** 与 JavaScript 不同，与人的直觉一致。

**未知列名求值为 null**，于是过滤器选不到任何东西，并且**会在 stderr 上警告列名不存在**（大概率是拼写错误），而不是静默返回空表。

### 为什么不用 eval

过滤表达式是**跟着文件一起送来的数据**。对数据执行 `eval` 就是远程代码执行，而这个工具的用途恰好是"看看别人发来的文件"。所以这里是真正的词法分析 + 递归下降解析，产出一棵只有本文件能求值的树，它没有任何途径触达外部世界。

## 处理顺序（这是契约，不是实现细节）

```
rename → flatten → where → sort → unique → select → limit
```

- `where` 在 `select` **之前**：拿一列过滤但不打印那一列，是很常见的需求。
- `select` 在 `unique` **之后**：先按整行去重，再投影。
- `limit` 在**最后**：它是"最终结果的前 n 行"。

选项引用了不存在的列时不会报错退出，而是在 stderr 上说明，因为这个工具经常被脚本调用，一个拼写错误不应该让整条流水线失败。

## 格式识别

不强制你声明格式，因为用这个工具的场景往往是"别人发来一个文件"。

识别顺序：**文件扩展名 → 内容**。`{` 开头先试 JSON，不是一个完整 JSON 值就当 JSONL；`[` 开头能解析成 JSON 就当 JSON 数组，否则当分隔符文件；再不然数第一行里逗号、制表符、分号哪个多。

**识别结果会打印在 stderr 上**，猜错时一眼能看到，用 `--from` 覆盖即可。

几个刻意的行为：

- **BOM 会被剥掉。** 否则第一列列名会变成 `\uFEFFid`，之后永远匹配不上。
- **CRLF / LF / CR / 无结尾换行 都能解析。**
- **输出的换行符永远是 LF。** 在 Windows 写的文件用 CRLF，在 Linux 读的时候每一行最后一列都会多一个隐藏字符。
- **`{"data": [...]}` 会解开包装**，但只在数组是**唯一**键时才解 —— 有兄弟键（比如 `meta`）时无法判断意图，猜错会静默丢掉数据。
- **列数不对的行会被补齐并报告**，而不是丢掉。缺一个末尾字段太常见了，那一行仍然有用。
- **引号内的字段可以包含分隔符和换行**，`""` 表示一个引号。这些不是可选功能，真实数据里到处都是。

## 作为库使用

```js
import { readTable, shapeTable, writeRows, compileFilter, parseCsv } from 'tabkit';

const table = readTable(text, { filename: 'data.csv' });
const shaped = shapeTable(table.header, table.rows, {
  where: 'units > 0',
  sort: '-units',
  select: 'region,units',
});

process.stdout.write(writeRows(shaped.header, shaped.rows, { format: 'csv' }));

// 或者只要一个判断函数
const expensive = compileFilter('price > 100');
const picked = table.rows.filter(expensive);
```

`readTable` 返回 `{ header, rows, format, delimiter, detection, errors, meta }`。`shapeTable` 返回 `{ header, rows, notes, error }` —— `notes` 是"哪些选项因为列名不存在而被忽略了"，`error` 只在表达式无法解析或 `--select` 一个列都没匹配上时出现。

## 已验证的边界

- **数据在内存里处理。** 这是给"装得下"的表格用的工具，硬撑流式会换来一套没人需要的 API。
- **不做连接、聚合、分组。** 需要那些就用 SQLite 或 DuckDB，它们做得更好。
- **不写 Excel。** `.xlsx` 是压缩包加 XML，写它需要一个真正的库，会破坏零依赖。
- **表达式语言没有函数。** 没有 `upper()`、`round()`。加函数会把它变成一门要学的语言，而它的价值在于"看一眼就会用"。

## 开发

```bash
npm test      # 148 个用例，6 个文件
npm run e2e   # 30 项端到端检查，跑真实 CLI
npm run check # 语法检查 + 测试
```

> **给用 PowerShell 手测的人**：表达式里的引号需要转义，
> `--where "status = \`"open\`""`。少转义一层会传进去一个被剥掉引号的表达式，
> 表现和"过滤器有 bug"一模一样。`scripts/e2e.js` 直接调用 `run()`，绕开了这个问题。

## 许可

MIT
