import type {
  BridgeStorage,
  BridgeTransport,
  BridgeTransportRequest,
  BridgeTransportResponse,
} from "../core/types";

declare function GM_xmlhttpRequest(details: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  onload?: (response: {
    status: number;
    statusText: string;
    responseText: string;
    responseHeaders?: string;
  }) => void;
  onerror?: (error: unknown) => void;
}): void;

declare function GM_getValue(key: string, fallback: unknown): unknown;
declare function GM_setValue(key: string, value: unknown): void;

function parseResponseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) {
    return headers;
  }
  for (const line of raw.trim().split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) {
      continue;
    }
    headers[line.slice(0, index).trim().toLowerCase()] = line
      .slice(index + 1)
      .trim();
  }
  return headers;
}

export function createUserscriptTransport(): BridgeTransport {
  return (request: BridgeTransportRequest) =>
    new Promise<BridgeTransportResponse>((resolve, reject) => {
      GM_xmlhttpRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        data: request.body,
        onload(response) {
          resolve({
            status: response.status,
            statusText: response.statusText,
            responseText: response.responseText,
            headers: parseResponseHeaders(response.responseHeaders),
          });
        },
        onerror(error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      });
    });
}

export function createUserscriptStorage(): BridgeStorage {
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      return GM_getValue(key, fallback) as T;
    },
    async set<T>(key: string, value: T): Promise<void> {
      GM_setValue(key, value);
    },
  };
}
