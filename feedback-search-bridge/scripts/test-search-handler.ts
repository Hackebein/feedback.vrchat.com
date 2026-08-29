import assert from "node:assert/strict";
import {
  createMemoryStorage,
  handleCannySearch,
  onFacets,
} from "../src/core/search-handler";
import { resetFilterState, toggleRefinement } from "../src/core/filter-state";
import type {
  BridgeOptions,
  BridgeTransportRequest,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("timed out waiting for search-handler condition");
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

const freshResult = await fresh;
slow.resolve(jsonResponse(gatewayWithOpenCount(1)));
const staleResult = await stale;
stop();

assert.equal(staleResult.stale, true);
assert.equal(freshResult.stale, undefined);
assert.deepEqual(seen, [99]);

function gatewayWithFacets(facets: Record<string, Record<string, number>>): unknown {
  return {
    results: [
      {
        hits: [],
        page: 0,
        nbPages: 0,
        facets,
        facets_stats: {},
      },
    ],
  };
}

function requestHasBoardFilter(request: BridgeTransportRequest): boolean {
  if (!request.body) {
    return false;
  }
  const parsed: unknown = JSON.parse(request.body);
  const first = Array.isArray(parsed) ? parsed[0] : undefined;
  const params =
    first && typeof first === "object" && first !== null && "params" in first
      ? (first as { params?: { facetFilters?: unknown } }).params
      : undefined;
  const filters = params?.facetFilters;
  if (!Array.isArray(filters)) {
    return false;
  }
  return filters.some(
    (group) =>
      Array.isArray(group) &&
      group.some((entry) => String(entry).startsWith("board_name:")),
  );
}

const unscopedBoards = {
  "Bug Reports": 100,
  "Feature Requests": 80,
};
const scopedBoards = { "Bug Reports": 100 };
const disjointBoards = {
  "Bug Reports": 100,
  "Feature Requests": 80,
  Android: 10,
};

const disjoint = deferred<BridgeTransportResponse>();
let boardPhase: "prime" | "selected" = "prime";
const boardOptions: BridgeOptions = {
  storage: createMemoryStorage({ luceneMode: false }),
  transport: async (request) => {
    if (requestHasBoardFilter(request)) {
      return jsonResponse(
        gatewayWithFacets({
          board_name: scopedBoards,
          status: { open: 20 },
        }),
      );
    }
    if (boardPhase === "prime") {
      return jsonResponse(
        gatewayWithFacets({
          board_name: unscopedBoards,
          status: { open: 50 },
        }),
      );
    }
    return disjoint.promise;
  },
};

const boardSeen: Array<Record<string, number> | undefined> = [];
const stopBoard = onFacets((facets: SearchFacets) => {
  boardSeen.push(facets.facets.board_name);
});

await handleCannySearch(boardOptions, { textSearch: "", pages: 1 });
assert.deepEqual(boardSeen, [unscopedBoards]);

toggleRefinement("board_name", "Bug Reports");
boardPhase = "selected";
const withBoard = handleCannySearch(boardOptions, { textSearch: "", pages: 1 });

await waitUntil(() => boardSeen.length >= 2);
assert.deepEqual(boardSeen, [unscopedBoards, unscopedBoards]);
assert.notDeepEqual(boardSeen[1], scopedBoards);

disjoint.resolve(
  jsonResponse(
    gatewayWithFacets({
      board_name: disjointBoards,
      status: { open: 50 },
    }),
  ),
);
await waitUntil(() => boardSeen.length >= 3);
await withBoard;
stopBoard();
resetFilterState();

assert.deepEqual(boardSeen, [unscopedBoards, unscopedBoards, disjointBoards]);

console.info("search-handler tests passed");
