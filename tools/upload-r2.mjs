#!/usr/bin/env node
// Upload a baked bundle to a Cloudflare R2 bucket (S3-compatible). Content-hashed assets are
// immutable (cache forever); the manifest is short-cached so a version bump propagates. Keys
// are prefixed by version, so multiple game versions coexist in one bucket:
//   <bucket>/<version>/manifest.json
//   <bucket>/<version>/assets/<hash>.<ext>
// so the app's VITE_HOSTED_ASSETS_URL is <public-base>/<version>/.
//
// Credentials come from env (never args), e.g. a gitignored file you `source` first:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//
//   node tools/upload-r2.mjs --bundle asset-bake/42            # prefix defaults to the dir name (42)
//   node tools/upload-r2.mjs --bundle asset-bake/42 --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const TYPES = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.x': 'application/octet-stream' };

function* walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(full, r);
    else yield { full, rel: r };
  }
}

async function pool(items, n, fn) {
  let i = 0, done = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); if (++done % 200 === 0) process.stdout.write(`  ${done}/${items.length}\r`); }
  });
  await Promise.all(workers);
  process.stdout.write(`  ${done}/${items.length}\n`);
}

async function main() {
  const bundle = path.resolve(REPO_ROOT, arg('--bundle', 'asset-bake/42'));
  const prefix = arg('--prefix', path.basename(bundle)); // version, e.g. "42"
  const dryRun = has('--dry-run');
  const concurrency = parseInt(arg('--concurrency', '32'), 10);
  const skipExisting = !has('--force');

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!fs.existsSync(path.join(bundle, 'manifest.json'))) throw new Error(`no manifest.json in ${bundle} - run the bake first`);
  if (!dryRun && (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET))
    throw new Error('set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET in the environment (or pass --dry-run)');

  const files = [...walk(bundle)];
  const total = files.reduce((s, f) => s + fs.statSync(f.full).size, 0);
  console.log(`Bundle : ${bundle}`);
  console.log(`Bucket : ${R2_BUCKET || '(dry-run)'} / prefix "${prefix}/"`);
  console.log(`Files  : ${files.length} (${mb(total)})${dryRun ? '  [DRY RUN]' : ''}\n`);
  if (dryRun) {
    for (const f of files.slice(0, 4)) console.log(`  would put ${prefix}/${f.rel}`);
    console.log(`  ... and ${files.length - 4} more`);
    console.log(`\nApp URL would be: <public-base>/${prefix}/`);
    return;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  let put = 0, skipped = 0;
  await pool(files, concurrency, async (f) => {
    const key = `${prefix}/${f.rel}`;
    const isAsset = f.rel.startsWith('assets/');
    if (skipExisting && isAsset) { // content-hashed -> immutable, so an existing key is identical
      try { await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })); skipped++; return; } catch { /* not there, upload */ }
    }
    const ext = path.extname(f.full).toLowerCase();
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: fs.readFileSync(f.full),
      ContentType: TYPES[ext] || 'application/octet-stream',
      CacheControl: isAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    }));
    put++;
  });

  console.log(`\nUploaded ${put}, skipped ${skipped} (already present).`);
  console.log(`Set VITE_HOSTED_ASSETS_URL=<public-base>/${prefix}/ and redeploy the web app.`);
}
main().catch((e) => { console.error('upload failed:', e.message); process.exit(1); });
