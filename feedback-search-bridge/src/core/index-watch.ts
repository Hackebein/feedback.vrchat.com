import { GATEWAY_ORIGIN, INDEX_API_PATH } from "./config";
import { isLocationCovered } from "./coverage";
import { withPreservedVisiblePost } from "./preserve-visible-post";
import type { BridgeOptions } from "./types";

const POLL_MS = 15000;

/**
 * Polls the gateway backing-index name and invokes `onUpdate` when ingest
 * swaps the alias. Skips uncovered boards and hidden tabs. If `onUpdate`
 * returns false (refresh already in flight), the previous generation is kept
 * so the next poll retries.
 */
export function installIndexWatch(
  options: BridgeOptions,
  target: Window & typeof globalThis,
  onUpdate: () => Promise<boolean>,
): void {
  let last: string | undefined;
  let inFlight = false;

  const poll = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    if (target.document.visibilityState === "hidden") {
      return;
    }
    if (!isLocationCovered(target)) {
      return;
    }
    inFlight = true;
    try {
      const response = await options.transport({
        url: `${GATEWAY_ORIGIN}${INDEX_API_PATH}`,
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (response.status < 200 || response.status >= 300) {
        return;
      }
      const parsed: unknown = JSON.parse(response.responseText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const index =
        typeof (parsed as { index?: unknown }).index === "string"
          ? (parsed as { index: string }).index
          : "";
      if (!index) {
        return;
      }
      let refreshed = false;
      if (last !== undefined && last !== index) {
        const ok = await withPreservedVisiblePost(target, onUpdate);
        if (!ok) {
          return;
        }
        refreshed = true;
      }
      last = index;
      console.info("[vrcfb] index watch", index, refreshed ? "refresh" : "ok");
    } catch (error) {
      console.warn("[vrcfb] index watch failed", error);
    } finally {
      inFlight = false;
    }
  };

  target.setInterval(() => {
    void poll();
  }, POLL_MS);
  void poll();
  target.document.addEventListener("visibilitychange", () => {
    if (target.document.visibilityState === "visible") {
      void poll();
    }
  });
}
