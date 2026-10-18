import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SNOWFLOW_LINE = ' * Derived from snowflow_demo by Maksymilian Dendura (Noniv): https://github.com/Noniv/snowflow_demo';
const WEB_OCEAN_LINE = ' * Derived from web-ocean by Maksymilian Dendura (Noniv): https://github.com/Noniv/web-ocean';
const COPYRIGHT_LINE = ' * Copyright (c) 2026 Maksymilian Dendura. MIT License; full text in LICENSE.';
export const ALLOWED_LICENCE_HEADERS = [[SNOWFLOW_LINE], [WEB_OCEAN_LINE], [SNOWFLOW_LINE, WEB_OCEAN_LINE], [WEB_OCEAN_LINE, SNOWFLOW_LINE]]
  .map((derivedLines) => ['/*', ...derivedLines, COPYRIGHT_LINE, ' */'].join('\n'));

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function lineNumberAt(source, index) {
  let line = 1;
  for (let position = 0; position < index && position < source.length; position++) if (source.charCodeAt(position) === 10) line++;
  return line;
}

function endOfLine(source, position) {
  const newline = source.indexOf('\n', position);
  return newline === -1 ? source.length : newline;
}

export function findJavaScriptComments(source, { flagCommentsInTemplateLiterals = true } = {}) {
  const comments = [];
  const addComment = (startIndex, endIndex, kind) => comments.push({ startIndex, endIndex, kind, text: source.slice(startIndex, endIndex) });

  function skipQuotedString(position, quote) {
    let cursor = position + 1;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') { cursor += 2; continue; }
      if (character === quote) return cursor + 1;
      if (character === '\n') return cursor;
      cursor++;
    }
    return cursor;
  }

  function tryScanRegularExpression(position) {
    let cursor = position + 1;
    let insideCharacterClass = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\n') return null;
      if (character === '\\') { cursor += 2; continue; }
      if (character === '[') insideCharacterClass = true;
      else if (character === ']') insideCharacterClass = false;
      else if (character === '/' && !insideCharacterClass) {
        cursor++;
        while (cursor < source.length && /[a-z]/i.test(source[cursor])) cursor++;
        return cursor;
      }
      cursor++;
    }
    return null;
  }

  function scanTemplateLiteral(position) {
    let cursor = position;
    let onlySpaceSinceNewline = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') { cursor += 2; onlySpaceSinceNewline = false; continue; }
      if (character === '`') return cursor + 1;
      if (character === '$' && source[cursor + 1] === '{') {
        cursor = scanCode(cursor + 2, true);
        onlySpaceSinceNewline = false;
        continue;
      }
      if (character === '\n') { onlySpaceSinceNewline = true; cursor++; continue; }
      if (onlySpaceSinceNewline && flagCommentsInTemplateLiterals && character === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) {
        const lineEnd = endOfLine(source, cursor);
        const backtick = source.indexOf('`', cursor);
        addComment(cursor, Math.min(lineEnd, backtick === -1 ? lineEnd : backtick), 'inside a template literal (embedded shader or code)');
      }
      if (character !== ' ' && character !== '\t') onlySpaceSinceNewline = false;
      cursor++;
    }
    return cursor;
  }

  function scanCode(position, insideTemplateExpression) {
    let cursor = position;
    let braceDepth = 0;
    let previous = { type: 'start', text: '' };
    while (cursor < source.length) {
      const character = source[cursor];
      const nextCharacter = source[cursor + 1];
      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') { cursor++; continue; }
      if (character === '/' && nextCharacter === '/') {
        const end = endOfLine(source, cursor);
        addComment(cursor, end, 'line');
        cursor = end;
        continue;
      }
      if (character === '/' && nextCharacter === '*') {
        const close = source.indexOf('*/', cursor + 2);
        const end = close === -1 ? source.length : close + 2;
        addComment(cursor, end, 'block');
        cursor = end;
        continue;
      }
      if (character === "'" || character === '"') {
        cursor = skipQuotedString(cursor, character);
        previous = { type: 'value', text: character };
        continue;
      }
      if (character === '`') {
        cursor = scanTemplateLiteral(cursor + 1);
        previous = { type: 'value', text: '`' };
        continue;
      }
      if (character === '/') {
        const regularExpressionAllowed = previous.type === 'start' || previous.type === 'punctuation' || (previous.type === 'word' && KEYWORDS_BEFORE_EXPRESSION.has(previous.text));
        if (regularExpressionAllowed) {
          const end = tryScanRegularExpression(cursor);
          if (end !== null) {
            cursor = end;
            previous = { type: 'value', text: '/regex/' };
            continue;
          }
        }
        cursor++;
        previous = { type: 'punctuation', text: '/' };
        continue;
      }
      if (character === '{') {
        braceDepth++;
        cursor++;
        previous = { type: 'punctuation', text: '{' };
        continue;
      }
      if (character === '}') {
        if (insideTemplateExpression && braceDepth === 0) return cursor + 1;
        braceDepth--;
        cursor++;
        previous = { type: 'punctuation', text: '}' };
        continue;
      }
      if (/[A-Za-z_$]/.test(character) || character.charCodeAt(0) > 127) {
        let end = cursor + 1;
        while (end < source.length && (/[\w$]/.test(source[end]) || source.charCodeAt(end) > 127)) end++;
        previous = { type: 'word', text: source.slice(cursor, end) };
        cursor = end;
        continue;
      }
      if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(nextCharacter || ''))) {
        let end = cursor + 1;
        while (end < source.length && /[\w.]/.test(source[end])) end++;
        previous = { type: 'value', text: source.slice(cursor, end) };
        cursor = end;
        continue;
      }
      previous = character === ')' || character === ']' ? { type: 'value', text: character } : { type: 'punctuation', text: character };
      cursor++;
    }
    return cursor;
  }

  const start = source.startsWith('#!') ? endOfLine(source, 0) : 0;
  scanCode(start, false);
  return comments;
}

export function findWgslComments(source) {
  const comments = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '/' && source[cursor + 1] === '/') {
      const end = endOfLine(source, cursor);
      comments.push({ startIndex: cursor, endIndex: end, kind: 'line', text: source.slice(cursor, end) });
      cursor = end;
      continue;
    }
    if (source[cursor] === '/' && source[cursor + 1] === '*') {
      let depth = 1;
      let end = cursor + 2;
      while (end < source.length && depth > 0) {
        if (source[end] === '/' && source[end + 1] === '*') { depth++; end += 2; continue; }
        if (source[end] === '*' && source[end + 1] === '/') { depth--; end += 2; continue; }
        end++;
      }
      comments.push({ startIndex: cursor, endIndex: end, kind: 'block', text: source.slice(cursor, end) });
      cursor = end;
      continue;
    }
    cursor++;
  }
  return comments;
}

export function findCssComments(source) {
  const comments = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"' || character === "'") {
      cursor++;
      while (cursor < source.length && source[cursor] !== character && source[cursor] !== '\n') cursor += source[cursor] === '\\' ? 2 : 1;
      cursor++;
      continue;
    }
    if (character === '/' && source[cursor + 1] === '*') {
      const close = source.indexOf('*/', cursor + 2);
      const end = close === -1 ? source.length : close + 2;
      comments.push({ startIndex: cursor, endIndex: end, kind: 'block', text: source.slice(cursor, end) });
      cursor = end;
      continue;
    }
    cursor++;
  }
  return comments;
}

export function findHtmlComments(source) {
  const comments = [];
  let cursor = 0;
  while (cursor < source.length) {
    const nextComment = source.indexOf('<!--', cursor);
    const nextScript = indexOfPattern(source, /<script\b[^>]*>/gi, cursor);
    const nextStyle = indexOfPattern(source, /<style\b[^>]*>/gi, cursor);
    const candidates = [nextComment, nextScript, nextStyle].filter((index) => index !== -1);
    if (!candidates.length) break;
    const first = Math.min(...candidates);
    if (first === nextComment) {
      const close = source.indexOf('-->', first + 4);
      const end = close === -1 ? source.length : close + 3;
      comments.push({ startIndex: first, endIndex: end, kind: 'HTML', text: source.slice(first, end) });
      cursor = end;
      continue;
    }
    const isScript = first === nextScript;
    const openTag = source.slice(first).match(isScript ? /^<script\b[^>]*>/i : /^<style\b[^>]*>/i)[0];
    const contentStart = first + openTag.length;
    const closeIndex = source.slice(contentStart).search(isScript ? /<\/script\s*>/i : /<\/style\s*>/i);
    const contentEnd = closeIndex === -1 ? source.length : contentStart + closeIndex;
    const content = source.slice(contentStart, contentEnd);
    const typeMatch = openTag.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const scriptType = typeMatch ? typeMatch[1].toLowerCase() : '';
    const innerComments = !isScript ? findCssComments(content) : scriptType.includes('wgsl') ? findWgslComments(content) : findJavaScriptComments(content);
    for (const comment of innerComments) comments.push({ ...comment, startIndex: comment.startIndex + contentStart, endIndex: comment.endIndex + contentStart, kind: `${isScript ? 'script' : 'style'} ${comment.kind}` });
    cursor = contentEnd;
  }
  return comments;
}

function indexOfPattern(source, pattern, fromIndex) {
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(source);
  return match ? match.index : -1;
}

export function findCommentsInFile(filePath, source) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.wgsl') return findWgslComments(source);
  if (extension === '.html') return findHtmlComments(source);
  if (extension === '.css') return findCssComments(source);
  return findJavaScriptComments(source);
}

export function checkFile(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const comments = findCommentsInFile(filePath, source);
  return comments
    .filter((comment) => !(comment.startIndex === 0 && ALLOWED_LICENCE_HEADERS.includes(comment.text)))
    .map((comment) => ({ filePath, line: lineNumberAt(source, comment.startIndex), kind: comment.kind, text: comment.text }));
}

function collectFiles(directory, extensions) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, extensions));
    else if (extensions.includes(path.extname(entry.name).toLowerCase())) files.push(entryPath);
  }
  return files;
}

export function defaultFilesToScan(projectRoot) {
  return [
    ...collectFiles(path.join(projectRoot, 'src'), ['.js', '.mjs', '.wgsl', '.css', '.html']),
    ...['index.html', 'vite.config.js'].map((name) => path.join(projectRoot, name)).filter((filePath) => existsSync(filePath)),
    ...collectFiles(path.join(projectRoot, 'tools'), ['.mjs', '.js', '.html']),
  ];
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = process.argv.length > 2 ? process.argv.slice(2).map((filePath) => path.resolve(filePath)) : defaultFilesToScan(projectRoot);
  const offences = files.flatMap(checkFile);
  for (const offence of offences) {
    const shownText = offence.text.split('\n')[0].trim();
    const relativePath = path.relative(process.cwd(), offence.filePath);
    console.log(`${relativePath && !relativePath.startsWith('..') ? relativePath : offence.filePath}:${offence.line}: ${offence.kind} comment: ${shownText.length > 90 ? `${shownText.slice(0, 87)}...` : shownText}`);
  }
  console.log(`\n${files.length} file(s) scanned; ${offences.length ? `${offences.length} comment(s) found. Remove them (only the exact Noniv licence header is allowed, at the very top of a derived file).` : 'no comments found.'}`);
  process.exit(offences.length ? 1 : 0);
}
