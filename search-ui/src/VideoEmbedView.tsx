import { DownloadNameOverlay } from "./attachmentOverlay";
import type { VideoEmbed } from "./videoEmbed";

export function VideoEmbedView({
  embed,
  title,
  downloadName,
}: {
  embed: VideoEmbed;
  title?: string;
  downloadName?: string;
}) {
  if (embed.kind === "iframe") {
    return (
      <iframe
        className="video-embed"
        src={embed.src}
        title={title || embed.title}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    );
  }
  return (
    <span className="video-embed-root">
      <video
        className="video-embed"
        controls
        preload="metadata"
        referrerPolicy="no-referrer"
      >
        <source src={embed.src} type={embed.mime} />
      </video>
      {downloadName ? (
        <DownloadNameOverlay name={downloadName} url={embed.src} />
      ) : null}
    </span>
  );
}
