export type FileProxyDisposition = "inline" | "attachment";

export type FileProxySpec = {
  name: string;
  contentType: string;
  disposition: FileProxyDisposition;
};

const FILE_PROXY_TYPES: Record<string, { contentType: string; disposition: FileProxyDisposition }> = {
  txt: { contentType: "text/plain; charset=utf-8", disposition: "inline" },
  csv: { contentType: "text/plain; charset=utf-8", disposition: "inline" },
  json: { contentType: "application/json", disposition: "inline" },
  pdf: { contentType: "application/pdf", disposition: "inline" },
  mp4: { contentType: "video/mp4", disposition: "inline" },
  m4v: { contentType: "video/mp4", disposition: "inline" },
  webm: { contentType: "video/webm", disposition: "inline" },
  mov: { contentType: "video/quicktime", disposition: "inline" },
  avi: { contentType: "video/avi", disposition: "inline" },
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    disposition: "attachment",
  },
  png: { contentType: "image/png", disposition: "inline" },
  jpg: { contentType: "image/jpeg", disposition: "inline" },
  jpeg: { contentType: "image/jpeg", disposition: "inline" },
  gif: { contentType: "image/gif", disposition: "inline" },
  webp: { contentType: "image/webp", disposition: "inline" },
};

const FILE_HOSTS = new Set(["canny-assets.io", "canny.io", "feedback.vrchat.com"]);

const FILE_PATH = /^\/(?:files|api\/files\/download)\/([0-9a-f]{32}\.[a-z0-9]+)$/;

export function fileProxySpec(name: string): FileProxySpec | null {
  if (!/^[0-9a-f]{32}\.[a-z0-9]+$/.test(name)) return null;
  const ext = name.slice(name.indexOf(".") + 1);
  const spec = FILE_PROXY_TYPES[ext];
  if (!spec) return null;
  return { name, contentType: spec.contentType, disposition: spec.disposition };
}

function nameFromReference(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== "443") return null;
    if (!FILE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    pathname = parsed.pathname;
  } else if (!trimmed.startsWith("/")) {
    return null;
  }
  const match = pathname.match(FILE_PATH);
  if (!match) return null;
  return fileProxySpec(match[1])?.name ?? null;
}

export function fileProxyPath(url?: string, downloadURL?: string): string | null {
  const name = nameFromReference(url) ?? nameFromReference(downloadURL);
  return name ? `/files/${name}` : null;
}

export function absoluteFileProxyURL(url?: string, downloadURL?: string): string | null {
  const path = fileProxyPath(url, downloadURL);
  if (!path) return null;
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) return path;
  return new URL(path, origin).href;
}

export function publicFileDownloadURL(name: string): string {
  return `https://feedback.vrchat.com/api/files/download/${name}`;
}
