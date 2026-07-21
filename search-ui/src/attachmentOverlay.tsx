import {
  useCallback,
  useEffect,
  useState,
  type RefObject,
} from "react";

export function useFullscreenToggle(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === ref.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen();
    }
  }, []);

  return { isFullscreen, toggle };
}

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

export function FullscreenToggleButton({
  onClick,
  isFullscreen,
  className,
}: {
  onClick: () => void;
  isFullscreen: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className ?? "embedded-image-fullscreen-btn"}
      onClick={onClick}
      aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
    >
      {isFullscreen ? <IconExitFullscreen /> : <IconEnterFullscreen />}
    </button>
  );
}

export function DownloadNameOverlay({
  name,
  url,
}: {
  name: string;
  url: string;
}) {
  return (
    <a
      className="attachment-name-overlay"
      href={url}
      download={name}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
    >
      {name}
    </a>
  );
}
