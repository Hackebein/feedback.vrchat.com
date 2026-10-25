import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { createFileProxy, FILE_PROXY_MAX_BYTES, FILE_PROXY_USER_AGENT, type FileProxyOptions } from "../server/file-proxy";
import { absoluteFileProxyURL, fileProxyPath, publicFileDownloadURL } from "../src/fileUrl";

const txtName = "bc83c22f1652cd39750c5434ccde3d4f.txt";
const mp4Name = "ebc01293067f71eb6da75560f76f7a14.mp4";
const movName = "b47b233076ae0d0b2e78c6da985a92e5.mov";
const htmlName = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html";
const docxName = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.docx";
const imageName = "772b654d959aaa899ebf97b3f889a986.png";

assert.equal(fileProxyPath(`https://canny-assets.io/files/${txtName}`), `/files/${txtName}`);
assert.equal(fileProxyPath(`/api/files/download/${txtName}`), `/files/${txtName}`);
assert.equal(
  fileProxyPath(`https://feedback.vrchat.com/api/files/download/${txtName}?x=1`),
  `/files/${txtName}`,
);
assert.equal(fileProxyPath(`https://canny.io/files/${movName}`), `/files/${movName}`);
assert.equal(fileProxyPath(`https://canny-assets.io/images/${imageName}`), null);
assert.equal(fileProxyPath(`https://canny-assets.io/icons/${imageName}`), null);
assert.equal(fileProxyPath(`https://evil.example/files/${txtName}`), null);
assert.equal(fileProxyPath(`https://user:pass@canny-assets.io/files/${txtName}`), null);
assert.equal(fileProxyPath(`http://canny-assets.io/files/${txtName}`), null);
assert.equal(fileProxyPath(`https://canny-assets.io:444/files/${txtName}`), null);
assert.equal(fileProxyPath(`/files/${htmlName}`), null);
assert.equal(fileProxyPath("not a url", `/api/files/download/${txtName}`), `/files/${txtName}`);
assert.equal(publicFileDownloadURL(txtName), `https://feedback.vrchat.com/api/files/download/${txtName}`);

const previousLocation = (globalThis as { location?: { origin?: string } }).location;
(globalThis as { location?: { origin?: string } }).location = {
  origin: "https://vrchat-canny.hackebein.dev",
};
try {
  assert.equal(
    absoluteFileProxyURL(`https://canny-assets.io/files/${txtName}`),
    `https://vrchat-canny.hackebein.dev/files/${txtName}`,
  );
} finally {
  (globalThis as { location?: { origin?: string } }).location = previousLocation;
}

type Hop = {
  host: string;
  path: string;
  range: string | null;
  cookie: string | null;
  ua: string | null;
  encoding: string | null;
};

function mockFetch(handle: (url: URL) => Response): { hops: Hop[]; fetchImpl: typeof fetch } {
  const hops: Hop[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const headers = new Headers(init?.headers);
    hops.push({
      host: url.hostname,
      path: url.pathname,
      range: headers.get("range"),
      cookie: headers.get("cookie"),
      ua: headers.get("user-agent"),
      encoding: headers.get("accept-encoding"),
    });
    return handle(url);
  };
  return { hops, fetchImpl };
}

function textResponse(body: string, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers });
}

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

async function withProxy(
  fetchImpl: typeof fetch,
  options: FileProxyOptions,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.get("/files/:name", createFileProxy({ ...options, fetchImpl }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function request(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function header(headers: http.IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value !== "string") {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const s3Host = "canny-private-assets.s3.us-east-1.amazonaws.com";
const legacyS3Host = "product-pains-images.s3.us-east-1.amazonaws.com";

function s3URL(host: string, name: string): string {
  return `https://${host}/files/${name}?sig=test`;
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io" && url.pathname === `/files/${txtName}`) {
      return textResponse("Hello!", {
        "content-type": "text/html",
        "content-disposition": "attachment; filename=\"evil.html\"",
      });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`, { Cookie: "session=secret" });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString("utf8"), "Hello!");
    assert.equal(header(res.headers, "content-type"), "text/plain; charset=utf-8");
    assert.equal(header(res.headers, "content-disposition"), `inline; filename="${txtName}"`);
    assert.equal(header(res.headers, "x-content-type-options"), "nosniff");
    assert.equal(header(res.headers, "content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(header(res.headers, "cache-control"), "public, max-age=3600");
    assert.equal(res.body.includes("sig="), false);
  });
  assert.equal(hops.length, 1);
  assert.equal(hops[0]?.host, "canny-assets.io");
  assert.equal(hops[0]?.cookie, null);
  assert.equal(hops[0]?.ua, FILE_PROXY_USER_AGENT);
  assert.equal(hops[0]?.encoding, "identity");
}

{
  const { hops, fetchImpl } = mockFetch(() => {
    throw new Error("fetch should not run");
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const html = await request(`${base}/files/${htmlName}`);
    const bad = await request(`${base}/files/not-a-hash`);
    const upper = await request(`${base}/files/${txtName.toUpperCase()}`);
    assert.equal(html.status, 404);
    assert.equal(bad.status, 404);
    assert.equal(upper.status, 404);
  });
  assert.equal(hops.length, 0);
}

{
  const ftyp = Buffer.from("\u0000\u0000\u0000 ftypmp42\u0000\u0000\u0000", "latin1");
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(404);
    if (url.hostname === "feedback.vrchat.com" && url.pathname === `/api/files/download/${mp4Name}`) {
      return empty(302, { location: s3URL(s3Host, mp4Name) });
    }
    if (url.hostname === s3Host && url.pathname === `/files/${mp4Name}`) {
      return new Response(ftyp, {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-range": "bytes 0-15/650828",
          "content-length": String(ftyp.length),
          "content-disposition": "attachment; filename=\"clip.mp4\"",
        },
      });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${mp4Name}`, { Range: "bytes=0-15" });
    assert.equal(res.status, 206);
    assert.equal(header(res.headers, "content-type"), "video/mp4");
    assert.equal(header(res.headers, "content-range"), "bytes 0-15/650828");
    assert.equal(header(res.headers, "content-disposition"), `inline; filename="${mp4Name}"`);
    assert.equal(res.body.toString("latin1").includes("ftyp"), true);
  });
  assert.deepEqual(
    hops.map((hop) => `${hop.host}${hop.path} range=${hop.range ?? ""}`),
    [
      `canny-assets.io/files/${mp4Name} range=bytes=0-15`,
      `feedback.vrchat.com/api/files/download/${mp4Name} range=`,
      `${s3Host}/files/${mp4Name} range=bytes=0-15`,
    ],
  );
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") {
      return empty(200, { "content-length": String(FILE_PROXY_MAX_BYTES + 1) });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, { maxBytes: 32 }, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 302);
    assert.equal(header(res.headers, "location"), publicFileDownloadURL(txtName));
    assert.equal(res.body.includes("sig="), false);
  });
  assert.equal(hops.length, 1);
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(404);
    if (url.hostname === "feedback.vrchat.com") {
      return empty(302, { location: "https://canny.io/login" });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 404);
  });
  assert.deepEqual(
    hops.map((hop) => hop.host),
    ["canny-assets.io", "feedback.vrchat.com"],
  );
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(404);
    if (url.hostname === "feedback.vrchat.com") {
      return empty(302, { location: s3URL(legacyS3Host, txtName) });
    }
    if (url.hostname === legacyS3Host) {
      return empty(302, { location: s3URL(s3Host, txtName) });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 404);
  });
  assert.deepEqual(
    hops.map((hop) => hop.host),
    ["canny-assets.io", "feedback.vrchat.com", legacyS3Host],
  );
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(500);
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 502);
  });
  assert.equal(hops.length, 1);
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") {
      return empty(302, { location: s3URL(s3Host, txtName) });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 502);
  });
  assert.deepEqual(
    hops.map((hop) => hop.host),
    ["canny-assets.io"],
  );
}

{
  const { fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(404);
    if (url.hostname === "feedback.vrchat.com") {
      return empty(302, { location: s3URL(s3Host, mp4Name) });
    }
    if (url.hostname === s3Host) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "content-range": `bytes 0-3/${FILE_PROXY_MAX_BYTES + 1}`,
          "content-length": "4",
        },
      });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${mp4Name}`, { Range: "bytes=0-3" });
    assert.equal(res.status, 302);
    assert.equal(header(res.headers, "location"), publicFileDownloadURL(mp4Name));
  });
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io") return empty(404);
    if (url.hostname === "feedback.vrchat.com") {
      return empty(302, { location: `https://evil.example/files/${txtName}` });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, {}, async (base) => {
    const res = await request(`${base}/files/${txtName}`);
    assert.equal(res.status, 404);
  });
  assert.deepEqual(
    hops.map((hop) => hop.host),
    ["canny-assets.io", "feedback.vrchat.com"],
  );
}

{
  const { hops, fetchImpl } = mockFetch((url) => {
    if (url.hostname === "canny-assets.io" && url.pathname === `/files/${docxName}`) {
      return textResponse("docx", { "content-type": "text/html" });
    }
    throw new Error(`unexpected upstream ${url.hostname}${url.pathname}`);
  });
  await withProxy(fetchImpl, { maxPerWindow: 1 }, async (base) => {
    const first = await request(`${base}/files/${docxName}`);
    const second = await request(`${base}/files/${docxName}`);
    assert.equal(first.status, 200);
    assert.equal(
      header(first.headers, "content-disposition"),
      `attachment; filename="${docxName}"`,
    );
    assert.equal(
      header(first.headers, "content-type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.equal(second.status, 429);
    assert.equal(header(second.headers, "retry-after"), "1");
  });
  assert.equal(hops.length, 1);
}

console.info("file proxy ok");
