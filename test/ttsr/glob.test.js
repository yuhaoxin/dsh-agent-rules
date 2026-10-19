import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGlob, createGlobMatcher } from '../../src/ttsr/glob.js';

test('** 跨路径分隔符，* 与 ? 不跨', () => {
  assert.equal(compileGlob('src/**/*.ts').test('src/x/a.ts'), true);
  assert.equal(compileGlob('src/**/*.ts').test('src/a.ts'), true);
  assert.equal(compileGlob('src/*.ts').test('src/x/a.ts'), false);
  assert.equal(compileGlob('src/*.ts').test('src/a.ts'), true);
  assert.equal(compileGlob('a?c.ts').test('a/c.ts'), false);
  assert.equal(compileGlob('a?c.ts').test('abc.ts'), true);
});

test('`**/` 匹配零个或多个路径段，不会退化成任意字符', () => {
  assert.equal(compileGlob('a/**/b').test('a/b'), true);
  assert.equal(compileGlob('a/**/b').test('a/x/b'), true);
  assert.equal(compileGlob('a/**/b').test('a/xb'), false);
  assert.equal(compileGlob('**/a.ts').test('a.ts'), true);
  assert.equal(compileGlob('**/a.ts').test('xa.ts'), false);
});

test('字符类、否定类与花括号替换', () => {
  assert.equal(compileGlob('[a-c].ts').test('b.ts'), true);
  assert.equal(compileGlob('[!a].ts').test('b.ts'), true);
  assert.equal(compileGlob('[!a].ts').test('a.ts'), false);
  assert.equal(compileGlob('*.{ts,tsx}').test('a.tsx'), true);
  assert.equal(compileGlob('*.{ts,tsx}').test('a.js'), false);
});

test('未闭合的字符类与花括号按字面量处理', () => {
  assert.equal(compileGlob('a[b.ts').test('a[b.ts'), true);
  assert.equal(compileGlob('a{b.ts').test('a{b.ts'), true);
});

test('匹配候选路径的完整路径与 basename', () => {
  const matcher = createGlobMatcher(['*.ts']);
  assert.equal(matcher('src/deep/a.ts'), true);
  assert.equal(matcher('src/deep/a.py'), false);
});

test('模式与被匹配路径的 \\ 都按 / 处理', () => {
  const matcher = createGlobMatcher(['src\\*.ts']);
  assert.equal(matcher('src\\a.ts'), true);
  assert.equal(matcher('src/a.ts'), true);
});
