/**
 * 规则文件的 YAML frontmatter 解析。
 *
 * 插件只解析自身依赖，yaml 包不在可解析范围内，所以这里实现规则文件用到的
 * 那部分 YAML 语法：顶层 `键: 值`、标量、flow 序列 `[a, b]`、块序列
 * （后续的 `- item` 行）与行尾 `#` 注释。不支持嵌套映射、多行标量与锚点。
 *
 * 解析入口约定：
 * - 只有首行是 `---` 且之后存在独立的 `---` 结束行时才解析 frontmatter；
 *   否则 frontmatter 是空对象，整段文本作为 body。
 * - body 是结束行之后的内容，去掉首尾空白；body 里的 `---` 不作为分隔符。
 * - 键名 kebab-case 归一为 camelCase（`always-apply` → `alwaysApply`），
 *   未知键原样保留，由调用方决定是否使用。
 * - 空值（`key:` 后面没有内容）按 YAML 语义解析为 null。
 * - 行尾统一按 `\n` 处理：`\r\n` 先归一为 `\n`，返回的 body 也是 `\n` 换行，
 *   规则文件在 Windows 检出下同样可解析；文件开头的 BOM 一并去掉。
 * - 块内出现无法识别的行、未闭合的引号或 flow 序列时，整块退回逐行解析并记
 *   warning；退回路径只保留 `键: 值` 行，块序列会丢失。
 */

const KEY_LINE = /^([\w-]+):\s*(.*)$/;
const LIST_ITEM = /^\s*-\s+(.*)$/;

/**
 * 解析规则文件的 frontmatter。
 *
 * @param {string} text 规则文件全文
 * @param {{ path?: string, log?: { warn: (message: string) => void } }} [context]
 *   `path` 只用于 warning 文案；不传 `log` 时解析失败不报告
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(text, { path, log } = {}) {
  const source = normalize(text);
  const lines = source.split('\n');
  const close = closingDelimiter(lines);
  if (lines[0].trim() !== '---' || close === -1) return { frontmatter: {}, body: source.trim() };

  const block = lines.slice(1, close).join('\n');
  const body = lines.slice(close + 1).join('\n').trim();
  try {
    return { frontmatter: parseBlock(block), body };
  } catch (error) {
    log?.warn?.(`[agent-rules] 规则文件 ${path} 的 frontmatter 解析失败，按逐行解析：${error.message}`);
    return { frontmatter: parseLines(block), body };
  }
}

/** 去掉文件开头的 BOM，并把 `\r\n` 归一为 `\n`。 */
function normalize(text) {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return withoutBom.replaceAll('\r\n', '\n');
}

/** 第一个独立 `---` 行的下标；没有结束行时返回 -1。 */
function closingDelimiter(lines) {
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return index;
  }
  return -1;
}

/**
 * 解析 frontmatter 块。无法识别的顶层行直接抛错，由调用方退回逐行解析；
 * 缩进的嵌套内容（如 `metadata:` 下的映射）不在支持范围内，整段跳过。
 */
function parseBlock(source) {
  const frontmatter = {};
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isIgnorable(line) || /^\s/.test(line)) continue;

    const match = KEY_LINE.exec(line);
    if (!match) throw new Error(`无法识别的行：${line.trim()}`);
    const [, key, rest] = match;
    const value = stripComment(rest).trim();
    if (value.length > 0) {
      frontmatter[normalizeKey(key)] = parseScalar(value);
      continue;
    }

    const items = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (isIgnorable(next)) {
        index += 1;
        continue;
      }
      const item = LIST_ITEM.exec(next);
      if (!item) break;
      items.push(parseScalar(stripComment(item[1]).trim()));
      index += 1;
    }
    frontmatter[normalizeKey(key)] = items.length > 0 ? items : null;
  }
  return frontmatter;
}

/**
 * 逐行解析：只收 `键: 值` 行，单行值尽量按标量与 flow 序列解析，失败时保留
 * 原字符串。块序列的行在这里被忽略。
 */
function parseLines(source) {
  const frontmatter = {};
  for (const line of source.split('\n')) {
    const match = KEY_LINE.exec(line);
    if (!match) continue;
    const value = stripComment(match[2]).trim();
    frontmatter[normalizeKey(match[1])] = parseValueOrText(value);
  }
  return frontmatter;
}

function parseValueOrText(value) {
  try {
    return parseScalar(value);
  } catch {
    return value;
  }
}

/** 解析单个标量：引号字符串、flow 序列、布尔、null 与普通字符串。 */
function parseScalar(value) {
  if (value.length === 0) return null;
  const first = value[0];
  if (first === '"') return parseDoubleQuoted(value);
  if (first === "'") return parseSingleQuoted(value);
  if (first === '[') return parseFlowSequence(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  return value;
}

/** 双引号字符串：去掉引号，`\"` 与 `\\` 还原为 `"` 与 `\`。 */
function parseDoubleQuoted(value) {
  if (value.at(-1) !== '"') throw new Error(`引号未闭合：${value}`);
  let text = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      text += char;
      continue;
    }
    const next = value[index + 1];
    if (next !== '"' && next !== '\\') {
      text += char;
      continue;
    }
    text += next;
    index += 1;
  }
  return text;
}

/** 单引号字符串：去掉引号，`''` 还原为 `'`。 */
function parseSingleQuoted(value) {
  if (value.at(-1) !== "'") throw new Error(`引号未闭合：${value}`);
  return value.slice(1, -1).replaceAll("''", "'");
}

/** flow 序列：`[a, b]`；项按标量递归解析，允许嵌套方括号与花括号。 */
function parseFlowSequence(value) {
  if (value.at(-1) !== ']') throw new Error(`flow 序列未闭合：${value}`);
  const inner = value.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return splitFlowItems(inner).map((item) => parseScalar(item.trim()));
}

function splitFlowItems(text) {
  const items = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

/**
 * 去掉行尾注释：`#` 位于行首或前面是空白才算注释，引号内的 `#` 保留。
 */
function stripComment(value) {
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index);
  }
  return value;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/** `always-apply` → `alwaysApply`；下划线不在归一范围内，旧键名原样保留。 */
function normalizeKey(key) {
  return key.replaceAll(/-([\w])/g, (_, char) => char.toUpperCase());
}
