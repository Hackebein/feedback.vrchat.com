// Convert a YouTube / Vimeo / Loom / Wistia URL into the canonical embed URL,
// or recognize a direct video file (mp4/webm/mov/m4v) so callers can render a
// native <video> element. Returns null when the URL is not a recognized video
// host or file so the caller can fall back to rendering it as a still image
// or plain link.

export type VideoEmbed =
  | { kind: "iframe"; src: string; title: string }
  | { kind: "video"; src: string; mime: string };

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.replace(/^\/+/, "").split("/")[0];
    return id || null;
  }
  if (host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com") {
    if (u.pathname === "/watch") {
      return u.searchParams.get("v");
    }
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
    if (m) return m[2];
  }
  if (host === "www.youtube-nocookie.com" || host === "youtube-nocookie.com") {
    const m = u.pathname.match(/^\/embed\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}

function vimeoId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host !== "vimeo.com" && host !== "www.vimeo.com" && host !== "player.vimeo.com") {
    return null;
  }
  const m = u.pathname.match(/\/(\d+)(?:\/([0-9a-f]+))?/);
  if (!m) return null;
  return m[2] ? `${m[1]}?h=${m[2]}` : m[1];
}

function loomId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host !== "www.loom.com" && host !== "loom.com") return null;
  const m = u.pathname.match(/^\/(?:share|embed)\/([0-9a-f]+)/);
  return m ? m[1] : null;
}

function wistiaId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (
    host !== "fast.wistia.net" &&
    host !== "fast.wistia.com" &&
    host !== "wistia.net" &&
    host !== "wistia.com" &&
    !host.endsWith(".wistia.com") &&
    !host.endsWith(".wistia.net")
  ) {
    return null;
  }
  const m = u.pathname.match(/(?:medias|embed\/iframe)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

const DIRECT_VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

function directVideoMime(u: URL): string | null {
  const m = u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  return DIRECT_VIDEO_MIME[m[1]] ?? null;
}

export function detectVideoEmbed(rawUrl: string): VideoEmbed | null {
  const u = safeUrl(rawUrl);
  if (!u) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const yt = youtubeId(u);
  if (yt) {
    return {
      kind: "iframe",
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}`,
      title: "YouTube video",
    };
  }
  const vi = vimeoId(u);
  if (vi) {
    return {
      kind: "iframe",
      src: `https://player.vimeo.com/video/${vi}`,
      title: "Vimeo video",
    };
  }
  const lo = loomId(u);
  if (lo) {
    return {
      kind: "iframe",
      src: `https://www.loom.com/embed/${encodeURIComponent(lo)}`,
      title: "Loom video",
    };
  }
  const wi = wistiaId(u);
  if (wi) {
    return {
      kind: "iframe",
      src: `https://fast.wistia.net/embed/iframe/${encodeURIComponent(wi)}`,
      title: "Wistia video",
    };
  }
  const mime = directVideoMime(u);
  if (mime) {
    return { kind: "video", src: u.toString(), mime };
  }
  return null;
}
