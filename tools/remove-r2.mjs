#!/usr/bin/env node
// Delete every object under an R2 prefix - used to un-host a mod when its consent is revoked.
// Credentials come from the environment (see .r2.env), same as upload-r2.mjs.
//
//   set -a; . ./.r2.env; set +a; node tools/remove-r2.mjs --prefix mods/SomeMod

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

async function main() {
  const prefix = (arg('--prefix') || '').replace(/\/+$/, '');
  if (!prefix) throw new Error('need --prefix <key prefix>');
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error('set R2_* in the environment');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  let token, total = 0;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: `${prefix}/`, ContinuationToken: token }));
    const keys = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (keys.length) { await s3.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: keys, Quiet: true } })); total += keys.length; }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
  console.log(`removed ${total} objects under ${prefix}/`);
}
main().catch((e) => { console.error('remove failed:', e.message); process.exit(1); });
