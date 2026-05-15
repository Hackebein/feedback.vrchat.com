import type { VideoEmbed } from "./videoEmbed";

export function VideoEmbedView({
  embed,
  title,
}: {
  embed: VideoEmbed;
  title?: string;
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
    <video
      className="video-embed"
      controls
      preload="metadata"
      referrerPolicy="no-referrer"
    >
      <source src={embed.src} type={embed.mime} />
    </video>
  );
}
