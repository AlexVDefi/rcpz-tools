'use strict';

// Parser for the Project Zomboid script format (module / item / model / attachment blocks).
//
// The format is loose: blocks are `<keyword> <name> { ... }`, properties are
// `key = value` terminated by a comma, `}`, or newline, keys may repeat, and both
// `/* */` and `//` comments occur. We only need enough fidelity to pull item fields
// (Icon, WeaponSprite, WorldStaticModel, StaticModel) and model blocks (mesh, texture,
// scale), so this is a tolerant recursive scanner, not a strict grammar.

/**
 * @typedef {Object} Block
 * @property {string} type    keyword, e.g. "module" | "item" | "model" | "attachment" | "imports"
 * @property {string} name    declared name (may be "" for e.g. imports)
 * @property {Map<string,string[]>} props  property key -> list of raw values (repeats preserved)
 * @property {Block[]} children nested blocks
 * @property {string} [file]  source file, attached by parseFiles
 */

function stripComments(text) {
  // Remove /* ... */ (non-greedy, across lines) then // ... to end of line.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Parse cleaned script text into top-level blocks.
 * @param {string} text
 * @returns {Block[]}
 */
function parseScriptText(text) {
  const src = stripComments(text.replace(/^﻿/, ''));
  let i = 0;
  const n = src.length;

  function isHeaderChar(ch) {
    return ch !== '{' && ch !== '}' && ch !== '=' && ch !== ',';
  }

  // Parse the body of a block until the matching '}' (or EOF at top level).
  function parseBody(topLevel) {
    const props = new Map();
    const children = [];
    while (i < n) {
      // skip whitespace
      while (i < n && /\s/.test(src[i])) i++;
      if (i >= n) break;
      const ch = src[i];
      if (ch === '}') { i++; break; }
      if (ch === ',') { i++; continue; }
      if (ch === '=') { i++; continue; } // stray '='

      // Read a header run: everything up to { = , } (this is either a block
      // header "type name" or a property key).
      const start = i;
      while (i < n && isHeaderChar(src[i])) i++;
      const header = src.slice(start, i).trim();
      const next = i < n ? src[i] : '';

      if (next === '{') {
        i++; // consume '{'
        const child = parseChildBlock(header);
        children.push(child);
      } else if (next === '=') {
        i++; // consume '='
        // value runs to the next , } or newline
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
        // bare token (e.g. inside `imports { Base }`) or trailing junk; ignore.
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

  const top = parseBody(true);
  return top.children;
}

/**
 * Walk a block tree, yielding every block (depth-first, including nested).
 * @param {Block[]} blocks
 * @param {(b: Block) => void} fn
 */
function walkBlocks(blocks, fn) {
  for (const b of blocks) {
    fn(b);
    if (b.children && b.children.length) walkBlocks(b.children, fn);
  }
}

/** First raw value for a key, or undefined. */
function prop(block, key) {
  const v = block.props.get(key);
  return v && v.length ? v[0] : undefined;
}

module.exports = { parseScriptText, walkBlocks, stripComments, prop };
