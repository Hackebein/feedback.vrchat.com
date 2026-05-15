import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "react-markdown/lib";
import remarkGfm from "remark-gfm";
import { SKIP, visit } from "unist-util-visit";
import { detectVideoEmbed } from "./videoEmbed";
import { VideoEmbedView } from "./VideoEmbedView";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HIGHLIGHT_SKIP_TAGS = new Set(["mark", "code", "pre"]);

function rehypeHighlight(terms: string[]) {
  const filtered = terms.filter((t) => t.length > 0);
  return (tree: unknown) => {
    if (filtered.length === 0) return;
    const pattern = new RegExp(
      `(${filtered.map(escapeRegExp).join("|")})`,
      "gi",
    );
    visit(
      tree as Parameters<typeof visit>[0],
      "text",
      (node, index, parent) => {
        if (parent == null || index == null) return;
        if (
          parent.type === "element" &&
          HIGHLIGHT_SKIP_TAGS.has(
            (parent as { tagName?: string }).tagName ?? "",
          )
        ) {
          return;
        }
        const text = (node as { value: string }).value;
        if (!text) return;
        const newChildren: Array<Record<string, unknown>> = [];
        let lastIdx = 0;
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
          if (m.index > lastIdx) {
            newChildren.push({
              type: "text",
              value: text.slice(lastIdx, m.index),
            });
          }
          newChildren.push({
            type: "element",
            tagName: "mark",
            properties: {},
            children: [{ type: "text", value: m[0] }],
          });
          lastIdx = m.index + m[0].length;
          if (m[0].length === 0) pattern.lastIndex++;
        }
        if (newChildren.length === 0) return;
        if (lastIdx < text.length) {
          newChildren.push({ type: "text", value: text.slice(lastIdx) });
        }
        (parent as { children: unknown[] }).children.splice(
          index,
          1,
          ...newChildren,
        );
        return [SKIP, index + newChildren.length];
      },
    );
  };
}

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
    const embed = detectVideoEmbed(safe);
    if (embed) {
      const linkText = typeof children === "string" ? children : undefined;
      return <VideoEmbedView embed={embed} title={linkText} />;
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
      return <VideoEmbedView embed={embed} title={alt || title} />;
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

export function MarkdownText({
  source,
  highlightTerms,
}: {
  source: string;
  highlightTerms?: string[];
}) {
  const rehypePlugins = useMemo<PluggableList>(() => {
    const terms = highlightTerms?.filter((t) => t.length > 0) ?? [];
    return terms.length > 0 ? [[rehypeHighlight, terms]] : [];
  }, [highlightTerms]);

  if (!source || !source.trim()) {
    return null;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
