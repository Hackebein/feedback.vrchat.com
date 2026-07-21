import { useRef } from "react";
import {
  DownloadNameOverlay,
  FullscreenToggleButton,
  useFullscreenToggle,
} from "./attachmentOverlay";

export function EmbeddedImageView({
  src,
  alt,
  title,
  className,
  downloadName,
}: {
  src: string;
  alt: string;
  title?: string;
  className?: string;
  downloadName?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const { isFullscreen, toggle } = useFullscreenToggle(rootRef);

  const rootClass = ["embedded-image-root", className].filter(Boolean).join(" ");

  return (
    <span ref={rootRef} className={rootClass}>
      <img
        src={src}
        alt={alt}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        draggable={false}
      />
      {downloadName ? (
        <DownloadNameOverlay name={downloadName} url={src} />
      ) : null}
      <FullscreenToggleButton onClick={toggle} isFullscreen={isFullscreen} />
    </span>
  );
}
