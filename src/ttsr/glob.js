/**
 * 规则 glob 匹配。
 *
 * 插件在 DSH 进程里只解析自身依赖，应用内的 picomatch 不在插件可解析范围内，
 * 所以这里实现规则文件需要的那部分 glob 语法：`*`、`**`、`?`、`[...]`、`{a,b}`。
 * `**` 跨路径分隔符，`*` 和 `?` 不跨。
 *
 * 匹配口径沿用 omp：`\` 归一为 `/`；先匹配完整路径，再匹配 basename。
 */

const REGEX_META = /[.+^$()|[\]\\]/;

/**
 * 把单个 glob 编译成整串匹配的正则。
 *
 * 模式里的 `\` 按路径分隔符处理：被匹配的路径已经归一为 `/`，Windows 风格的
 * 写法要能命中同样的路径。
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function compileGlob(glob) {
  return new RegExp(`^${translate(glob.replaceAll('\\', '/'))}$`);
}

/**
 * 编译规则级或 scope 内的 glob 集合。
 *
 * @param {readonly string[]} globs 至少一项
 * @returns {(path: string) => boolean}
 */
export function createGlobMatcher(globs) {
  const patterns = globs.map((glob) => compileGlob(glob));
  return (path) => {
    const normalized = path.replaceAll('\\', '/');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return patterns.some((pattern) => pattern.test(normalized) || pattern.test(basename));
  };
}

function translate(glob) {
  let out = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] !== '*') {
        out += '[^/]*';
        index += 1;
        continue;
      }
      if (glob[index + 2] === '/') {
        // `**/` 匹配零个或多个路径段：`**/*.ts` 要能命中根目录下的 `a.ts`。
        out += '(?:[^/]*/)*';
        index += 3;
        continue;
      }
      out += '.*';
      index += 2;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const end = glob.indexOf(']', index + 1);
      if (end === -1) {
        out += '\\[';
        index += 1;
        continue;
      }
      let body = glob.slice(index + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      index = end + 1;
      continue;
    }
    if (char === '{') {
      const end = matchBrace(glob, index);
      if (end === -1) {
        out += '\\{';
        index += 1;
        continue;
      }
      const alternatives = splitAlternatives(glob.slice(index + 1, end));
      out += `(?:${alternatives.map(translate).join('|')})`;
      index = end + 1;
      continue;
    }
    out += REGEX_META.test(char) ? `\\${char}` : char;
    index += 1;
  }
  return out;
}

function matchBrace(glob, start) {
  let depth = 0;
  for (let index = start; index < glob.length; index += 1) {
    if (glob[index] === '{') depth += 1;
    else if (glob[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitAlternatives(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}
