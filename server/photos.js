import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Contestant photos live in a private Cloudflare R2 bucket and are only ever served through
// photoHandler, which hides unapproved contestants. Without R2 they stay on this machine's disk.
export function createPhotoStore(config) {
  if (!config.r2) {
    return {
      async put(file, body) {
        await fs.mkdir(config.uploadDir, { recursive: true });
        await fs.writeFile(path.join(config.uploadDir, file), body);
      },
      async get(file) {
        return fs.readFile(path.join(config.uploadDir, file)).catch((err) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
      },
    };
  }

  const { endpoint, accessKeyId, secretAccessKey, bucket } = config.r2;
  const s3 = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // Cloudflare's guidance for R2: newer SDK checksum defaults aren't fully supported.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async put(file, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: file, Body: body, ContentType: contentType }));
    },
    async get(file) {
      try {
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file }));
        return Buffer.from(await Body.transformToByteArray());
      } catch (err) {
        if (err.name === 'NoSuchKey') return null;
        throw err;
      }
    },
  };
}
