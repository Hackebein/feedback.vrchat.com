import { GATEWAY_ORIGIN } from "./config";
import { isLocationCovered } from "./coverage";

const ATTRIBUTION_ID = "vrcfb-attribution";
const CANNY_ATTRIBUTION_SELECTOR = ".cannyAttribution";

/**
 * Adds a "Search by …" line next to Canny's "Powered by Canny" footer that
 * links to our gateway home page, reusing Canny's `.attribution` styling.
 */
export function installAttribution(target: Window & typeof globalThis): void {
  const mount = (): void => {
    const doc = target.document;
    if (!isLocationCovered(target)) {
      doc.getElementById(ATTRIBUTION_ID)?.remove();
      return;
    }
    if (doc.getElementById(ATTRIBUTION_ID)) {
      return;
    }
    const container = doc.querySelector<HTMLElement>(CANNY_ATTRIBUTION_SELECTOR);
    if (!container) {
      return;
    }
    const line = doc.createElement("div");
    line.className = "firstLine";
    line.id = ATTRIBUTION_ID;
    const link = doc.createElement("a");
    link.className = "attribution";
    link.href = GATEWAY_ORIGIN;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Search by Hackebein";
    line.appendChild(link);
    container.appendChild(line);
  };

  mount();

  const observer = new MutationObserver(() => {
    if (!target.document.getElementById(ATTRIBUTION_ID)) {
      mount();
    }
  });
  observer.observe(target.document.documentElement, {
    childList: true,
    subtree: true,
  });
}
