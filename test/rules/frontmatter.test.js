import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontmatter } from '../../src/rules/frontmatter.js';

function createLog() {
  const warnings = [];
  return { warnings, warn(message) { warnings.push(message); } };
}

function wrap(frontmatter, body = '正文') {
  return ['---', frontmatter, '---', body].join('\n');
}

test('没有 frontmatter 时整段文本作为 body', () => {
  const { frontmatter, body } = parseFrontmatter('  只有正文。\n');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '只有正文。');
});

test('只有起始分隔符、没有结束行时整段文本作为 body', () => {
  const text = '---\ndescription: 未闭合\n\n正文';
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepEqual(frontmatter, {});
  assert.equal(body, text.trim());
});

test('body 取结束分隔符之后的内容并去首尾空白', () => {
  const { frontmatter, body } = parseFrontmatter(['---', 'description: 说明', '---', '', '  正文第一行', '第二行  ', ''].join('\n'));
  assert.equal(frontmatter.description, '说明');
  assert.equal(body, '正文第一行\n第二行');
});

test('body 里的 --- 不作为分隔符', () => {
  const { body } = parseFrontmatter(wrap('description: 说明', '第一段\n\n---\n\n第二段'));
  assert.equal(body, '第一段\n\n---\n\n第二段');
});

test('标量：字符串、true/false、null/~ 与空值', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['name: 规则', 'alwaysApply: true', 'disabled: false', 'nothing: null', 'tilde: ~', 'empty:'].join('\n')),
  );
  assert.deepEqual(frontmatter, {
    name: '规则',
    alwaysApply: true,
    disabled: false,
    nothing: null,
    tilde: null,
    empty: null,
  });
});

test('引号字符串去掉引号并处理转义', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['double: "说 \\"引号\\" 与 \\\\ 反斜杠"', "single: 'it''s'"].join('\n')),
  );
  assert.equal(frontmatter.double, '说 "引号" 与 \\ 反斜杠');
  assert.equal(frontmatter.single, "it's");
});

test('引号里的 # 不当注释，引号外的行尾 # 去掉', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['quoted: "a # b"', 'plain: 值 # 说明', 'bare: 值#不是注释', '# 整行注释', 'next: 1'].join('\n')),
  );
  assert.equal(frontmatter.quoted, 'a # b');
  assert.equal(frontmatter.plain, '值');
  assert.equal(frontmatter.bare, '值#不是注释');
  assert.equal(frontmatter.next, '1');
});

test('flow 序列支持裸值、引号与嵌套逗号', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['globs: [**/*.ts, "**/*.tsx", \'a,b\']', 'empty: []', 'numbers: [1, true]'].join('\n')),
  );
  assert.deepEqual(frontmatter.globs, ['**/*.ts', '**/*.tsx', 'a,b']);
  assert.deepEqual(frontmatter.empty, []);
  assert.deepEqual(frontmatter.numbers, ['1', true]);
});

test('块序列收集后续的 - item 行', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['condition:', '  - 第一项', '  - "第二项"', 'other: 值'].join('\n')),
  );
  assert.deepEqual(frontmatter.condition, ['第一项', '第二项']);
  assert.equal(frontmatter.other, '值');
});

test('kebab-case 键名归一为 camelCase，未知键原样保留', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['always-apply: true', 'interrupt-mode: never', 'ttsr_trigger: TODO', 'unknown-key: 保留'].join('\n')),
  );
  assert.deepEqual(frontmatter, {
    alwaysApply: true,
    interruptMode: 'never',
    ttsr_trigger: 'TODO',
    unknownKey: '保留',
  });
});

test('坏 frontmatter 记 warning 后退回逐行解析', () => {
  const log = createLog();
  const { frontmatter, body } = parseFrontmatter(
    wrap(['description: "未闭合', 'condition: needle', 'always-apply: true'].join('\n')),
    { path: '/repo/.agents/rules/bad.md', log },
  );
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /frontmatter 解析失败/);
  assert.match(log.warnings[0], /bad\.md/);
  assert.deepEqual(frontmatter, {
    description: '"未闭合',
    condition: 'needle',
    alwaysApply: true,
  });
  assert.equal(body, '正文');
});

test('退回路径保留 flow 序列的解析', () => {
  const { frontmatter } = parseFrontmatter(
    wrap(['globs: [a, b]', 'name: [未闭合'].join('\n')),
    { path: 'x.md', log: createLog() },
  );
  assert.deepEqual(frontmatter.globs, ['a', 'b']);
});

test('文件开头的 BOM 不影响首行分隔符识别', () => {
  const { frontmatter, body } = parseFrontmatter('\uFEFF' + wrap('description: 说明'));
  assert.equal(frontmatter.description, '说明');
  assert.equal(body, '正文');
});

test('缩进的嵌套映射不在支持范围内，整段跳过且不报错', () => {
  const log = createLog();
  const { frontmatter } = parseFrontmatter(
    wrap(['description: x', 'metadata:', '  author: y', '  tags: [a, b]', 'globs:', '  - a'].join('\n')),
    { log },
  );
  assert.deepEqual(frontmatter, { description: 'x', metadata: null, globs: ['a'] });
  assert.deepEqual(log.warnings, []);
});

test('CRLF 换行的文件按 LF 解析，body 也归一为 LF', () => {
  const text = ['---', 'description: 说明', 'globs:', '  - a', '  - b', '---', '正文', '第二行', ''].join('\r\n');
  const { frontmatter, body } = parseFrontmatter(text);
  assert.deepEqual(frontmatter, { description: '说明', globs: ['a', 'b'] });
  assert.equal(body, '正文\n第二行');
});

test('不传 log 时坏 frontmatter 不抛错', () => {
  const { frontmatter } = parseFrontmatter(wrap('condition: "未闭合'));
  assert.equal(frontmatter.condition, '"未闭合');
});
