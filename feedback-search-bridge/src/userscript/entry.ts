import { installBridge } from "../core/bridge";
import { installSsrHook } from "../core/ssr-hook";
import {
  createUserscriptStorage,
  createUserscriptTransport,
} from "./transport";

declare const unsafeWindow: Window & typeof globalThis;
declare const GM_info: { script?: { version?: string } } | undefined;

const INSTALL_PAGE_HOST = "vrchat-canny.hackebein.dev";
const INSTALL_PAGE_PATH = "/install.html";

function pageWindow(): Window & typeof globalThis {
  return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
}

function whenDocumentElementReady(doc: Document, run: () => void): void {
  if (doc.documentElement) {
    run();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!doc.documentElement) {
      return;
    }
    observer.disconnect();
    run();
  });
  observer.observe(doc, { childList: true, subtree: true });
}

function markInstallPage(target: Window & typeof globalThis): void {
  const doc = target.document;
  const version =
    typeof GM_info !== "undefined" ? GM_info?.script?.version ?? "1" : "1";
  whenDocumentElementReady(doc, () => {
    doc.documentElement.setAttribute("data-vrcfs-installed", version);
  });
}

function scheduleBoot(): void {
  const target = pageWindow();
  const doc = target.document;

  if (
    target.location.host === INSTALL_PAGE_HOST &&
    target.location.pathname === INSTALL_PAGE_PATH
  ) {
    // On the install page we only advertise presence + version so the page
    // can show an "already installed" state. The bridge stays off here.
    markInstallPage(target);
    return;
  }

  const run = (): void => {
    try {
      installSsrHook(target);
      installBridge(
        {
          transport: createUserscriptTransport(),
          storage: createUserscriptStorage(),
        },
        target,
      );
      console.info(
        "[vrcfb] bridge installed",
        typeof GM_info !== "undefined" ? GM_info?.script?.version : undefined,
      );
    } catch (error) {
      console.error("[vrcfb] bridge failed to install", error);
    }
  };

  whenDocumentElementReady(doc, run);
}

scheduleBoot();
