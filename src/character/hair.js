'use strict';

// Hair + beard styles (main process). Parses the flat style manifests and
// resolves a chosen style to a loadable mesh + texture. Colour is applied at
// render time as an RGB TintColour multiply over the near-white texture, so it
// is not resolved here.

const fs = require('fs');
const { resolveMesh, resolveTexture, lookup } = require('../vfs');
const { ensureGlb } = require('../convert');

// The manifests are simple flat element trees; a tolerant block/scalar extractor
// is enough and avoids an XML dependency.
function blocks(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function scalar(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function styleFrom(block) {
  // <alternate category="default" style="Hat" /> -> swap style when a matching hat is worn
  const alternates = {};
  const altRe = /<alternate\s+category="([^"]*)"\s+style="([^"]*)"\s*\/>/g;
  let a; while ((a = altRe.exec(block))) alternates[a[1].toLowerCase()] = a[2];
  return {
    name: scalar(block, 'name'),
    model: scalar(block, 'model'),                 // '' = no mesh (e.g. Bald)
    texture: scalar(block, 'texture') || 'F_Hair_White',
    level: parseInt(scalar(block, 'level'), 10) || 0,
    alternates,
  };
}

/** Parse hairStyles.xml -> { male:[style], female:[style] }. */
function parseHairStyles(vfs) {
  const file = lookup(vfs, 'media/hairstyles/hairstyles.xml');
  if (!file) return { male: [], female: [] };
  const xml = fs.readFileSync(file, 'utf8');
  const list = (g) => blocks(xml, g).map(styleFrom).filter((s) => s.name);
  return { male: list('male'), female: list('female') };
}

/** Parse beardStyles.xml -> [style]. */
function parseBeardStyles(vfs) {
  const file = lookup(vfs, 'media/hairstyles/beardstyles.xml');
  if (!file) return [];
  const xml = fs.readFileSync(file, 'utf8');
  return blocks(xml, 'style').map(styleFrom).filter((s) => s.name);
}

/** Resolve + convert one style's mesh. Returns null for a model-less style (bald/none). */
function resolveStyle(vfs, style) {
  if (!style || !style.model) return { name: style ? style.name : 'None', hasMesh: false };
  const mesh = resolveMesh(vfs, style.model);
  if (!mesh || mesh.unsupported) return { name: style.name, hasMesh: false, error: `mesh not found: ${style.model}` };
  const glb = ensureGlb(mesh.file, mesh.format);
  const texture = resolveTexture(vfs, style.texture);
  if (!texture) return { name: style.name, hasMesh: false, error: `texture not found: ${style.texture}` };
  return { name: style.name, hasMesh: true, meshFile: glb.file, texture };
}

module.exports = { parseHairStyles, parseBeardStyles, resolveStyle };
