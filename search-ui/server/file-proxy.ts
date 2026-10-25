import { Readable, Transform } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import type { Request, RequestHandler, Response } from "express";
import { fileProxySpec, publicFileDownloadURL, type FileProxySpec } from "../src/fileUrl";

export const FILE_PROXY_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_PROXY_USER_AGENT = "vrchat-feedback-search-file-proxy";

const UPSTREAM_TIMEOUT_MS = 180_000;
const S3_HOSTS = new Set([
  "product-pains-images.s3.us-east-1.amazonaws.com",
  "canny-private-assets.s3.us-east-1.amazonaws.com",
]);

export type FileProxyOptions = {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  maxPerWindow?: number;
  windowMs?: number;
  maxInFlightPerIp?: number;
  maxInFlight?: number;
};

type Bucket = { hits: number[]; inFlight: number };

function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress ?? "";
  const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (local) {
    const real = req.get("x-real-ip")?.trim();
    if (real) return real;
  }
  return peer || "unknown";
}

function cdnFileURL(name: string): string {
  return `https://canny-assets.io/files/${name}`;
}

// S3 signs response-content-disposition into the presigned query, so the
// redirect cannot be rewritten. Stream the body and set our own headers.
function allowedS3Target(location: string, name: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  if (!S3_HOSTS.has(parsed.hostname)) return null;
  if (parsed.pathname !== `/files/${name}`) return null;
  return parsed.toString();
}

function headerNumber(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function objectSize(upstream: globalThis.Response): number | null {
  const range = upstream.headers.get("content-range");
  if (range) {
    const match = /^bytes \d+-\d+\/(\d+)$/.exec(range.trim());
    if (!match) return null;
    return headerNumber(match[1]);
  }
  if (upstream.status === 206) return null;
  return headerNumber(upstream.headers.get("content-length"));
}

async function discard(upstream: globalThis.Response): Promise<void> {
  await upstream.body?.cancel().catch(() => undefined);
}

async function openUpstream(
  name: string,
  range: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ ok: true; response: globalThis.Response } | { ok: false; status: number }> {
  const headers = new Headers({
    "User-Agent": FILE_PROXY_USER_AGENT,
    "Accept-Encoding": "identity",
  });
  if (range) headers.set("Range", range);

  const cdn = await fetchImpl(cdnFileURL(name), {
    method: "GET",
    redirect: "manual",
    headers,
    signal,
  });
  if (cdn.status === 200 || cdn.status === 206) {
    return { ok: true, response: cdn };
  }
  await discard(cdn);
  if (cdn.status !== 404) return { ok: false, status: 502 };

  const downloadHeaders = new Headers({
    "User-Agent": FILE_PROXY_USER_AGENT,
    "Accept-Encoding": "identity",
  });
  const download = await fetchImpl(publicFileDownloadURL(name), {
    method: "GET",
    redirect: "manual",
    headers: downloadHeaders,
    signal,
  });
  if (download.status === 200 || download.status === 206) {
    return { ok: true, response: download };
  }
  const redirected = download.status === 301 || download.status === 302 || download.status === 307 || download.status === 308;
  const location = download.headers.get("location");
  await discard(download);
  if (!redirected) return { ok: false, status: download.status === 404 ? 404 : 502 };
  const target = location ? allowedS3Target(location, name) : null;
  if (!target) return { ok: false, status: 404 };

  const s3 = await fetchImpl(target, {
    method: "GET",
    redirect: "manual",
    headers,
    signal,
  });
  if (s3.status === 301 || s3.status === 302 || s3.status === 307 || s3.status === 308) {
    await discard(s3);
    return { ok: false, status: 404 };
  }
  if (s3.status !== 200 && s3.status !== 206) {
    await discard(s3);
    return { ok: false, status: s3.status === 404 ? 404 : 502 };
  }
  return { ok: true, response: s3 };
}

function writeHeaders(res: Response, upstream: globalThis.Response, spec: FileProxySpec): void {
  res.status(upstream.status);
  res.setHeader("Content-Type", spec.contentType);
  res.setHeader("Content-Disposition", `${spec.disposition}; filename="${spec.name}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Referrer-Policy", "no-referrer");
  const length = headerNumber(upstream.headers.get("content-length"));
  if (length !== null) res.setHeader("Content-Length", String(length));
  const range = upstream.headers.get("content-range")?.trim() ?? "";
  if (upstream.status === 206 && /^bytes \d+-\d+\/(\d+|\*)$/.test(range)) {
    res.setHeader("Content-Range", range);
  }
}

export function createFileProxy(options: FileProxyOptions = {}): RequestHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? FILE_PROXY_MAX_BYTES;
  const maxPerWindow = options.maxPerWindow ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  const maxInFlightPerIp = options.maxInFlightPerIp ?? 8;
  const maxInFlight = options.maxInFlight ?? 32;
  const buckets = new Map<string, Bucket>();
  let globalInFlight = 0;

  return (req, res) => {
    void serve(req, res).catch(() => {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
  };

  async function serve(req: Request, res: Response): Promise<void> {
    const rawName = req.params.name;
    const spec = fileProxySpec(typeof rawName === "string" ? rawName : "");
    if (!spec) {
      res.status(404).end();
      return;
    }

    const now = Date.now();
    const ip = clientIp(req);
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { hits: [], inFlight: 0 };
      buckets.set(ip, bucket);
    }
    bucket.hits = bucket.hits.filter((stamp) => now - stamp < windowMs);
    if (bucket.hits.length >= maxPerWindow || bucket.inFlight >= maxInFlightPerIp || globalInFlight >= maxInFlight) {
      if (bucket.hits.length === 0 && bucket.inFlight === 0) buckets.delete(ip);
      res.setHeader("Retry-After", "1");
      res.status(429).end();
      return;
    }
    bucket.hits.push(now);
    bucket.inFlight += 1;
    globalInFlight += 1;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", onClose);
    try {
      const range = req.get("range")?.trim();
      const opened = await openUpstream(spec.name, range || undefined, fetchImpl, abort.signal);
      if (!opened.ok) {
        res.status(opened.status).end();
        return;
      }
      const size = objectSize(opened.response);
      if (size !== null && size > maxBytes) {
        await discard(opened.response);
        res.redirect(302, publicFileDownloadURL(spec.name));
        return;
      }
      writeHeaders(res, opened.response, spec);
      if (req.method === "HEAD" || !opened.response.body) {
        await discard(opened.response);
        res.end();
        return;
      }
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.length;
          if (seen > maxBytes) {
            abort.abort();
            callback(new Error("file proxy size cap"));
            return;
          }
          callback(null, chunk);
        },
      });
      const source = Readable.fromWeb(opened.response.body as ReadableStream<Uint8Array>);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        source.on("error", (err: Error) => settle(err));
        cap.on("error", (err: Error) => settle(err));
        res.on("error", (err: Error) => settle(err));
        res.on("finish", () => settle());
        res.on("close", () => {
          if (!res.writableEnded) settle(new Error("file proxy closed"));
        });
        source.pipe(cap).pipe(res);
      });
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
      bucket.inFlight -= 1;
      globalInFlight -= 1;
      if (bucket.hits.length === 0 && bucket.inFlight === 0) buckets.delete(ip);
    }
  }
}
