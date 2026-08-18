import assert from "node:assert/strict";
import {
  createMemoryStorage,
  handleCannySearch,
  onFacets,
} from "../src/core/search-handler";
import type {
  BridgeOptions,
  BridgeTransportResponse,
  SearchFacets,
} from "../src/core/types";

function jsonResponse(body: unknown): BridgeTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    responseText: JSON.stringify(body),
    headers: {},
  };
}

function gatewayWithOpenCount(openCount: number): unknown {
  return {
    results: [
      {
        hits: [],
        page: 0,
        nbPages: 0,
        facets: { status: { open: openCount } },
        facets_stats: {},
      },
    ],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const slow = deferred<BridgeTransportResponse>();
let calls = 0;
const options: BridgeOptions = {
  storage: createMemoryStorage({ luceneMode: false }),
  transport: async () => {
    calls += 1;
    if (calls === 1) {
      return slow.promise;
    }
    return jsonResponse(gatewayWithOpenCount(99));
  },
};

const seen: number[] = [];
const stop = onFacets((facets: SearchFacets) => {
  seen.push(facets.facets.status?.open ?? -1);
});

const stale = handleCannySearch(options, { textSearch: "avatar", pages: 1 });
const fresh = handleCannySearch(options, { textSearch: "", pages: 1 });

await fresh;
slow.resolve(jsonResponse(gatewayWithOpenCount(1)));
await stale;
stop();

assert.deepEqual(seen, [99]);

console.info("search-handler tests passed");
