/**
 * 规则发现：扫描项目级与用户级规则目录，读取 frontmatter 与正文，产出描述符。
 *
 * 目录顺序即规则优先级，同名规则 first-wins：
 *
 * 1. 项目级：从 `cwd` 逐层向上，直到含 `.git` 的目录（含该目录）；每层依次看
 *    `<dir>/.agent/rules` 与 `<dir>/.agents/rules`。向上遍历跳过 home 目录本身，
 *    用户级扫描会覆盖它。
 * 2. 用户级：`~/.agent/rules`、`~/.agents/rules`。
 * 3. `extraDirectories`：按给定顺序追加，每项展开开头的 `~`；相对路径按 `cwd`
 *    解析。
 *
 * 只读目录的直接子文件，不递归；只收 `.md` 与 `.mdc`，同一目录内按文件名排序。
 * 规则目录与规则文件都是可选的：目录不存在视为没有规则，其它读取错误记 warning
 * 后跳过，不抛错。
 *
 * 描述符字段：
 *
 * ```js
 * {
 *   name: string,                       // 文件名去掉扩展名
 *   path: string,                       // 规则文件绝对路径
 *   body: string,                       // frontmatter 之后的正文，已去首尾空白
 *   description?: string,               // 去掉首尾空白后非空才保留
 *   alwaysApply: boolean,               // frontmatter 里严格为 true 才是 true
 *   globs?: string | string[],          // 缺省 undefined；显式空数组保留为 []
 *   condition?: string[],               // 兼容旧键 ttsr_trigger / ttsrTrigger
 *   astCondition?: string[],
 *   question?: string,
 *   scope?: string[],                   // 逗号切分，尊重括号与引号
 *   interruptMode?: string,             // never / prose-only / tool-only / always
 *   agents?: string[],                  // 逗号切分并小写；v1 不实现过滤
 *   level: 'project' | 'user',
 * }
 * ```
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { parseFrontmatter } from './frontmatter.js';

/** 规则目录相对每一层工作目录的位置，顺序即同层内的扫描顺序。 */
const RULE_DIRECTORIES = ['.agent/rules', '.agents/rules'];

/** 规则文件扩展名；`a.md` 与 `a.mdc` 去掉扩展名后同名，按同名规则去重。 */
const RULE_EXTENSIONS = ['.md', '.mdc'];

const INTERRUPT_MODES = ['never', 'prose-only', 'tool-only', 'always'];

/**
 * 发现规则。
 *
 * @param {{
 *   cwd?: string,
 *   home?: string,
 *   extraDirectories?: readonly string[],
 *   log?: { warn: (message: string) => void },
 * }} [options] `cwd` 是项目级遍历的起点，`home` 是用户级目录的基准
 * @returns {Promise<{ rules: object[], warnings: string[] }>}
 */
export async function discoverRules({ cwd = process.cwd(), home = homedir(), extraDirectories = [], log = console } = {}) {
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    log.warn(message);
  };

  const rules = [];
  const seen = new Map();
  for (const { directory, level } of await ruleDirectories({ cwd, home, extraDirectories })) {
    for (const file of await listRuleFiles(directory, warn)) {
      const name = ruleName(file);
      const rule = await readRule(file, name, level, warn);
      if (!rule) continue;
      if (seen.has(name)) {
        warn(`[agent-rules] 规则 ${name} 与 ${seen.get(name)} 同名，忽略 ${file}`);
        continue;
      }
      seen.set(name, file);
      rules.push(rule);
    }
  }
  return { rules, warnings };
}

/**
 * 按优先级展开规则目录。
 */
async function ruleDirectories({ cwd, home, extraDirectories }) {
  const root = resolve(cwd);
  const homeDirectory = resolve(home);
  const directories = await projectDirectories(root, homeDirectory);
  for (const relative of RULE_DIRECTORIES) {
    directories.push({ directory: join(homeDirectory, relative), level: 'user' });
  }
  for (const extra of extraDirectories) {
    directories.push({ directory: resolve(root, expandHome(extra, homeDirectory)), level: 'user' });
  }
  return directories;
}

/**
 * 项目级规则目录：从 cwd 向上到含 `.git` 的目录为止。没有 `.git` 时走到根目录。
 */
async function projectDirectories(cwd, home) {
  const directories = [];
  let directory = cwd;
  for (;;) {
    if (directory !== home) {
      for (const relative of RULE_DIRECTORIES) {
        directories.push({ directory: join(directory, relative), level: 'project' });
      }
    }
    if (await hasGit(directory)) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directories;
}

/** `.git` 可能是目录，也可能是 worktree 里的文件。 */
async function hasGit(directory) {
  try {
    await stat(join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 列出目录的直接子规则文件，按文件名排序。符号链接交给读取阶段处理：链接指向
 * 目录或已失效时读文件失败，按读取失败记 warning，不会静默丢失规则。
 */
async function listRuleFiles(directory, warn) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') warn(`[agent-rules] 规则目录读取失败：${directory}（${error.message}）`);
    return [];
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && isRuleFile(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(directory, name));
}

function isRuleFile(name) {
  return RULE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function ruleName(file) {
  const extension = RULE_EXTENSIONS.find((candidate) => file.endsWith(candidate));
  return basename(file, extension);
}

/**
 * 读取单个规则文件并产出描述符。读取失败与 `enabled: false` 都返回 null。
 */
async function readRule(file, name, level, warn) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    warn(`[agent-rules] 规则文件读取失败：${file}（${error.message}）`);
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(text, { path: file, log: { warn } });
  if (frontmatter.enabled === false) return null;

  return {
    name,
    path: file,
    body,
    description: textOrUndefined(frontmatter.description),
    alwaysApply: frontmatter.alwaysApply === true,
    globs: globsOf(frontmatter.globs),
    condition: triggerList(frontmatter.condition ?? frontmatter.ttsrTrigger ?? frontmatter.ttsr_trigger),
    astCondition: triggerList(frontmatter.astCondition),
    question: textOrUndefined(frontmatter.question),
    scope: scopeTokens(frontmatter.scope),
    interruptMode: interruptModeOf(frontmatter.interruptMode, name, warn),
    agents: agentsOf(frontmatter.agents),
    level,
  };
}

function textOrUndefined(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * `globs` 保留 frontmatter 里的形态：单字符串仍是字符串，数组仍是数组（显式空数组
 * 保留为 `[]`）。非字符串项丢弃。
 */
function globsOf(value) {
  if (typeof value === 'string') return textOrUndefined(value);
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((glob) => typeof glob === 'string')
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

/**
 * 触发条件归一为去重后的字符串数组：`condition` 与 `astCondition` 的每一项都是
 * 独立的正则，空数组等价于没有声明。
 */
function triggerList(value) {
  const items = (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

/**
 * scope 按逗号切分，括号与引号内的逗号不切：`tool:edit(*.{ts,tsx})` 是一个 token。
 */
function scopeTokens(value) {
  const tokens = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string') continue;
    for (const raw of splitCommas(item)) {
      const token = unquote(raw.trim());
      if (token.length === 0 || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens.length > 0 ? tokens : undefined;
}

function splitCommas(text) {
  const tokens = [];
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
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  tokens.push(current);
  return tokens;
}

function unquote(token) {
  if (token.length < 2) return token;
  const first = token[0];
  if ((first === '"' || first === "'") && token.at(-1) === first) return token.slice(1, -1).trim();
  return token;
}

function agentsOf(value) {
  const items = (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function interruptModeOf(value, name, warn) {
  if (value === undefined) return undefined;
  const mode = typeof value === 'string' ? value.trim() : value;
  if (INTERRUPT_MODES.includes(mode)) return mode;
  warn(`[agent-rules] 规则 ${name} 的 interruptMode 无法识别：${value}，忽略该字段`);
  return undefined;
}

/** `~/x` 展开到 home；`~` 单独出现时展开为 home 本身。 */
function expandHome(directory, home) {
  if (directory === '~') return home;
  if (directory.startsWith('~/')) return join(home, directory.slice(2));
  return directory;
}
