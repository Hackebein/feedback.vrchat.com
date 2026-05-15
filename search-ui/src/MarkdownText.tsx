import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { detectVideoEmbed } from "./videoEmbed";

const SAFE_HREF = /^(?:https?:|mailto:|#)/i;

function safeHref(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !SAFE_HREF.test(trimmed)) return undefined;
  return trimmed;
}

const components: Components = {
  a({ href, children, ...rest }) {
    const safe = safeHref(href);
    if (!safe) {
      return <span className="markdown-disabled-link">{children}</span>;
    }
    return (
      <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    if (typeof src !== "string" || !src.trim()) {
      return null;
    }
    const embed = detectVideoEmbed(src);
    if (embed) {
      return (
        <iframe
          className="video-embed"
          src={embed.src}
          title={alt || title || embed.title}
          loading="lazy"
          referrerPolicy="no-referrer"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }
    const safe = safeHref(src);
    if (!safe) return null;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer">
        <img
          src={safe}
          alt={alt || ""}
          title={title || undefined}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </a>
    );
  },
};

export function MarkdownText({ source }: { source: string }) {
  if (!source || !source.trim()) {
    return null;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
