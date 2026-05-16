import { useRef } from "react";
import {
  DownloadNameOverlay,
  FullscreenToggleButton,
  useFullscreenToggle,
} from "./attachmentOverlay";

export function AttachmentTextView({
  name,
  url,
}: {
  name: string;
  url: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle } = useFullscreenToggle(rootRef);

  return (
    <div ref={rootRef} className="attachment-text">
      <iframe className="attachment-text-frame" src={url} title={name} />
      <DownloadNameOverlay name={name} url={url} />
      <FullscreenToggleButton onClick={toggle} isFullscreen={isFullscreen} />
    </div>
  );
}
