import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * File storage port. Swap adapters with STORAGE_DRIVER (default `local`):
 *   local  → on-disk (dev/single-box)
 *   memory → in-process (tests)
 *   s3     → S3-compatible (AWS S3 / Cloudflare R2 / MinIO) — requires S3_* env
 * A new backend = a class implementing Storage + a case in createStorage(). No other code changes.
 */
export interface Storage {
  driver: string;
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; mime: string } | null>;
  urlFor(key: string): string;
}

const sanitize = (key: string) => key.replace(/[^a-zA-Z0-9._-]/g, "_");

class MemoryStorage implements Storage {
  driver = "memory";
  private blobs = new Map<string, { data: Buffer; mime: string }>();
  async put(key: string, data: Buffer, mime: string) {
    this.blobs.set(key, { data, mime });
  }
  async get(key: string) {
    return this.blobs.get(key) ?? null;
  }
  urlFor(key: string) {
    return `/files/${encodeURIComponent(key)}`;
  }
}

class LocalDiskStorage implements Storage {
  driver = "local";
  private mimes = new Map<string, string>();
  constructor(private dir: string) {
    this.dir = resolve(dir);
  }
  private path(key: string) {
    return join(this.dir, sanitize(key));
  }
  async put(key: string, data: Buffer, mime: string) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(key), data);
    this.mimes.set(key, mime);
  }
  async get(key: string) {
    try {
      return { data: await readFile(this.path(key)), mime: this.mimes.get(key) ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
  urlFor(key: string) {
    return `/files/${encodeURIComponent(key)}`;
  }
}

/** S3-compatible (AWS S3 / Cloudflare R2 / MinIO). Lazy-loads the SDK so it's never required unless selected. */
class S3Storage implements Storage {
  driver = "s3";
  private client: unknown;
  private ready: Promise<void>;
  constructor(
    private bucket: string,
    private publicBase: string | undefined,
    cfg: { region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.ready = import("@aws-sdk/client-s3").then(({ S3Client }) => {
      this.client = new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: Boolean(cfg.endpoint),
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
    });
  }
  async put(key: string, data: Buffer, mime: string) {
    await this.ready;
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (this.client as { send: (c: unknown) => Promise<unknown> }).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mime }),
    );
  }
  async get(key: string) {
    await this.ready;
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    try {
      const res = (await (this.client as { send: (c: unknown) => Promise<{ Body: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string }> }).send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      ));
      return { data: Buffer.from(await res.Body.transformToByteArray()), mime: res.ContentType ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
  urlFor(key: string) {
    return this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/${key}` : `/files/${encodeURIComponent(key)}`;
  }
}

export function createStorage(): Storage {
  const driver = process.env.STORAGE_DRIVER ?? "local";
  if (driver === "memory") return new MemoryStorage();
  if (driver === "s3") {
    const bucket = process.env.S3_BUCKET;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) {
      throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
    }
    return new S3Storage(bucket, process.env.S3_PUBLIC_BASE_URL, {
      region: process.env.S3_REGION ?? "auto",
      endpoint: process.env.S3_ENDPOINT, // set for R2/MinIO; omit for AWS
      accessKeyId,
      secretAccessKey,
    });
  }
  return new LocalDiskStorage(process.env.FILES_DIR ?? "./.loose-files");
}
