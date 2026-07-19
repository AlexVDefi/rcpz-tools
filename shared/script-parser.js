// Parser for the Project Zomboid script format (module/item/model/attachment blocks).
// Direct ESM port of src/scriptParser.js - pure, no I/O. Tolerant recursive scanner:
// blocks are `<keyword> <name> { ... }`, props are `key = value` (repeats preserved),
// both /* */ and // comments occur.

export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function parseScriptText(text) {
  const src = stripComments(text.replace(/^﻿/, ''));
  let i = 0;
  const n = src.length;
  const isHeaderChar = (ch) => ch !== '{' && ch !== '}' && ch !== '=' && ch !== ',';

  function parseBody(topLevel) {
    const props = new Map();
    const children = [];
    while (i < n) {
      while (i < n && /\s/.test(src[i])) i++;
      if (i >= n) break;
      const ch = src[i];
      if (ch === '}') { i++; break; }
      if (ch === ',') { i++; continue; }
      if (ch === '=') { i++; continue; }
      const start = i;
      while (i < n && isHeaderChar(src[i])) i++;
      const header = src.slice(start, i).trim();
      const next = i < n ? src[i] : '';
      if (next === '{') {
        i++;
        children.push(parseChildBlock(header));
      } else if (next === '=') {
        i++;
        const vStart = i;
        while (i < n && src[i] !== ',' && src[i] !== '}' && src[i] !== '\n') i++;
        const value = src.slice(vStart, i).trim();
        const key = header.trim();
        if (key) {
          if (!props.has(key)) props.set(key, []);
          props.get(key).push(value);
        }
        if (i < n && src[i] === ',') i++;
      } else {
        if (i === start) i++; // guarantee progress
      }
    }
    return { props, children, topLevel };
  }

  function parseChildBlock(header) {
    const parts = header.split(/\s+/).filter(Boolean);
    const type = parts.shift() || '';
    const name = parts.join(' ');
    const body = parseBody(false);
    return { type, name, props: body.props, children: body.children };
  }

  return parseBody(true).children;
}

export function walkBlocks(blocks, fn) {
  for (const b of blocks) {
    fn(b);
    if (b.children && b.children.length) walkBlocks(b.children, fn);
  }
}

export function prop(block, key) {
  const v = block.props.get(key);
  return v && v.length ? v[0] : undefined;
}
