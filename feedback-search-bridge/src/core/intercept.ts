import type { BridgeOptions } from "./types";
import { isCannySearchRequest } from "./mapping";
import { handleCannySearch } from "./search-handler";
import { isLocationCovered } from "./coverage";
import { captureCannyVote, parseCannyVoteRequest } from "./canny-vote";
import { hydrateViewerVotes } from "./viewer-votes";

type FetchFn = typeof fetch;

let nativeFetch: FetchFn | null = null;

/** Unpatched `fetch`, for same-origin Canny calls the indexer must not intercept. */
export function getNativeFetch(target: Window & typeof globalThis): FetchFn {
  if (nativeFetch) {
    return nativeFetch;
  }
  return target.fetch.bind(target);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function cannyClientPayload(mapped: {
  result?: unknown;
  error?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mapped.result !== undefined) {
    payload.result = mapped.result;
  }
  if (mapped.error !== undefined) {
    payload.error = mapped.error;
  }
  return payload;
}

export function installNetworkIntercept(
  options: BridgeOptions,
  target: Window & typeof globalThis = window,
): void {
  patchFetch(options, target);
  patchXmlHttpRequest(options, target);
  void hydrateViewerVotes(options.storage, target);
}

function patchFetch(
  options: BridgeOptions,
  target: Window & typeof globalThis,
): void {
  nativeFetch = target.fetch.bind(target);
  const originalFetch = nativeFetch;
  const patchedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const method = (init?.method ?? request.method).toUpperCase();
    const url = request.url;
    let bodyText: string | undefined;
    if (method === "POST") {
      try {
        bodyText = await request.clone().text();
      } catch {
        bodyText = undefined;
      }
    }

    const cannyBody = isCannySearchRequest(url, method, bodyText);
    if (!cannyBody || !isLocationCovered(target)) {
      const vote = parseCannyVoteRequest(url, method, bodyText);
      if (!vote) {
        return originalFetch(input, init);
      }
      const response = await originalFetch(input, init);
      const text = await response.clone().text();
      captureCannyVote(vote.postID, vote.score, response.status, text);
      return response;
    }

    try {
      const mapped = await handleCannySearch(options, cannyBody, target);
      if (mapped.stale) {
        throw new DOMException("The search was superseded", "AbortError");
      }
      return jsonResponse(cannyClientPayload(mapped));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      console.warn("[vrcfb] falling back to Canny search", error);
      return originalFetch(input, init);
    }
  };

  target.fetch = patchedFetch;
  target.globalThis.fetch = patchedFetch;
}

function patchXmlHttpRequest(
  options: BridgeOptions,
  target: Window & typeof globalThis,
): void {
  const OriginalXHR = target.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;
  const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;

  type XhrMeta = {
    method: string;
    url: string;
    headers: Record<string, string>;
  };

  OriginalXHR.prototype.open = function open(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    (this as XMLHttpRequest & { __vrcfb?: XhrMeta }).__vrcfb = {
      method: method.toUpperCase(),
      url: String(url),
      headers: {},
    };
    return originalOpen.call(
      this,
      method,
      url,
      async ?? true,
      username ?? undefined,
      password ?? undefined,
    );
  };

  OriginalXHR.prototype.setRequestHeader = function setRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    const meta = (this as XMLHttpRequest & { __vrcfb?: XhrMeta }).__vrcfb;
    if (meta) {
      meta.headers[name.toLowerCase()] = value;
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  OriginalXHR.prototype.send = function send(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = (this as XMLHttpRequest & { __vrcfb?: XhrMeta }).__vrcfb;
    const method = meta?.method ?? "GET";
    const url = meta?.url ?? "";
    const bodyText =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : undefined;

    const cannyBody = isCannySearchRequest(url, method, bodyText);
    if (!cannyBody || !isLocationCovered(target)) {
      const vote = parseCannyVoteRequest(url, method, bodyText);
      if (vote) {
        this.addEventListener("load", () => {
          captureCannyVote(
            vote.postID,
            vote.score,
            this.status,
            this.responseText,
          );
        });
      }
      return originalSend.call(this, body ?? null);
    }

    void handleCannySearch(options, cannyBody, target)
      .then((mapped) => {
        if (mapped.stale) {
          Object.defineProperty(this, "readyState", {
            configurable: true,
            get: () => 4,
          });
          Object.defineProperty(this, "status", {
            configurable: true,
            get: () => 0,
          });
          Object.defineProperty(this, "statusText", {
            configurable: true,
            get: () => "",
          });
          this.dispatchEvent(new Event("abort"));
          this.dispatchEvent(new Event("loadend"));
          return;
        }
        const payload = JSON.stringify(cannyClientPayload(mapped));
        Object.defineProperty(this, "readyState", {
          configurable: true,
          get: () => 4,
        });
        Object.defineProperty(this, "status", {
          configurable: true,
          get: () => 200,
        });
        Object.defineProperty(this, "statusText", {
          configurable: true,
          get: () => "OK",
        });
        Object.defineProperty(this, "responseText", {
          configurable: true,
          get: () => payload,
        });
        Object.defineProperty(this, "response", {
          configurable: true,
          get: () => payload,
        });
        this.dispatchEvent(new Event("readystatechange"));
        this.dispatchEvent(new Event("load"));
        this.dispatchEvent(new Event("loadend"));
      })
      .catch((error) => {
        console.warn("[vrcfb] falling back to Canny search", error);
        originalSend.call(this, body ?? null);
      });
  };
}
