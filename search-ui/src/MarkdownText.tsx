import { useMemo } from "react";
import type { Code, Extension, Tokenizer } from "micromark-util-types";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "react-markdown/lib";
import remarkGfm from "remark-gfm";
import type {} from "remark-parse";
import type { Processor } from "unified";
import { SKIP, visit } from "unist-util-visit";
import { EmbeddedImageView } from "./EmbeddedImageView";
import { absoluteFileProxyURL } from "./fileUrl";
import { detectVideoEmbed } from "./videoEmbed";
import { VideoEmbedView } from "./VideoEmbedView";

function isHandleCharacter(code: Code): boolean {
  return code !== null && code >= 0 && /[\p{L}\p{M}\p{N}_-]/u.test(String.fromCharCode(code));
}

const tokenizeMention: Tokenizer = (effects, ok, nok) => {
  function handle(code: Code) {
    if (isHandleCharacter(code)) {
      effects.consume(code);
      return handle;
    }
    effects.exit("data");
    return ok(code);
  }

  return (code) => {
    // Read the whole handle as text before Markdown processes underscores.
    effects.enter("data");
    effects.consume(code);
    return (first) => (isHandleCharacter(first) ? handle(first) : nok(first));
  };
};

const mentionExtension: Extension = {
  text: {
    ["@".charCodeAt(0)]: {
      previous: (code) => !isHandleCharacter(code),
      tokenize: tokenizeMention,
    },
  },
};

function remarkMentions(this: Processor) {
  (this.data().micromarkExtensions ??= []).push(mentionExtension);
}

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
    const display = absoluteFileProxyURL(safe) ?? safe;
    const embed = detectVideoEmbed(display);
    if (embed) {
      const linkText = typeof children === "string" ? children : undefined;
      return <VideoEmbedView embed={embed} title={linkText} />;
    }
    return (
      <a {...rest} href={display} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    if (typeof src !== "string" || !src.trim()) {
      return null;
    }
    const safe = safeHref(src);
    if (!safe) return null;
    const display = absoluteFileProxyURL(safe) ?? safe;
    const embed = detectVideoEmbed(display);
    if (embed) {
      return <VideoEmbedView embed={embed} title={alt || title} />;
    }
    return (
      <EmbeddedImageView
        src={display}
        alt={alt || ""}
        title={title || undefined}
      />
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
        remarkPlugins={[remarkGfm, remarkMentions]}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
