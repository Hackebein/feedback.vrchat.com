import assert from "node:assert/strict";
import { createMemoryStorage } from "../src/core/search-handler";
import {
  resetFilterState,
  setSort,
  needsListRefresh,
} from "../src/core/filter-state";
import {
  runSearchRefresh,
  scheduleSearchRefresh,
} from "../src/core/search-refresh";
import type {
  BridgeOptions,
  BridgeTransportResponse,
} from "../src/core/types";

function jsonResponse(body: unknown): BridgeTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    responseText: JSON.stringify(body),
    headers: {},
  };
}

function gatewayHits(ids: string[]): unknown {
  return {
    results: [
      {
        hits: ids.map((id) => ({ objectID: id, title: id })),
        page: 0,
        nbPages: 1,
        nbHits: ids.length,
        facets: {},
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("timed out waiting for search-refresh condition");
}

resetFilterState();

const liveFirst = { textSearch: "first", sort: "relevance" };
const liveSecond = { textSearch: "second", sort: "relevance" };
const queryLoaded: Array<{ textSearch?: string; posts: string[] }> = [];
const store = {
  dispatch: (action: {
    type?: string;
    queryParams?: { textSearch?: string };
    result?: { posts?: Array<{ _id?: string }> };
  }) => {
    if (action.type === "canny/post_queries/query_loaded") {
      queryLoaded.push({
        textSearch: action.queryParams?.textSearch,
        posts: (action.result?.posts ?? []).map((post) => String(post._id ?? "")),
      });
    }
  },
  getState: () => ({
    postQueries: {
      [JSON.stringify(liveFirst)]: { result: { posts: [] } },
      [JSON.stringify(liveSecond)]: { result: { posts: [] } },
    },
  }),
};

const content = {
  children: [] as unknown[],
  __reactFiber$test: {
    memoizedProps: { store },
    return: null,
    stateNode: null,
  },
};

let inputValue = "first";
const firstGateway = deferred<BridgeTransportResponse>();
let transportCalls = 0;
const options: BridgeOptions = {
  storage: createMemoryStorage({ luceneMode: false }),
  transport: async () => {
    transportCalls += 1;
    if (transportCalls === 1) {
      return firstGateway.promise;
    }
    return jsonResponse(gatewayHits(["second"]));
  },
};

function refreshTarget(): Window & typeof globalThis {
  return {
    location: {
      href: `https://feedback.vrchat.com/feature-requests?search=${encodeURIComponent(inputValue)}`,
    },
    document: {
      querySelector: () => ({ value: inputValue }),
      getElementById: (id: string) => (id === "content" ? content : null),
      body: null,
    },
    history: { replaceState: () => undefined, state: null },
    dispatchEvent: () => true,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  } as unknown as Window & typeof globalThis;
}

const target = refreshTarget();
const firstRefresh = runSearchRefresh(options, target);
await waitUntil(() => transportCalls === 1);

inputValue = "second";
const secondRefresh = runSearchRefresh(options, target);
assert.equal(await secondRefresh, false);

firstGateway.resolve(jsonResponse(gatewayHits(["first"])));
assert.equal(await firstRefresh, true);

assert.equal(transportCalls, 2);
assert.deepEqual(queryLoaded, [
  { textSearch: "second", posts: ["second"] },
]);

resetFilterState();
assert.equal(needsListRefresh(), false);
setSort("score_desc");
assert.equal(needsListRefresh(), true);

const invalidates: string[] = [];
const sortStore = {
  dispatch: (action: { type?: string }) => {
    if (action.type) {
      invalidates.push(action.type);
    }
  },
  getState: () => ({ postQueries: {} }),
};
const sortContent = {
  children: [] as unknown[],
  __reactFiber$test: {
    memoizedProps: { store: sortStore },
    return: null,
    stateNode: null,
  },
};
const sortTarget = {
  location: { href: "https://feedback.vrchat.com/feature-requests" },
  document: {
    querySelector: () => ({ value: "" }),
    getElementById: (id: string) => (id === "content" ? sortContent : null),
    body: null,
  },
  history: { replaceState: () => undefined, state: null },
  dispatchEvent: () => true,
  setTimeout: (fn: () => void) => {
    fn();
    return 0;
  },
} as unknown as Window & typeof globalThis;

scheduleSearchRefresh(options, sortTarget, 0);
await Promise.resolve();
assert.ok(invalidates.includes("canny/post_queries/invalidate"));

resetFilterState();
console.info("search-refresh tests passed");
