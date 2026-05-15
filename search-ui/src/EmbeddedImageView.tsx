import { useCallback, useEffect, useRef, useState } from "react";

function IconEnterFullscreen() {
  return (
    <svg
      className="embedded-image-fullscreen-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
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
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 14v3a2 2 0 0 0 2 2h3" />
      <path d="M14 4h3a2 2 0 0 1 2 2v3" />
      <path d="M20 4l-5 5" />
      <path d="M4 20l5-5" />
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
