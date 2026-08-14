import Client from "@searchkit/instantsearch-client";
import {
  Fragment,
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ClearRefinements,
  Configure,
  CurrentRefinements,
  Highlight,
  Hits,
  InstantSearch,
  Pagination,
  RefinementList,
  SearchBox,
  Snippet,
  SortBy,
  Stats,
  ToggleRefinement,
  useInstantSearch,
  useRange,
  useRefinementList,
  useSearchBox,
} from "react-instantsearch";
import type { Hit, StateMapping, UiState } from "instantsearch.js/es/types";
import type { RefinementListItem } from "instantsearch.js/es/connectors/refinement-list/connectRefinementList";
import qs from "qs";
import historyRouter from "instantsearch.js/es/lib/routers/history";
import { AttachmentTextView } from "./AttachmentTextView";
import { EmbeddedImageView } from "./EmbeddedImageView";
import {
  filterNestedBoardNodes,
  nestBoardFacetEntries,
} from "./boardHierarchy";
import { aiCategoryDescription, aiCategoryName } from "./featureTree";
import { MarkdownText } from "./MarkdownText";
import { Notifications } from "./Notifications";
import {
  captureVisiblePost,
  restoreVisiblePost,
  type VisiblePostAnchor,
} from "./preserveVisiblePost";
import { setCurrentSearchParams } from "./searchFilterStore";
import { detectVideoEmbed } from "./videoEmbed";
import { VideoEmbedView } from "./VideoEmbedView";

function tokenizeQuery(q: string): string[] {
  if (!q) return [];
  const out: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const trimmed = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function useQueryTerms(): string[] {
  const { query } = useSearchBox();
  return useMemo(() => tokenizeQuery(query), [query]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightInline(text: string, terms: string[]): ReactNode {
  if (!text) return text;
  const filtered = terms.filter((t) => t.length > 0);
  if (filtered.length === 0) return text;
  const pattern = new RegExp(
    `(${filtered.map(escapeRegExp).join("|")})`,
    "gi",
  );
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function msToDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * InstantSearch range connector drops refinements equal to facet stats min/max and
 * then skips search(); nudge inward by 1ms so an explicit picker choice always applies.
 */
function nudgeEpochRangeBounds(
  lowOk: number | undefined,
  highOk: number | undefined,
  rmin: number | undefined,
  rmax: number | undefined,
): [number | undefined, number | undefined] {
  let lo = lowOk;
  let hi = highOk;
  if (
    lo !== undefined &&
    rmin !== undefined &&
    Number.isFinite(lo) &&
    Number.isFinite(rmin) &&
    lo <= rmin
  ) {
    lo = Math.min(rmin + 1, hi ?? Infinity);
  }
  if (
    hi !== undefined &&
    rmax !== undefined &&
    Number.isFinite(hi) &&
    Number.isFinite(rmax) &&
    hi >= rmax
  ) {
    hi = Math.max(rmax - 1, lo ?? -Infinity);
  }
  if (
    lo !== undefined &&
    hi !== undefined &&
    lo > hi
  ) {
    return [lowOk, highOk];
  }
  return [lo, hi];
}

function EpochMsRangeInput({ attribute }: { attribute: string }) {
  const { start, range, refine, canRefine } = useRange({
    attribute,
    precision: 0,
  });
  const rmin = range.min;
  const rmax = range.max;
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");

  useEffect(() => {
    const [low, high] = start;
    const hasFrom =
      typeof low === "number" &&
      Number.isFinite(low) &&
      low !== -Infinity &&
      rmin !== undefined &&
      low !== rmin;
    const hasTo =
      typeof high === "number" &&
      Number.isFinite(high) &&
      high !== Infinity &&
      rmax !== undefined &&
      high !== rmax;
    setFromLocal(hasFrom ? msToDatetimeLocalValue(low) : "");
    setToLocal(hasTo ? msToDatetimeLocalValue(high) : "");
  }, [start, rmin, rmax]);

  function applyRange(nextFrom: string, nextTo: string): void {
    const trimmedFrom = nextFrom.trim();
    const trimmedTo = nextTo.trim();
    const loMs = trimmedFrom ? new Date(trimmedFrom).getTime() : undefined;
    const hiMs = trimmedTo ? new Date(trimmedTo).getTime() : undefined;
    const lowOk =
      loMs !== undefined && Number.isFinite(loMs) ? Math.floor(loMs) : undefined;
    const highOk =
      hiMs !== undefined && Number.isFinite(hiMs)
        ? Math.floor(hiMs)
        : undefined;
    if (
      lowOk !== undefined &&
      highOk !== undefined &&
      lowOk > highOk
    ) {
      return;
    }
    const [lo, hi] = nudgeEpochRangeBounds(lowOk, highOk, rmin, rmax);
    refine([lo, hi]);
  }

  function attachEpochInputHandlers(which: "from" | "to") {
    return {
      onInput: (e: FormEvent<HTMLInputElement>) => {
        const v = e.currentTarget.value;
        if (which === "from") {
          setFromLocal(v);
          applyRange(v, toLocal);
        } else {
          setToLocal(v);
          applyRange(fromLocal, v);
        }
      },
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value;
        if (which === "from") {
          setFromLocal(v);
          applyRange(v, toLocal);
        } else {
          setToLocal(v);
          applyRange(fromLocal, v);
        }
      },
      onBlur: (e: FocusEvent<HTMLInputElement>) => {
        const v = e.target.value;
        if (which === "from") {
          applyRange(v, toLocal);
        } else {
          applyRange(fromLocal, v);
        }
      },
    };
  }

  return (
    <div className="epoch-ms-range-form">
      <div className="epoch-ms-range-inputs">
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">From</span>
          <input
            type="datetime-local"
            step={60}
            className="epoch-ms-range-datetime"
            value={fromLocal}
            disabled={!canRefine}
            {...attachEpochInputHandlers("from")}
          />
        </label>
        <span aria-hidden className="epoch-ms-range-sep">
          —
        </span>
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">To</span>
          <input
            type="datetime-local"
            step={60}
            className="epoch-ms-range-datetime"
            disabled={!canRefine}
            value={toLocal}
            {...attachEpochInputHandlers("to")}
          />
        </label>
      </div>
    </div>
  );
}

function parseNumericRangeBound(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Same layout as EpochMsRangeInput; refines immediately on input change (no Apply/Go button). */
function AutoNumericRangeInput({ attribute }: { attribute: string }) {
  const { start, range, refine, canRefine } = useRange({ attribute });
  const rmin = range.min;
  const rmax = range.max;
  const [minLocal, setMinLocal] = useState("");
  const [maxLocal, setMaxLocal] = useState("");

  useEffect(() => {
    const [low, high] = start;
    const hasMin =
      typeof low === "number" &&
      Number.isFinite(low) &&
      low !== -Infinity &&
      rmin !== undefined &&
      low !== rmin;
    const hasMax =
      typeof high === "number" &&
      Number.isFinite(high) &&
      high !== Infinity &&
      rmax !== undefined &&
      high !== rmax;
    setMinLocal(hasMin ? String(low) : "");
    setMaxLocal(hasMax ? String(high) : "");
  }, [start, rmin, rmax]);

  function applyRange(nextMin: string, nextMax: string): void {
    const lowOk = parseNumericRangeBound(nextMin);
    const highOk = parseNumericRangeBound(nextMax);
    if (
      lowOk !== undefined &&
      highOk !== undefined &&
      lowOk > highOk
    ) {
      return;
    }
    refine([lowOk, highOk]);
  }

  return (
    <div className="epoch-ms-range-form">
      <div className="epoch-ms-range-inputs">
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">From</span>
          <input
            type="text"
            inputMode="decimal"
            className="epoch-ms-range-datetime auto-range-num-input"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${attribute} minimum`}
            placeholder="Min"
            value={minLocal}
            disabled={!canRefine}
            onChange={(e) => {
              const v = e.target.value;
              setMinLocal(v);
              applyRange(v, maxLocal);
            }}
          />
        </label>
        <span aria-hidden className="epoch-ms-range-sep">
          —
        </span>
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">To</span>
          <input
            type="text"
            inputMode="decimal"
            className="epoch-ms-range-datetime auto-range-num-input"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${attribute} maximum`}
            placeholder="Max"
            value={maxLocal}
            disabled={!canRefine}
            onChange={(e) => {
              const v = e.target.value;
              setMaxLocal(v);
              applyRange(minLocal, v);
            }}
          />
        </label>
      </div>
    </div>
  );
}

const indexName = "feedback-posts";

const SORT_INDEX_TO_PARAM: Record<string, string> = {
  [`${indexName}_created_asc`]: "created_asc",
  [`${indexName}_activity_desc`]: "activity_desc",
  [`${indexName}_activity_asc`]: "activity_asc",
  [`${indexName}_score_desc`]: "score_desc",
  [`${indexName}_score_asc`]: "score_asc",
  [`${indexName}_relevance_desc`]: "relevance_desc",
};

const SORT_PARAM_TO_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(SORT_INDEX_TO_PARAM).map(([idx, param]) => [param, idx]),
);

type AttrEntry = { urlKey: string; attr: string };

const REFINEMENT_LIST_ATTRS: AttrEntry[] = [
  { urlKey: "board.name", attr: "board_name" },
  { urlKey: "status", attr: "status" },
  { urlKey: "category.name", attr: "category_name" },
  { urlKey: "aiCategories", attr: "aiCategories" },
  { urlKey: "author.name", attr: "author_name" },
  { urlKey: "voters.name", attr: "voter_name" },
  { urlKey: "comments.author.name", attr: "comment_author_name" },
];

const RANGE_ATTRS: AttrEntry[] = [
  { urlKey: "score", attr: "score" },
  { urlKey: "maxScore", attr: "maxScore" },
  { urlKey: "commentCount", attr: "commentCount" },
  { urlKey: "mergeCount", attr: "mergeCount" },
  { urlKey: "trendingScore", attr: "trendingScore" },
  { urlKey: "comments.likeCount", attr: "comment_likeCount" },
  { urlKey: "created", attr: "post_created" },
  { urlKey: "updatedAt", attr: "post_updated" },
  { urlKey: "statusChanged", attr: "post_statusChanged" },
  { urlKey: "comments.created", attr: "comment_created" },
];

const TOGGLE_ATTRS: AttrEntry[] = [
  { urlKey: "voteSettings.highEngagement", attr: "vote_highEngagement" },
  { urlKey: "voteSettings.moderateEngagement", attr: "vote_moderateEngagement" },
  { urlKey: "voteSettings.lowEngagement", attr: "vote_lowEngagement" },
  { urlKey: "comments.pinned", attr: "comment_pinned" },
];

type RouteState = Record<string, unknown>;

/** Lucene-style field names shown in chips (maps InstantSearch facet `attribute` strings). */
const ATTR_DISPLAY_LABEL: Record<string, string> = Object.fromEntries([
  ...REFINEMENT_LIST_ATTRS.map((e) => [e.attr, e.urlKey]),
  ...RANGE_ATTRS.map((e) => [e.attr, e.urlKey]),
  ...TOGGLE_ATTRS.map((e) => [e.attr, e.urlKey]),
]);

function makeFeedbackStateMapping(
  luceneMode: boolean,
): StateMapping<UiState, RouteState> {
  return {
    $$type: "ais.feedbackFlat" as const,
    stateToRoute(uiState: UiState): RouteState {
      const idx = uiState[indexName] ?? {};
      const route: RouteState = {};
      if (idx.query) route.q = idx.query;
      if (typeof idx.page === "number" && idx.page > 1) route.page = idx.page;
      if (idx.sortBy && SORT_INDEX_TO_PARAM[idx.sortBy]) {
        route.sort = SORT_INDEX_TO_PARAM[idx.sortBy];
      }
      if (luceneMode) {
        return route;
      }
      const rl = idx.refinementList ?? {};
      for (const { urlKey, attr } of REFINEMENT_LIST_ATTRS) {
        const v = rl[attr];
        if (Array.isArray(v) && v.length > 0) route[urlKey] = v;
      }
      const rg = idx.range ?? {};
      for (const { urlKey, attr } of RANGE_ATTRS) {
        const v = rg[attr];
        if (typeof v === "string" && v) route[urlKey] = v;
      }
      const tg = idx.toggle ?? {};
      for (const { urlKey, attr } of TOGGLE_ATTRS) {
        if (tg[attr] === true) route[urlKey] = "1";
      }
      return route;
    },
    routeToState(routeParam: RouteState = {}): UiState {
      const route = routeParam;
      const rl: Record<string, string[]> = {};
      const rg: Record<string, string> = {};
      const tg: Record<string, boolean> = {};
      type IndexSlice = Record<string, unknown>;
      const idx: IndexSlice = {};
      if (typeof route.q === "string" && route.q) idx.query = route.q;
      const pageRaw = route.page;
      const page =
        typeof pageRaw === "number"
          ? pageRaw
          : typeof pageRaw === "string"
            ? Number.parseInt(pageRaw, 10)
            : NaN;
      if (Number.isFinite(page) && page > 1) idx.page = page;
      if (typeof route.sort === "string") {
        const mapped = SORT_PARAM_TO_INDEX[route.sort];
        if (mapped) idx.sortBy = mapped;
      }
      if (luceneMode) {
        return { [indexName]: idx };
      }
      for (const { urlKey, attr } of REFINEMENT_LIST_ATTRS) {
        const raw = route[urlKey];
        if (Array.isArray(raw)) {
          const list = raw.map(String).filter(Boolean);
          if (list.length > 0) rl[attr] = list;
        } else if (typeof raw === "string" && raw) {
          rl[attr] = [raw];
        }
      }
      if (Object.keys(rl).length > 0) idx.refinementList = rl;
      for (const { urlKey, attr } of RANGE_ATTRS) {
        const raw = route[urlKey];
        if (typeof raw === "string" && raw) rg[attr] = raw;
      }
      if (Object.keys(rg).length > 0) idx.range = rg;
      for (const { urlKey, attr } of TOGGLE_ATTRS) {
        const raw = route[urlKey];
        if (raw === "1" || raw === "true" || raw === true) tg[attr] = true;
      }
      if (Object.keys(tg).length > 0) idx.toggle = tg;
      return { [indexName]: idx };
    },
  };
}

/** Query params not controlled by InstantSearch routing; preserved on URL writes */
const PRESERVED_URL_PARAMS = ["lucene"] as const;

function makeSearchHistoryRouter(): ReturnType<typeof historyRouter> {
  return historyRouter({
    createURL({
      qsModule,
      routeState,
      location,
    }: {
      qsModule: typeof qs;
      routeState: Record<string, unknown>;
      location: Location;
    }) {
      const existing = qsModule.parse(location.search.slice(1), {
        arrayLimit: 99,
      }) as Record<string, unknown>;
      const preserved: Record<string, unknown> = {};
      for (const k of PRESERVED_URL_PARAMS) {
        if (existing[k] !== undefined) preserved[k] = existing[k];
      }
      const merged = { ...preserved, ...routeState };
      const queryString = qsModule.stringify(merged, {
        arrayFormat: "repeat",
        encodeValuesOnly: true,
      });
      const { pathname, hash } = location;
      return queryString
        ? `${pathname}?${queryString}${hash}`
        : `${pathname}${hash}`;
    },
    parseURL({
      qsModule,
      location,
    }: {
      qsModule: typeof qs;
      location: Location;
    }) {
      const parsed = qsModule.parse(location.search.slice(1), {
        arrayLimit: 99,
      }) as Record<string, unknown>;
      for (const k of PRESERVED_URL_PARAMS) {
        delete parsed[k];
      }
      return parsed;
    },
  });
}

const LUCENE_URL_PARAM = "lucene";

const LUCENE_KEEP_PARAMS = new Set(["q", "sort", "page", LUCENE_URL_PARAM]);

function readUrlLuceneMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(LUCENE_URL_PARAM) === "1";
}

function writeUrlLuceneMode(on: boolean): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (on) {
    for (const key of Array.from(params.keys())) {
      if (!LUCENE_KEEP_PARAMS.has(key)) params.delete(key);
    }
    params.set(LUCENE_URL_PARAM, "1");
  } else {
    params.delete(LUCENE_URL_PARAM);
  }
  const urlQs = params.toString();
  const next = urlQs
    ? `${window.location.pathname}?${urlQs}${window.location.hash}`
    : `${window.location.pathname}${window.location.hash}`;
  window.history.replaceState(null, "", next);
}

/** POST /api/search; throws on HTTP error so InstantSearch exposes status `error`. */
function createFeedbackSearchClient(apiUrl: string) {
  const inner = Client({ url: apiUrl });
  async function fetchSearchJson(body: unknown) {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(
          response.ok
            ? `Invalid JSON from search: ${text.slice(0, 200)}`
            : `${response.status} ${response.statusText} — ${text.slice(0, 500)}`,
        );
      }
    }
    if (!response.ok) {
      const o = parsed as { message?: string; detail?: unknown } | undefined;
      const msg = typeof o?.message === "string" ? o.message : `Search failed (${response.status})`;
      const err = new Error(msg) as Error & { statusCode?: number; detail?: unknown };
      err.statusCode = response.status;
      err.detail = o?.detail ?? (text || undefined);
      throw err;
    }
    return parsed;
  }
  return Object.assign(inner, {
    async search(requests: unknown) {
      captureSearchParams(requests);
      return fetchSearchJson(requests);
    },
  });
}

/**
 * Capture the primary search request's params so notification subscriptions can
 * replay the exact filter the user is viewing. Facet-only sub-queries (which
 * carry `facetName`) are skipped in favor of the main search request.
 */
function captureSearchParams(requests: unknown): void {
  if (!Array.isArray(requests) || requests.length === 0) {
    return;
  }
  const withParams = requests.filter(
    (r): r is { params: Record<string, unknown> } =>
      typeof r === "object" &&
      r !== null &&
      "params" in r &&
      typeof (r as { params?: unknown }).params === "object",
  );
  const main =
    withParams.find((r) => !("facetName" in r.params)) ?? withParams[0];
  if (main) {
    setCurrentSearchParams(main.params);
  }
}

type LuceneAttrRow = { field: string; kind: string; example: string };

const LUCENE_ATTRIBUTE_ROWS: LuceneAttrRow[] = [
  {
    field: "aiCategories",
    kind: "text",
    example: `aiCategories:groups`,
  },
  {
    field: "aiCategories.keyword",
    kind: "keyword",
    example: `aiCategories.keyword:"groups.calendar"`,
  },
  {
    field: "aiTaggedAt",
    kind: "date",
    example: `aiTaggedAt:["2025-01-01" TO "*"]`,
  },
  { field: "author.name", kind: "text", example: `author.name:Alice` },
  {
    field: "author.name.keyword",
    kind: "keyword",
    example: `author.name.keyword:"Jane Doe"`,
  },
  { field: "board.name", kind: "text", example: `board.name:bug` },
  {
    field: "board.name.keyword",
    kind: "keyword",
    example: `board.name.keyword:"Feature Requests"`,
  },
  { field: "board.urlName", kind: "keyword", example: `board.urlName:bug-reports` },
  { field: "category.name", kind: "text", example: `category.name:sdk` },
  {
    field: "category.name.keyword",
    kind: "keyword",
    example: `category.name.keyword:SDK`,
  },
  { field: "combined_text", kind: "text", example: `combined_text:performance` },
  { field: "commentCount", kind: "numeric", example: `commentCount:[1 TO 50]` },
  { field: "comments.author.name", kind: "text", example: `comments.author.name:Alice` },
  {
    field: "comments.author.name.keyword",
    kind: "keyword",
    example: `comments.author.name.keyword:"Jane Doe"`,
  },
  {
    field: "comments.created",
    kind: "date",
    example: `comments.created:["2025-01-01" TO "*"]`,
  },
  {
    field: "comments.likeCount",
    kind: "numeric",
    example: `comments.likeCount:[1 TO *]`,
  },
  { field: "comments.pinned", kind: "keyword", example: `comments.pinned:true` },
  { field: "comments.value", kind: "text", example: `comments.value:"network lag"` },
  {
    field: "created",
    kind: "date",
    example: `created:["2025-01-01" TO "2026-01-01"]`,
  },
  { field: "details", kind: "text", example: `details:"network lag"` },
  { field: "maxScore", kind: "numeric", example: `maxScore:[100 TO *]` },
  { field: "mergeCount", kind: "numeric", example: `mergeCount:[1 TO *]` },
  { field: "score", kind: "numeric", example: `score:[10 TO *]` },
  { field: "status", kind: "keyword", example: `status:open` },
  {
    field: "statusChanged",
    kind: "date",
    example: `statusChanged:["2025-01-01" TO "*"]`,
  },
  { field: "title", kind: "text", example: `title:avatar` },
  { field: "trendingScore", kind: "numeric", example: `trendingScore:[500 TO *]` },
  {
    field: "updatedAt",
    kind: "date",
    example: `updatedAt:["2025-01-01" TO "*"]`,
  },
  { field: "voters.name", kind: "text", example: `voters.name:Alice` },
  {
    field: "voters.name.keyword",
    kind: "keyword",
    example: `voters.name.keyword:"Jane Doe"`,
  },
  {
    field: "voteSettings.highEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.highEngagement:true`,
  },
  {
    field: "voteSettings.lowEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.lowEngagement:true`,
  },
  {
    field: "voteSettings.moderateEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.moderateEngagement:true`,
  },
];

function LuceneAttributesPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="lucene-attributes" aria-labelledby="lucene-attributes-heading">
      <button
        type="button"
        className="lucene-attributes-close"
        aria-label="Hide field reference"
        onClick={onClose}
      >
        ×
      </button>
      <div className="lucene-attributes-intro">
        <h2 id="lucene-attributes-heading" className="lucene-attributes-heading">
          Field reference
        </h2>
        <p className="lucene-attributes-note">
          <code className="lucene-inline-code">comments.*</code> and <code className="lucene-inline-code">voters.*</code> clauses match if <strong>any</strong> single comment or voter satisfies them. Bare terms target the default text fields (combined title, body, author name).
        </p>
      </div>
      <ul className="lucene-attributes-list">
        {LUCENE_ATTRIBUTE_ROWS.map((row) => (
          <li key={row.field} className="lucene-attributes-item">
            <div className="lucene-attributes-field">
              <span className="lucene-sr-label">Field</span>
              <code className="lucene-field-name">{row.field}</code>
            </div>
            <div className="lucene-attributes-kind">{row.kind}</div>
            <div className="lucene-attributes-example">
              <span className="lucene-sr-label">Example</span>
              <code className="lucene-example-code">{row.example}</code>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const INDEX_POLL_MS = 15000;
const HIT_CARD_SELECTOR = ".hit-card[data-object-id]";

function hitCardId(el: Element): string {
  return el.getAttribute("data-object-id") ?? "";
}

/** Re-runs the current InstantSearch query when ingest swaps the backing index. */
function IndexLiveRefresh() {
  const { refresh, status, results } = useInstantSearch();
  const pendingAnchor = useRef<VisiblePostAnchor | null>(null);
  const sawLoading = useRef(false);

  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) {
      return;
    }
    if (status === "loading" || status === "stalled") {
      sawLoading.current = true;
      return;
    }
    if (!sawLoading.current) {
      return;
    }
    restoreVisiblePost(document, HIT_CARD_SELECTOR, hitCardId, anchor);
    pendingAnchor.current = null;
    sawLoading.current = false;
  }, [status, results]);

  useEffect(() => {
    let last: string | undefined;
    let cancelled = false;

    const poll = async () => {
      if (cancelled || document.visibilityState === "hidden") {
        return;
      }
      try {
        const response = await fetch("/api/index", {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          return;
        }
        const data: unknown = await response.json();
        if (cancelled) {
          return;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return;
        }
        const index =
          typeof (data as { index?: unknown }).index === "string"
            ? (data as { index: string }).index
            : "";
        if (!index) {
          return;
        }
        if (last !== undefined && last !== index) {
          pendingAnchor.current = captureVisiblePost(
            document,
            HIT_CARD_SELECTOR,
            hitCardId,
          );
          sawLoading.current = false;
          refresh();
        }
        last = index;
      } catch {
        /* transient poll errors; next interval retries */
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, INDEX_POLL_MS);
    void poll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return null;
}

function LuceneSearchError() {
  const { status, error } = useInstantSearch({ catchError: true });

  if (status !== "error") {
    return null;
  }

  const message = error?.message ?? "Unknown error";
  const ext = error as Error & { detail?: unknown };
  const detailStr =
    ext.detail === undefined
      ? ""
      : typeof ext.detail === "string"
        ? ext.detail
        : `\n${JSON.stringify(ext.detail, null, 2)}`;

  return (
    <div className="lucene-search-error" role="alert">
      <strong>Search error</strong>
      <pre className="lucene-search-error-body">
        {message}
        {detailStr}
      </pre>
    </div>
  );
}

const CANNY_ORIGIN = "https://feedback.vrchat.com";

function cannyPostUrl(
  boardSlug: string | undefined,
  urlName: string | undefined,
): string | undefined {
  if (!boardSlug || !urlName) {
    return undefined;
  }
  return `${CANNY_ORIGIN}/${encodeURIComponent(boardSlug)}/p/${encodeURIComponent(urlName)}`;
}

function formatCommentLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

function formatCreatedAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function readString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Like readString but coerces numbers and a single-element string array (nested hits vary). */
function readScalarString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0].trim();
  }
  return "";
}

const CANNY_USER_ID_RE = /^[0-9a-f]{24}$/;
/** Canny encodes `@DisplayName` as `@{mongoId|full_name}` in post/comment bodies. */
const CANNY_MENTION_TOKEN_RE = /@\{([0-9a-f]{24})\|full_name\}/g;

function registerCannyUser(
  map: Map<string, string>,
  user: unknown,
): void {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return;
  }
  const o = user as Record<string, unknown>;
  const idRaw = typeof o._id === "string" ? o._id.trim() : "";
  if (!idRaw || !CANNY_USER_ID_RE.test(idRaw)) {
    return;
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || map.has(idRaw)) {
    return;
  }
  map.set(idRaw, name);
}

function appendUsersFromComments(
  map: Map<string, string>,
  comments: unknown,
): void {
  if (!Array.isArray(comments)) {
    return;
  }
  for (const raw of comments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    registerCannyUser(map, c.author);
    const mentioned = c.mentionedUsers;
    if (Array.isArray(mentioned)) {
      for (const m of mentioned) {
        registerCannyUser(map, m);
      }
    }
  }
}

/** Aggregate Canny `_id` → display name from everything shipped on this hit. */
function buildCannyUserNameMap(hit: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  registerCannyUser(map, hit.author);
  registerCannyUser(map, hit.by);
  registerCannyUser(map, hit.updatedBy);
  const voters = hit.voters;
  if (Array.isArray(voters)) {
    for (const v of voters) {
      registerCannyUser(map, v);
    }
  }
  appendUsersFromComments(map, hit.comments);
  const pinned = hit.pinnedComment;
  if (pinned && typeof pinned === "object" && !Array.isArray(pinned)) {
    const p = pinned as Record<string, unknown>;
    registerCannyUser(map, p.author);
    const mentioned = p.mentionedUsers;
    if (Array.isArray(mentioned)) {
      for (const m of mentioned) {
        registerCannyUser(map, m);
      }
    }
  }
  return map;
}

function substituteCannyMentions(
  text: string,
  userNameById: Map<string, string>,
): string {
  if (!text || userNameById.size === 0) {
    return text;
  }
  return text.replace(CANNY_MENTION_TOKEN_RE, (fullMatch, oid: string) => {
    const name = userNameById.get(oid);
    return name !== undefined ? `@${name}` : fullMatch;
  });
}

function readPostAuthorName(hit: Record<string, unknown>): string {
  return readString(hit.author, "name");
}

function readPostAuthorAvatarUrl(hit: Record<string, unknown>): string {
  return readString(hit.author, "avatarURL");
}

function AuthorAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl: string;
  name: string;
}) {
  if (avatarUrl) {
    return (
      <img
        className="author-avatar"
        src={avatarUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span className="author-avatar author-avatar-placeholder" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function readBoardSlug(hit: Record<string, unknown>): string | undefined {
  const slug = readString(hit.board, "urlName");
  return slug || undefined;
}

function readBoardName(hit: Record<string, unknown>): string | undefined {
  const name = readString(hit.board, "name");
  return name || undefined;
}

type CommentLike = Record<string, unknown> & {
  _id?: string;
  parentID?: unknown;
  value?: string;
  mergeID?: string;
  statusChangeID?: string;
  statusChangeNewStatus?: string;
  mergedPostTitle?: string;
  mergedPostDetails?: string;
  created?: string;
  author?: Record<string, unknown>;
  imageURLs?: unknown;
  files?: unknown;
  likeCount?: unknown;
  pinned?: unknown;
  internal?: unknown;
  private?: unknown;
  deleted?: unknown;
  spam?: unknown;
};

function readVisibleComments(raw: unknown): CommentLike[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const visible: CommentLike[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      continue;
    }
    const obj = c as CommentLike;
    if (obj.deleted === true || obj.spam === true) {
      continue;
    }
    visible.push(obj);
  }
  visible.sort(compareCommentsByCreated);
  return visible;
}

function compareCommentsByCreated(a: CommentLike, b: CommentLike): number {
  const ta = typeof a.created === "string" ? Date.parse(a.created) : NaN;
  const tb = typeof b.created === "string" ? Date.parse(b.created) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

function readCommentParentId(c: CommentLike): string | undefined {
  const raw = c.parentID;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return undefined;
}

type CommentThreadNode = {
  comment: CommentLike;
  replies: CommentThreadNode[];
};

function buildCommentThreadTree(visible: CommentLike[]): CommentThreadNode[] {
  const sorted = [...visible].sort(compareCommentsByCreated);
  const idSet = new Set<string>();
  for (const c of sorted) {
    if (typeof c._id === "string" && c._id) {
      idSet.add(c._id);
    }
  }
  const childrenMap = new Map<string, CommentLike[]>();
  for (const c of sorted) {
    const pid = readCommentParentId(c);
    if (pid && idSet.has(pid)) {
      let bucket = childrenMap.get(pid);
      if (!bucket) {
        bucket = [];
        childrenMap.set(pid, bucket);
      }
      bucket.push(c);
    }
  }
  for (const bucket of childrenMap.values()) {
    bucket.sort(compareCommentsByCreated);
  }
  const topLevel = sorted.filter((c) => {
    const pid = readCommentParentId(c);
    return !pid || !idSet.has(pid);
  });

  function toNode(c: CommentLike): CommentThreadNode {
    const id = typeof c._id === "string" ? c._id : "";
    const rawReplies = id ? (childrenMap.get(id) ?? []) : [];
    return {
      comment: c,
      replies: rawReplies.map(toNode),
    };
  }

  return topLevel.map(toNode);
}

function readCommentBody(c: CommentLike): string {
  const raw =
    typeof c.value === "string" && c.value.trim() ? c.value.trim() : "";
  if (raw) {
    return raw;
  }
  const mergedTitle = readString(c, "mergedPostTitle");
  const mergedDetails = readString(c, "mergedPostDetails");
  const mergedParts = [mergedTitle, mergedDetails].filter(Boolean);
  if (mergedParts.length > 0) {
    return mergedParts.join("\n\n");
  }
  return "";
}

function readImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
}

type AttachmentFile = { name: string; url: string };

function readFileAttachments(raw: unknown): AttachmentFile[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const url = readString(f, "url");
    if (!url) continue;
    const name = readString(f, "name") || url;
    out.push({ name, url });
  }
  return out;
}

function urlBasename(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ?? url;
  } catch {
    return url;
  }
}

function readPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function isTextFile(f: AttachmentFile): boolean {
  return /\.txt(\?|#|$)/i.test(f.url) || /\.txt$/i.test(f.name);
}

function Attachments({
  imageUrls,
  files,
}: {
  imageUrls: string[];
  files: AttachmentFile[];
}) {
  const tiles: ReactNode[] = [];

  for (const url of imageUrls) {
    const embed = detectVideoEmbed(url);
    const basename = urlBasename(url);
    tiles.push(
      <li key={`img-${url}`} className="attachment-tile">
        {embed ? (
          <VideoEmbedView
            embed={embed}
            downloadName={embed.kind === "video" ? basename : undefined}
          />
        ) : (
          <EmbeddedImageView
            src={url}
            alt=""
            className="attachment-image-wrap"
            downloadName={basename}
          />
        )}
      </li>,
    );
  }

  for (const f of files) {
    const embed = detectVideoEmbed(f.url);
    let body: ReactNode;
    if (embed) {
      body = (
        <VideoEmbedView
          embed={embed}
          title={f.name}
          downloadName={embed.kind === "video" ? f.name : undefined}
        />
      );
    } else if (isTextFile(f)) {
      body = <AttachmentTextView name={f.name} url={f.url} />;
    } else {
      body = (
        <a
          className="attachment-file-link"
          href={f.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {f.name}
        </a>
      );
    }
    tiles.push(
      <li key={`file-${f.url}`} className="attachment-tile">
        {body}
      </li>,
    );
  }

  if (tiles.length === 0) return null;
  return <ul className="attachments-grid">{tiles}</ul>;
}

function CommentItem({
  node,
  terms,
  depth,
  userNameById,
}: {
  node: CommentThreadNode;
  terms: string[];
  depth: number;
  userNameById: Map<string, string>;
}) {
  const { comment, replies } = node;
  const displayDepth = Math.min(depth, 3);
  const author = comment.author;
  const authorName = readString(author, "name") || "Anonymous";
  const avatarUrl = readString(author, "avatarURL");
  const newStatus = readScalarString(comment, "statusChangeNewStatus");
  const statusChangeId = readScalarString(comment, "statusChangeID");
  const bodyRaw = readCommentBody(comment);
  const body = substituteCannyMentions(bodyRaw, userNameById);
  const createdLabel =
    typeof comment.created === "string"
      ? formatCreatedAt(comment.created)
      : undefined;
  const likeCount = readPositiveInt(comment.likeCount);
  const images = readImageUrls(comment.imageURLs);
  const files = readFileAttachments(comment.files);
  const hasAttachments = images.length > 0 || files.length > 0;
  const isPinned = comment.pinned === true;
  const isInternal = comment.internal === true;
  const isPrivate = comment.private === true;
  const isMerge =
    typeof comment.mergeID === "string" && comment.mergeID.trim().length > 0;
  const hasStatusChange =
    !isMerge && (Boolean(newStatus) || Boolean(statusChangeId));

  return (
    <li className="comment" data-comment-depth={displayDepth}>
      <div className="comment-header">
        <AuthorAvatar avatarUrl={avatarUrl} name={authorName} />
        <span className="comment-author">{highlightInline(authorName, terms)}</span>
        {createdLabel ? (
          <span className="comment-meta">{createdLabel}</span>
        ) : null}
        {isPinned ? <span className="comment-badge">pinned</span> : null}
        {isInternal ? <span className="comment-badge">internal</span> : null}
        {isPrivate ? <span className="comment-badge">private</span> : null}
        {isMerge ? <span className="comment-badge">merged post</span> : null}
        {likeCount !== undefined ? (
          <span className="comment-meta">
            {likeCount === 1 ? "1 like" : `${likeCount} likes`}
          </span>
        ) : null}
      </div>
      {hasStatusChange ||
      body ||
      hasAttachments ? (
        <div
          className={
            "hit-body" + (hasAttachments ? " has-attachments" : "")
          }
        >
          <div className="hit-body-text">
            {hasStatusChange ? (
              <p className="comment-status-change">
                {newStatus ? (
                  <>
                    {highlightInline(authorName, terms)} marked this post as{" "}
                    <span className="hit-status">
                      {highlightInline(newStatus, terms)}
                    </span>
                  </>
                ) : (
                  <>
                    {highlightInline(authorName, terms)} updated this post&apos;s
                    status.
                  </>
                )}
              </p>
            ) : null}
            {body ? (
              <MarkdownText source={body} highlightTerms={terms} />
            ) : null}
          </div>
          <Attachments imageUrls={images} files={files} />
        </div>
      ) : null}
      {replies.length > 0 ? (
        <ul className="comment-replies">
          {replies.map((child, idx) => (
            <CommentItem
              key={
                typeof child.comment._id === "string" && child.comment._id
                  ? child.comment._id
                  : `r-${depth}-${idx}`
              }
              node={child}
              terms={terms}
              userNameById={userNameById}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CommentsThread({
  comments,
  terms,
  userNameById,
}: {
  comments: CommentLike[];
  terms: string[];
  userNameById: Map<string, string>;
}) {
  const [showComments, setShowComments] = useState(false);

  if (comments.length === 0) {
    return null;
  }
  const roots = buildCommentThreadTree(comments);
  return (
    <section className="comments-thread">
      <div className="comments-heading-row">
        <h3 className="comments-heading">{formatCommentLabel(comments.length)}</h3>
        <button
          type="button"
          className="comments-toggle"
          aria-expanded={showComments}
          onClick={() => setShowComments((v) => !v)}
        >
          {showComments ? "Hide Comments" : "Show Comments"}
        </button>
      </div>
      {showComments ? (
        <ul className="comments-list">
          {roots.map((node, idx) => (
            <CommentItem
              key={
                typeof node.comment._id === "string" && node.comment._id
                  ? node.comment._id
                  : `c-${idx}`
              }
              node={node}
              terms={terms}
              userNameById={userNameById}
              depth={0}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function readAiCategories(hit: Record<string, unknown>): string[] {
  const raw = hit.aiCategories;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

const BOARD_FACET_COLLAPSED_LIMIT = 20;

function BoardRefinement() {
  const [q, setQ] = useState("");
  const [showingMore, setShowingMore] = useState(false);
  const { items, refine } = useRefinementList({
    attribute: "board_name",
    limit: 500,
    showMore: false,
  });
  const byValue = useMemo(
    () => new Map(items.map((item) => [item.value, item])),
    [items],
  );
  const nodes = useMemo(() => {
    const nested = nestBoardFacetEntries(
      items.map((item) => ({ value: item.value, count: item.count })),
    );
    return filterNestedBoardNodes(nested, q);
  }, [items, q]);
  const visible = showingMore
    ? nodes
    : nodes.slice(0, BOARD_FACET_COLLAPSED_LIMIT);

  const renderRow = (value: string, count: number, child: boolean) => {
    const item = byValue.get(value);
    const isRefined = item?.isRefined === true;
    const itemClass = [
      "ais-RefinementList-item",
      isRefined ? "ais-RefinementList-item--selected" : "",
      child ? "ais-RefinementList-item--child" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li key={value} className={itemClass}>
        <label className="ais-RefinementList-label">
          <input
            className="ais-RefinementList-checkbox"
            type="checkbox"
            checked={isRefined}
            onChange={() => refine(value)}
          />
          <span className="ais-RefinementList-labelText">{value || "(empty)"}</span>
          <span className="ais-RefinementList-count">
            {count.toLocaleString()}
          </span>
        </label>
      </li>
    );
  };

  return (
    <div className="ais-RefinementList">
      <input
        type="search"
        className="ai-category-search"
        placeholder="Filter boards…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Filter boards"
      />
      {nodes.length === 0 ? null : (
        <ul className="ais-RefinementList-list">
          {visible.map((node) => (
            <Fragment key={node.value}>
              {renderRow(node.value, node.count, false)}
              {node.children.map((child) =>
                renderRow(child.value, child.count, true),
              )}
            </Fragment>
          ))}
        </ul>
      )}
      {nodes.length > BOARD_FACET_COLLAPSED_LIMIT ? (
        <button
          type="button"
          className="ais-RefinementList-showMore"
          onClick={() => setShowingMore((open) => !open)}
        >
          {showingMore
            ? "Show less"
            : `Show ${nodes.length - BOARD_FACET_COLLAPSED_LIMIT} more`}
        </button>
      ) : null}
    </div>
  );
}

function AiCategoryRefinement() {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  return (
    <>
      <input
        type="search"
        className="ai-category-search"
        placeholder="Filter AI categories…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Filter AI categories"
      />
      <RefinementList
        attribute="aiCategories"
        showMore={false}
        limit={200}
        transformItems={(items: RefinementListItem[]) => {
          const mapped = items.map((it) => ({
            ...it,
            label: aiCategoryName(it.value),
          }));
          if (!needle) return mapped;
          return mapped.filter(
            (it) =>
              it.label.toLowerCase().includes(needle) ||
              it.value.toLowerCase().includes(needle),
          );
        }}
      />
    </>
  );
}

function readHitVoteCount(hit: Record<string, unknown>): number | undefined {
  const raw = hit.score;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function FeedbackHit({ hit }: { hit: Record<string, unknown> }) {
  const terms = useQueryTerms();
  const userNameById = useMemo(() => buildCannyUserNameMap(hit), [hit]);
  const urlName = typeof hit.urlName === "string" ? hit.urlName : undefined;
  const boardSlug = readBoardSlug(hit);
  const boardName = readBoardName(hit);
  const authorName = readPostAuthorName(hit);
  const authorAvatarUrl = readPostAuthorAvatarUrl(hit);
  const postUrl = cannyPostUrl(boardSlug, urlName);
  const createdLabel = formatCreatedAt(hit.created);
  const status = typeof hit.status === "string" ? hit.status.trim() : "";
  const voteCount = readHitVoteCount(hit);
  const detailsRaw = typeof hit.details === "string" ? hit.details : "";
  const details = substituteCannyMentions(detailsRaw, userNameById);
  const postImages = readImageUrls(hit.imageURLs);
  const postFiles = readFileAttachments(hit.files);
  const hasAttachments = postImages.length > 0 || postFiles.length > 0;
  const visibleComments = readVisibleComments(hit.comments);
  const aiCategories = readAiCategories(hit);
  const boardLabel = boardName || boardSlug;
  const statsParts: ReactNode[] = [];
  if (boardLabel) statsParts.push(<span key="board">{boardLabel}</span>);
  if (authorName)
    statsParts.push(
      <span key="author" className="hit-author">
        By
        <AuthorAvatar avatarUrl={authorAvatarUrl} name={authorName} />
        {highlightInline(authorName, terms)}
      </span>,
    );
  if (status)
    statsParts.push(
      <span key="status" className="hit-status">
        {status}
      </span>,
    );
  if (voteCount !== undefined)
    statsParts.push(
      <span key="votes" className="hit-votes">
        {voteCount === 1 ? "1 vote" : `${voteCount} votes`}
      </span>,
    );
  if (createdLabel) statsParts.push(<span key="created">Created {createdLabel}</span>);

  const objectId =
    typeof hit.objectID === "string" && hit.objectID
      ? hit.objectID
      : urlName ?? "";

  return (
    <article
      className="hit-card"
      data-object-id={objectId || undefined}
    >
      <header className="hit-title-row">
        <span className="hit-title">
          {postUrl ? (
            <a
              className="hit-title-link"
              href={postUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Highlight attribute="title" hit={hit} />
            </a>
          ) : (
            <Highlight attribute="title" hit={hit} />
          )}
        </span>
      </header>
      {statsParts.length > 0 ? (
        <p className="hit-stats">
          {statsParts.map((part, idx) => (
            <Fragment key={idx}>
              {idx > 0 ? " · " : null}
              {part}
            </Fragment>
          ))}
        </p>
      ) : null}
      {aiCategories.length > 0 ? (
        <ul className="ai-category-list" aria-label="AI categories">
          {aiCategories.map((cid) => (
            <li
              key={cid}
              className="ai-category-chip"
              title={aiCategoryDescription(cid) ?? cid}
            >
              {aiCategoryName(cid)}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={
          "hit-body" + (hasAttachments ? " has-attachments" : "")
        }
      >
        <div className="hit-body-text">
          <MarkdownText source={details} highlightTerms={terms} />
        </div>
        <Attachments imageUrls={postImages} files={postFiles} />
      </div>
      <CommentsThread comments={visibleComments} terms={terms} userNameById={userNameById} />
    </article>
  );
}

export function App() {
  const [luceneMode, setLuceneMode] = useState(readUrlLuceneMode);
  const [attrPanelDismissed, setAttrPanelDismissed] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    writeUrlLuceneMode(luceneMode);
  }, [luceneMode]);

  useEffect(() => {
    setFiltersOpen(false);
  }, [luceneMode]);

  useEffect(() => {
    function onPopState() {
      setLuceneMode(readUrlLuceneMode());
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!filtersOpen) {
      return;
    }
    const mq = window.matchMedia("(max-width: 820px)");
    function applyBodyScrollLock() {
      document.body.style.overflow = mq.matches ? "hidden" : "";
    }
    applyBodyScrollLock();
    mq.addEventListener("change", applyBodyScrollLock);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setFiltersOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      mq.removeEventListener("change", applyBodyScrollLock);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [filtersOpen]);

  const routing = useMemo(
    () => ({
      router: makeSearchHistoryRouter(),
      stateMapping: makeFeedbackStateMapping(luceneMode),
    }),
    [luceneMode],
  );

  const searchClient = useMemo(
    () =>
      createFeedbackSearchClient(
        luceneMode ? "/api/search?mode=lucene" : "/api/search",
      ),
    [luceneMode],
  );

  return (
    <InstantSearch
      key={luceneMode ? "lucene" : "normal"}
      searchClient={searchClient}
      indexName={indexName}
      stalledSearchDelay={0}
      routing={routing}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <Configure hitsPerPage={50} maxValuesPerFacet={200} />
      <IndexLiveRefresh />
      <main className="layout">
        <header className="top">
          <div className="top-heading">
            <h1>
              <a
                className="site-title-link"
                href={CANNY_ORIGIN}
                target="_blank"
                rel="noreferrer"
              >
                VRChat feedback search
              </a>
            </h1>
            <p className="lede">
              Search VRChat feedback posts.{" "}
              <a href="/openapi.html" target="_blank" rel="noreferrer">
                API reference
              </a>
              .{" "}
              <a href="/install.html">Install userscript</a>.
            </p>
          </div>
          <Notifications luceneMode={luceneMode} />
        </header>

        <div className="panels">
          <aside className="facets">
            <div className="facets-toolbar">
              <div className="search-row">
                <SearchBox
                  autoFocus
                  placeholder={
                    luceneMode
                      ? "Lucene query (field:value, ranges, booleans)…"
                      : "Search title or body…"
                  }
                  searchAsYouType
                  classNames={{
                    root: "searchbox-root",
                    form: "searchbox-form",
                    input: "searchbox-input",
                    submit: "searchbox-submit",
                    reset: "searchbox-reset",
                    loadingIndicator: "searchbox-loading",
                  }}
                />
                <label className="lucene-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={luceneMode}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      writeUrlLuceneMode(checked);
                      setLuceneMode(checked);
                    }}
                  />
                  <span className="lucene-toggle-label">Lucene syntax</span>
                </label>
                <div className="sort-filter-row">
                  <SortBy
                    classNames={{ root: "sort-root", select: "sort-select" }}
                    items={[
                      { label: "Newest", value: indexName },
                      { label: "Oldest", value: `${indexName}_created_asc` },
                      {
                        label: "Newest activity",
                        value: `${indexName}_activity_desc`,
                      },
                      {
                        label: "Oldest activity",
                        value: `${indexName}_activity_asc`,
                      },
                      {
                        label: "Most voters",
                        value: `${indexName}_score_desc`,
                      },
                      {
                        label: "Fewest voters",
                        value: `${indexName}_score_asc`,
                      },
                      {
                        label: "Relevance",
                        value: `${indexName}_relevance_desc`,
                      },
                    ]}
                  />
                  {!luceneMode ? (
                    <button
                      type="button"
                      className="mobile-filter-toggle"
                      onClick={() => setFiltersOpen(true)}
                    >
                      Filters
                    </button>
                  ) : null}
                  {luceneMode && !attrPanelDismissed ? (
                    <button
                      type="button"
                      className="mobile-filter-toggle mobile-field-reference-toggle"
                      onClick={() => setFiltersOpen(true)}
                    >
                      Field reference
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="stats-toolbar">
                <p className="stats-line">
                  <Stats />
                </p>
              </div>
              {luceneMode ? <LuceneSearchError /> : null}
              {luceneMode ? null : (
                <CurrentRefinements
                  transformItems={(items) =>
                    items.map((it) => ({
                      ...it,
                      label:
                        ATTR_DISPLAY_LABEL[it.attribute] ?? it.label,
                      refinements:
                        it.attribute === "aiCategories"
                          ? it.refinements.map((r) => ({
                              ...r,
                              label: aiCategoryName(String(r.value)),
                            }))
                          : it.refinements,
                    }))
                  }
                  classNames={{
                    root: "current-refinements-root",
                    list: "current-refinements-list",
                    item: "current-refinements-item",
                    label: "current-refinements-label",
                    category: "current-refinements-category",
                    categoryLabel: "current-refinements-category-label",
                    delete: "current-refinements-delete",
                  }}
                />
              )}
            </div>
            <div
              className={
                "facets-drawer" + (filtersOpen ? " facets-drawer--open" : "")
              }
            >
              <button
                type="button"
                className="mobile-filter-close"
                aria-label="Close filters"
                onClick={() => setFiltersOpen(false)}
              >
                ×
              </button>
              {luceneMode && !attrPanelDismissed ? (
                <LuceneAttributesPanel
                  onClose={() => {
                    setAttrPanelDismissed(true);
                    setFiltersOpen(false);
                  }}
                />
              ) : null}
              {luceneMode ? null : (
                <>
                  <ClearRefinements
                    classNames={{
                      root: "clear-refinements-root",
                      button: "clear-refinements-button",
                      disabledButton: "clear-refinements-button-disabled",
                    }}
                    translations={{ resetButtonText: "Clear all filters" }}
                  />
                  <section className="facet-section">
                    <h2 className="facet-heading">Board</h2>
                    <BoardRefinement />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Status</h2>
                    <RefinementList attribute="status" limit={50} />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Category</h2>
                    <RefinementList
                      attribute="category_name"
                      searchable
                      searchablePlaceholder="Filter categories…"
                      showMore
                      limit={10}
                      showMoreLimit={200}
                    />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">AI category</h2>
                    <AiCategoryRefinement />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Author</h2>
                    <RefinementList
                      attribute="author_name"
                      searchable
                      searchablePlaceholder="Filter authors…"
                      showMore
                      limit={10}
                      showMoreLimit={500}
                    />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Voted by</h2>
                    <p className="facet-hint">
                      Posts with at least one matching voter.
                    </p>
                    <RefinementList
                      attribute="voter_name"
                      searchable
                      searchablePlaceholder="Filter voters…"
                      showMore
                      limit={10}
                      showMoreLimit={500}
                    />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Post dates</h2>
                    <h3 className="facet-subheading">Created</h3>
                    <EpochMsRangeInput attribute="post_created" />
                    <h3 className="facet-subheading">Updated</h3>
                    <EpochMsRangeInput attribute="post_updated" />
                    <h3 className="facet-subheading">Status changed</h3>
                    <EpochMsRangeInput attribute="post_statusChanged" />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Votes</h2>
                    <AutoNumericRangeInput attribute="score" />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Max votes</h2>
                    <AutoNumericRangeInput attribute="maxScore" />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Comment count</h2>
                    <AutoNumericRangeInput attribute="commentCount" />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Merge count</h2>
                    <AutoNumericRangeInput attribute="mergeCount" />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Trending</h2>
                    <AutoNumericRangeInput attribute="trendingScore" />
                  </section>
                  <section className="facet-section facet-toggle-group">
                    <h2 className="facet-heading">Vote settings</h2>
                    <ToggleRefinement
                      attribute="vote_highEngagement"
                      on="true"
                      label="High engagement votes"
                    />
                    <ToggleRefinement
                      attribute="vote_moderateEngagement"
                      on="true"
                      label="Moderate engagement votes"
                    />
                    <ToggleRefinement
                      attribute="vote_lowEngagement"
                      on="true"
                      label="Low engagement votes"
                    />
                  </section>
                  <section className="facet-section">
                    <h2 className="facet-heading">Comments</h2>
                    <p className="facet-hint">
                      Posts with at least one comment matching the selected
                      criteria.
                    </p>
                    <h3 className="facet-subheading">Comment author</h3>
                    <RefinementList
                      attribute="comment_author_name"
                      searchable
                      searchablePlaceholder="Filter comment authors…"
                      showMore
                      limit={10}
                      showMoreLimit={500}
                    />
                    <h3 className="facet-subheading">Comment like count</h3>
                    <AutoNumericRangeInput attribute="comment_likeCount" />
                    <h3 className="facet-subheading">Comment created</h3>
                    <EpochMsRangeInput attribute="comment_created" />
                    <ToggleRefinement
                      attribute="comment_pinned"
                      on="true"
                      label="Has pinned comment"
                    />
                  </section>
                </>
              )}
            </div>
            {filtersOpen ? (
              <div
                className="facets-backdrop"
                aria-hidden
                onClick={() => setFiltersOpen(false)}
              />
            ) : null}
          </aside>
          <section className="results">
            <Hits
              hitComponent={FeedbackHit}
              classNames={{
                root: "hit-list-root",
                list: "hit-list",
                item: "hit-list-item",
              }}
            />
            <Pagination
              padding={2}
              classNames={{
                root: "pagination-root",
                list: "pagination-list",
                item: "pagination-item",
                link: "pagination-link",
                selectedItem: "pagination-selected",
              }}
            />
          </section>
        </div>
      </main>
    </InstantSearch>
  );
}
