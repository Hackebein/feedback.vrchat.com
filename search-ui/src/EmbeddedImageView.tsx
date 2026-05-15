import { useCallback, useEffect, useRef, useState } from "react";

function IconEnterFullscreen() {
  return (
    <svg
      className="embedded-image-fullscreen-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M7 2h2v5H4V5h3V2zm0 15h2v5H4v-2H7v-3zm10-15v3h3v2h-5V2h2zm3 12h-3v5h-2v-5h5v2z"
      />
    </svg>
  );
}

function IconExitFullscreen() {
  return (
    <svg
      className="embedded-image-fullscreen-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M4 8V4h4V2H2v6h2zm2 12v-4H4v4H2v6h6v-2H6zm12-4h4v4h-2v2h6v-6h-2v2h-4v-2zm0-8V4h-4V2h6v6h-2V6h-2V4z"
      />
    </svg>
  );
}

export function EmbeddedImageView({
  src,
  alt,
  title,
  className,
}: {
  src: string;
  alt: string;
  title?: string;
  className?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === el);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, []);

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
      <button
        type="button"
        className="embedded-image-fullscreen-btn"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
      >
        {isFullscreen ? <IconExitFullscreen /> : <IconEnterFullscreen />}
      </button>
    </span>
  );
}
