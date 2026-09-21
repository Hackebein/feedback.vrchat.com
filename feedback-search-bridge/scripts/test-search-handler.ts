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

type QueryParams = {
  facetFilters?: unknown;
  excludeFacet?: { attribute?: string; values?: string[] };
  hitsPerPage?: number;
};

function queryParamsOf(request: BridgeTransportRequest): QueryParams[] {
  if (!request.body) {
    return [];
  }
  const parsed: unknown = JSON.parse(request.body);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || !("params" in entry)) {
      return {};
    }
    const params = (entry as { params?: QueryParams }).params;
    return params ?? {};
  });
}

function hasFacet(params: QueryParams | undefined, prefix: string): boolean {
  const filters = params?.facetFilters;
  if (!Array.isArray(filters)) {
    return false;
  }
  return filters.some(
    (group) =>
      Array.isArray(group) &&
      group.some((entry) => String(entry).startsWith(prefix)),
  );
}

const unscopedBoards = {
  "Bug Reports": 100,
  "Feature Requests": 80,
};
const scopedBoards = { "Bug Reports": 100 };

const disjoint = deferred<BridgeTransportResponse>();
let selectedBoardQueries: QueryParams[] | undefined;
const boardOptions: BridgeOptions = {
  storage: createMemoryStorage({ luceneMode: false }),
  transport: async (request) => {
    const queries = queryParamsOf(request);
    if (!hasFacet(queries[0], "board_name:")) {
      return jsonResponse(
        gatewayWithFacets({
          board_name: unscopedBoards,
          status: { open: 50 },
        }),
      );
    }
    selectedBoardQueries = queries;
    return disjoint.promise;
  },
};

const boardSeen: SearchFacets[] = [];
const stopBoard = onFacets((facets: SearchFacets) => {
  boardSeen.push(facets);
});

await handleCannySearch(boardOptions, { textSearch: "", pages: 1 });
assert.deepEqual(boardSeen.map((facets) => facets.facets.board_name), [unscopedBoards]);
assert.deepEqual(boardSeen[0]?.additional, {});

toggleRefinement("board_name", "Bug Reports");
const withBoard = handleCannySearch(boardOptions, { textSearch: "", pages: 1 });
await waitUntil(() => selectedBoardQueries !== undefined);
assert.equal(boardSeen.length, 1);
assert.deepEqual(selectedBoardQueries?.[1]?.excludeFacet, {
  attribute: "board_name",
  values: ["Bug Reports"],
});
assert.equal(selectedBoardQueries?.[1]?.hitsPerPage, 0);
assert.equal(hasFacet(selectedBoardQueries?.[1], "board_name:"), false);

const additionalBoards = {
  "Feature Requests": 80,
  Android: 10,
};
disjoint.resolve(
  jsonResponse({
    results: [
      {
        hits: [],
        page: 0,
        nbPages: 0,
        facets: { board_name: scopedBoards, status: { open: 20 } },
        facets_stats: {},
      },
      {
        hits: [],
        page: 0,
        nbPages: 0,
        facets: { board_name: additionalBoards },
        facets_stats: {},
      },
    ],
  }),
);
await withBoard;
stopBoard();
resetFilterState();

assert.equal(boardSeen.length, 2);
assert.deepEqual(boardSeen[1]?.facets.board_name, scopedBoards);
assert.deepEqual(boardSeen[1]?.additional?.board_name, additionalBoards);

resetFilterState();
toggleRefinement("status", "open");
let statusQueries: QueryParams[] = [];
const statusSeen: SearchFacets[] = [];
const stopStatus = onFacets((facets: SearchFacets) => {
  statusSeen.push(facets);
});
await handleCannySearch(
  {
    storage: createMemoryStorage({ luceneMode: false }),
    transport: async (request) => {
      statusQueries = queryParamsOf(request);
      return jsonResponse({
        results: [
          {
            hits: [],
            page: 0,
            nbPages: 0,
            facets: { status: { open: 12 } },
            facets_stats: {},
          },
          {
            hits: [],
            page: 0,
            nbPages: 0,
            facets: { status: { planned: 4, closed: 7 } },
            facets_stats: {},
          },
        ],
      });
    },
  },
  { textSearch: "", pages: 1 },
);
stopStatus();
resetFilterState();

assert.equal(statusQueries.length, 2);
assert.equal(hasFacet(statusQueries[0], "status:"), true);
assert.deepEqual(statusQueries[1]?.excludeFacet, {
  attribute: "status",
  values: ["open"],
});
assert.equal(statusQueries[1]?.hitsPerPage, 0);
assert.equal(statusSeen.at(-1)?.facets.status?.open, 12);
assert.deepEqual(statusSeen.at(-1)?.additional?.status, { planned: 4, closed: 7 });

console.info("search-handler tests passed");
