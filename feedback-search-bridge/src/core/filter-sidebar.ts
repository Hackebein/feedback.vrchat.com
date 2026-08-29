import { createCannyDropdown } from "./canny-dropdown";
import {
  DATE_ATTRS,
  DEFAULT_SORT,
  clearAllFilters,
  getRange,
  getRefinementValues,
  getEffectiveSort,
  getToggle,
  hasActiveFilters,
  isRefined,
  onFilterStateChange,
  setRange,
  setSort,
  setToggle,
  toggleRefinement,
} from "./filter-state";
import { onFacets } from "./search-handler";
import { ACTIVE_CLASS, isLocationCovered } from "./coverage";
import { aiCategoryName } from "./feature-tree";
import {
  filterNestedBoardNodes,
  nestBoardFacetEntries,
  type FacetEntry,
} from "./board-hierarchy";
import { installSearchQueryWatch, readActiveSearchQuery } from "./search-refresh";
import type { FacetStats, SearchFacets } from "./types";

/** Display label for a facet value (AI categories map internal ids to names). */
function valueLabel(attr: string, value: string): string {
  if (attr === "aiCategories") {
    return aiCategoryName(value);
  }
  return value;
}

const STYLE_ID = "vrcfb-sidebar-style";
const PANEL_ID = "vrcfb-filter-panel";
export const LUCENE_CLASS = "vrcfb-lucene";
const SIDEBAR_CONTAINER_SELECTOR = ".sidebarContainer";
const NATIVE_BOARD_SELECTOR = "ul.boardListContainer";
const COLLAPSED_LIMIT = 8;

type ListSection = { kind: "list"; attr: string; label: string; searchable: boolean };
type RangeSection = { kind: "range"; attr: string; label: string };
type ToggleSection = { kind: "toggle"; attr: string; label: string };
type GroupSection = {
  kind: "group";
  label: string;
  hint?: string;
  items: (ListSection | RangeSection | ToggleSection)[];
};
type Section = ListSection | RangeSection | ToggleSection | GroupSection;

const SECTIONS: Section[] = [
  { kind: "list", attr: "board_name", label: "Board", searchable: true },
  { kind: "list", attr: "status", label: "Status", searchable: false },
  { kind: "list", attr: "category_name", label: "Category", searchable: true },
  { kind: "list", attr: "aiCategories", label: "AI category", searchable: true },
  { kind: "list", attr: "author_name", label: "Author", searchable: true },
  { kind: "list", attr: "voter_name", label: "Voted by", searchable: true },
  {
    kind: "group",
    label: "Post dates",
    items: [
      { kind: "range", attr: "post_created", label: "Created" },
      { kind: "range", attr: "post_updated", label: "Updated" },
      { kind: "range", attr: "post_statusChanged", label: "Status changed" },
    ],
  },
  {
    kind: "group",
    label: "Engagement",
    items: [
      { kind: "range", attr: "score", label: "Votes" },
      { kind: "range", attr: "maxScore", label: "Max votes" },
      { kind: "range", attr: "commentCount", label: "Comment count" },
      { kind: "range", attr: "mergeCount", label: "Merge count" },
      { kind: "range", attr: "trendingScore", label: "Trending" },
    ],
  },
  {
    kind: "group",
    label: "Vote settings",
    items: [
      { kind: "toggle", attr: "vote_highEngagement", label: "High engagement votes" },
      { kind: "toggle", attr: "vote_moderateEngagement", label: "Moderate engagement votes" },
      { kind: "toggle", attr: "vote_lowEngagement", label: "Low engagement votes" },
    ],
  },
  {
    kind: "group",
    label: "Comments",
    hint: "Posts with at least one comment matching the selected criteria.",
    items: [
      { kind: "list", attr: "comment_author_name", label: "Comment author", searchable: true },
      { kind: "range", attr: "comment_likeCount", label: "Comment like count" },
      { kind: "range", attr: "comment_created", label: "Comment created" },
      { kind: "toggle", attr: "comment_pinned", label: "Has pinned comment" },
    ],
  },
];

export const SORT_OPTIONS: { label: string; value: string }[] = [
  { label: "Newest", value: "newest" },
  { label: "Oldest", value: "created_asc" },
  { label: "Newest activity", value: "activity_desc" },
  { label: "Oldest activity", value: "activity_asc" },
  { label: "Most voters", value: "score_desc" },
  { label: "Fewest voters", value: "score_asc" },
  { label: "Relevance", value: "relevance_desc" },
];

const ATTR_LABEL = new Map<string, string>();
for (const section of SECTIONS) {
  if (section.kind === "group") {
    for (const item of section.items) {
      ATTR_LABEL.set(item.attr, item.label);
    }
  } else {
    ATTR_LABEL.set(section.attr, section.label);
  }
}

const SIDEBAR_CSS = `
html.${ACTIVE_CLASS} ${NATIVE_BOARD_SELECTOR} { display: none !important; }
/* Canny's native sort/filter dropdown is replaced by the sidebar widgets,
   but the search box lives in the same toolbar so only hide the menu. */
html.${ACTIVE_CLASS} .postListMenu .menu { display: none !important; }
/* Board name + description block above the create-post form. */
html.${ACTIVE_CLASS} .boardHeader { display: none !important; }
/* Native home roadmap is replaced by our gateway-backed columns (our own copy
   reuses the roadmapView class for styling, so exclude it from the hide). */
html.${ACTIVE_CLASS} .roadmapView:not(#vrcfb-roadmap) { display: none !important; }
/* On boards we do not cover, keep the bridge UI out of the way entirely. */
html:not(.${ACTIVE_CLASS}) #${PANEL_ID},
html:not(.${ACTIVE_CLASS}) #vrcfb-attribution,
html:not(.${ACTIVE_CLASS}) #vrcfb-control-root { display: none !important; }
#${PANEL_ID} {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 0 0 16px;
  font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
  color: inherit;
}
html.${ACTIVE_CLASS}.${LUCENE_CLASS} .sidebarContainerWrapper { display: none !important; }
html.${ACTIVE_CLASS}.${LUCENE_CLASS} .mainContainer { width: 100% !important; max-width: none !important; }
#${PANEL_ID} .vrcfb-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#${PANEL_ID} .vrcfb-panel-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}
#${PANEL_ID} .vrcfb-clear {
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
#${PANEL_ID} .vrcfb-clear[disabled] { opacity: 0.4; cursor: default; }
#${PANEL_ID} .vrcfb-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#${PANEL_ID} .vrcfb-chip-active {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(37, 99, 235, 0.12);
  border: 1px solid rgba(37, 99, 235, 0.35);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
}
#${PANEL_ID} .vrcfb-chip-active button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0;
}
#${PANEL_ID} .vrcfb-sort { display: flex; flex-direction: column; gap: 4px; }
#${PANEL_ID} .vrcfb-section { display: flex; flex-direction: column; gap: 6px; }
#${PANEL_ID} .vrcfb-section-heading {
  font-size: 12px;
  font-weight: 700;
  margin: 0;
}
#${PANEL_ID} .vrcfb-subheading {
  font-size: 11px;
  font-weight: 600;
  opacity: 0.7;
  margin: 4px 0 0;
}
#${PANEL_ID} .vrcfb-hint { font-size: 11px; opacity: 0.6; margin: 0; }
#${PANEL_ID} .vrcfb-facet-search {
  width: 100%;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: inherit;
  color: inherit;
  font-size: 12px;
}
#${PANEL_ID} .vrcfb-list { display: flex; flex-direction: column; gap: 2px; }
#${PANEL_ID} .vrcfb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 1px 0;
}
#${PANEL_ID} .vrcfb-row input { margin: 0; }
#${PANEL_ID} .vrcfb-row-child { padding-left: 18px; }
#${PANEL_ID} .vrcfb-row-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${PANEL_ID} .vrcfb-count { opacity: 0.55; font-variant-numeric: tabular-nums; }
#${PANEL_ID} .vrcfb-empty { opacity: 0.5; font-size: 11px; }
#${PANEL_ID} .vrcfb-more {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: #2563eb;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 0;
}
#${PANEL_ID} .vrcfb-range { display: flex; align-items: center; gap: 6px; }
#${PANEL_ID} .vrcfb-range input {
  width: 100%;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(127, 127, 127, 0.4);
  background: inherit;
  color: inherit;
  font-size: 12px;
}
#${PANEL_ID} .vrcfb-range span { opacity: 0.5; }
#${PANEL_ID} .vrcfb-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; }
`;

let facetData: SearchFacets = { facets: {}, stats: {} };
let bridgeWindow: (Window & typeof globalThis) | null = null;
const searchTextByAttr = new Map<string, string>();
const expandedByAttr = new Map<string, boolean>();

/**
 * All board display names from Canny's store. The gateway scopes the
 * `board_name` facet to the active board filter, so once one board is picked
 * the others vanish from the response; seeding the full list keeps every board
 * selectable for multi-select.
 */
function readAllBoardNames(): string[] {
  const items = (bridgeWindow as unknown as {
    __data?: { boards?: { items?: Record<string, { name?: string }> } };
  } | null)?.__data?.boards?.items;
  if (!items || typeof items !== "object") {
    return [];
  }
  const names: string[] = [];
  for (const board of Object.values(items)) {
    const name = typeof board?.name === "string" ? board.name.trim() : "";
    if (name) {
      names.push(name);
    }
  }
  return names;
}

type Refresher = () => void;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function ensureStyles(target: Window & typeof globalThis): void {
  if (target.document.getElementById(STYLE_ID)) {
    return;
  }
  const style = target.document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SIDEBAR_CSS;
  target.document.documentElement.appendChild(style);
}

export function applyLuceneMode(
  target: Window & typeof globalThis,
  lucene: boolean,
): void {
  target.document.documentElement.classList.toggle(LUCENE_CLASS, lucene);
}

function epochToDateInput(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function dateInputToEpoch(value: string, endOfDay: boolean): number | undefined {
  if (!value) {
    return undefined;
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return endOfDay ? ms + 86_399_999 : ms;
}

function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

function facetEntries(attr: string): { value: string; count: number }[] {
  const counts = facetData.facets[attr] ?? {};
  const entries = Object.entries(counts).map(([value, count]) => ({
    value,
    count: Number(count) || 0,
  }));
  // Always show every board so multiple boards stay selectable even after the
  // board filter scopes the facet response down to the chosen board(s).
  if (attr === "board_name") {
    for (const name of readAllBoardNames()) {
      if (!entries.some((entry) => entry.value === name)) {
        entries.push({ value: name, count: 0 });
      }
    }
  }
  // Keep selected values visible even if absent from the latest facet response.
  for (const selected of getRefinementValues(attr)) {
    if (!entries.some((entry) => entry.value === selected)) {
      entries.push({ value: selected, count: 0 });
    }
  }
  entries.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return entries;
}

function renderFacetRow(
  doc: Document,
  container: HTMLElement,
  attr: string,
  entry: FacetEntry,
  refresh: Refresher,
  child: boolean,
): void {
  const row = el(doc, "label", child ? "vrcfb-row vrcfb-row-child" : "vrcfb-row");
  const input = el(doc, "input");
  input.type = "checkbox";
  input.checked = isRefined(attr, entry.value);
  input.addEventListener("change", () => {
    toggleRefinement(attr, entry.value);
    refresh();
  });
  const displayLabel = valueLabel(attr, entry.value);
  const label = el(doc, "span", "vrcfb-row-label", displayLabel || "(empty)");
  label.title = displayLabel;
  const count = el(doc, "span", "vrcfb-count", formatCount(entry.count));
  row.append(input, label, count);
  container.appendChild(row);
}

function renderList(
  doc: Document,
  container: HTMLElement,
  attr: string,
  refresh: Refresher,
): void {
  container.replaceChildren();
  const search = (searchTextByAttr.get(attr) ?? "").toLowerCase();
  const expanded = expandedByAttr.get(attr) === true;

  if (attr === "board_name") {
    const nodes = filterNestedBoardNodes(
      nestBoardFacetEntries(facetEntries(attr)),
      search,
    );
    if (nodes.length === 0) {
      container.appendChild(el(doc, "div", "vrcfb-empty", "No values"));
      return;
    }
    const visible = expanded ? nodes : nodes.slice(0, COLLAPSED_LIMIT);
    for (const node of visible) {
      renderFacetRow(doc, container, attr, node, refresh, false);
      for (const child of node.children) {
        renderFacetRow(doc, container, attr, child, refresh, true);
      }
    }
    if (nodes.length > COLLAPSED_LIMIT) {
      const more = el(
        doc,
        "button",
        "vrcfb-more",
        expanded ? "Show less" : `Show ${nodes.length - COLLAPSED_LIMIT} more`,
      );
      more.type = "button";
      more.addEventListener("click", () => {
        expandedByAttr.set(attr, !expanded);
        renderList(doc, container, attr, refresh);
      });
      container.appendChild(more);
    }
    return;
  }

  let entries = facetEntries(attr);
  if (search) {
    entries = entries.filter(
      (entry) =>
        entry.value.toLowerCase().includes(search) ||
        valueLabel(attr, entry.value).toLowerCase().includes(search),
    );
  }

  if (entries.length === 0) {
    container.appendChild(el(doc, "div", "vrcfb-empty", "No values"));
    return;
  }

  const visible = expanded ? entries : entries.slice(0, COLLAPSED_LIMIT);
  for (const entry of visible) {
    renderFacetRow(doc, container, attr, entry, refresh, false);
  }

  if (entries.length > COLLAPSED_LIMIT) {
    const more = el(
      doc,
      "button",
      "vrcfb-more",
      expanded ? "Show less" : `Show ${entries.length - COLLAPSED_LIMIT} more`,
    );
    more.type = "button";
    more.addEventListener("click", () => {
      expandedByAttr.set(attr, !expanded);
      renderList(doc, container, attr, refresh);
    });
    container.appendChild(more);
  }
}

function buildListSection(
  doc: Document,
  section: ListSection,
  refresh: Refresher,
  registerUpdate: (fn: () => void) => void,
): HTMLElement {
  const wrap = el(doc, "section", "vrcfb-section");
  wrap.appendChild(el(doc, "h2", "vrcfb-section-heading", section.label));

  if (section.searchable) {
    const input = el(doc, "input", "vrcfb-facet-search");
    input.type = "search";
    input.placeholder = `Filter ${section.label.toLowerCase()}…`;
    input.value = searchTextByAttr.get(section.attr) ?? "";
    input.addEventListener("input", () => {
      searchTextByAttr.set(section.attr, input.value);
      renderList(doc, list, section.attr, refresh);
    });
    wrap.appendChild(input);
  }

  const list = el(doc, "div", "vrcfb-list");
  wrap.appendChild(list);
  registerUpdate(() => renderList(doc, list, section.attr, refresh));
  renderList(doc, list, section.attr, refresh);
  return wrap;
}

function buildRangeControls(
  doc: Document,
  attr: string,
  refresh: Refresher,
  registerUpdate: (fn: () => void) => void,
): HTMLElement {
  const isDate = DATE_ATTRS.has(attr);
  const row = el(doc, "div", "vrcfb-range");
  const minInput = el(doc, "input");
  const maxInput = el(doc, "input");
  minInput.type = isDate ? "date" : "number";
  maxInput.type = isDate ? "date" : "number";
  if (!isDate) {
    minInput.placeholder = "min";
    maxInput.placeholder = "max";
  }

  const commit = (): void => {
    const range = getRange(attr);
    let min: number | undefined;
    let max: number | undefined;
    if (isDate) {
      min = dateInputToEpoch(minInput.value, false);
      max = dateInputToEpoch(maxInput.value, true);
    } else {
      min = minInput.value === "" ? undefined : Number(minInput.value);
      max = maxInput.value === "" ? undefined : Number(maxInput.value);
    }
    if (min === range.min && max === range.max) {
      return;
    }
    setRange(attr, { min, max });
    refresh();
  };

  minInput.addEventListener("change", commit);
  maxInput.addEventListener("change", commit);

  const sync = (): void => {
    const range = getRange(attr);
    if (isDate) {
      minInput.value = epochToDateInput(range.min);
      maxInput.value = epochToDateInput(
        range.max === undefined ? undefined : range.max - 86_399_999,
      );
    } else {
      minInput.value = range.min === undefined ? "" : String(range.min);
      maxInput.value = range.max === undefined ? "" : String(range.max);
      const stat: FacetStats[string] | undefined = facetData.stats[attr];
      if (stat) {
        minInput.placeholder = stat.min === undefined ? "min" : `min ${stat.min}`;
        maxInput.placeholder = stat.max === undefined ? "max" : `max ${stat.max}`;
      }
    }
  };

  registerUpdate(sync);
  sync();

  row.append(minInput, el(doc, "span", undefined, "–"), maxInput);
  return row;
}

function buildToggle(
  doc: Document,
  section: ToggleSection,
  refresh: Refresher,
  registerUpdate: (fn: () => void) => void,
): HTMLElement {
  const label = el(doc, "label", "vrcfb-toggle");
  const input = el(doc, "input");
  input.type = "checkbox";
  input.checked = getToggle(section.attr);
  input.addEventListener("change", () => {
    setToggle(section.attr, input.checked);
    refresh();
  });
  label.append(input, el(doc, "span", undefined, section.label));
  registerUpdate(() => {
    input.checked = getToggle(section.attr);
  });
  return label;
}

function buildItem(
  doc: Document,
  item: ListSection | RangeSection | ToggleSection,
  refresh: Refresher,
  registerUpdate: (fn: () => void) => void,
  withSubheading: boolean,
): HTMLElement {
  if (item.kind === "list") {
    return buildListSection(doc, item, refresh, registerUpdate);
  }
  if (item.kind === "toggle") {
    return buildToggle(doc, item, refresh, registerUpdate);
  }
  const holder = el(doc, "div", "vrcfb-section");
  if (withSubheading) {
    holder.appendChild(el(doc, "h3", "vrcfb-subheading", item.label));
  }
  holder.appendChild(buildRangeControls(doc, item.attr, refresh, registerUpdate));
  return holder;
}

function buildSort(
  doc: Document,
  target: Window & typeof globalThis,
  refresh: Refresher,
  registerUpdate: (fn: () => void) => void,
): HTMLElement {
  const wrap = el(doc, "div", "vrcfb-sort");
  wrap.appendChild(el(doc, "span", "vrcfb-panel-title", "Sort"));
  const dropdown = createCannyDropdown({
    doc,
    options: SORT_OPTIONS,
    value:
      getEffectiveSort(readActiveSearchQuery(target)) || DEFAULT_SORT,
    searchable: false,
    onChange: (value) => {
      setSort(value);
      refresh();
    },
  });
  registerUpdate(() => {
    dropdown.setValue(
      getEffectiveSort(readActiveSearchQuery(target)) || DEFAULT_SORT,
    );
  });
  wrap.appendChild(dropdown.root);
  return wrap;
}

function buildChips(doc: Document, refresh: Refresher): HTMLElement {
  const wrap = el(doc, "div", "vrcfb-chips");

  const addChip = (label: string, onRemove: () => void): void => {
    const chip = el(doc, "span", "vrcfb-chip-active");
    chip.appendChild(el(doc, "span", undefined, label));
    const remove = el(doc, "button", undefined, "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.addEventListener("click", () => {
      onRemove();
      refresh();
    });
    chip.appendChild(remove);
    wrap.appendChild(chip);
  };

  for (const attr of ATTR_LABEL.keys()) {
    for (const value of getRefinementValues(attr)) {
      addChip(`${ATTR_LABEL.get(attr)}: ${valueLabel(attr, value)}`, () =>
        toggleRefinement(attr, value),
      );
    }
  }
  for (const attr of ATTR_LABEL.keys()) {
    const range = getRange(attr);
    if (range.min !== undefined || range.max !== undefined) {
      const isDate = DATE_ATTRS.has(attr);
      const lo = isDate ? epochToDateInput(range.min) : range.min;
      const hi = isDate
        ? epochToDateInput(range.max === undefined ? undefined : range.max - 86_399_999)
        : range.max;
      addChip(`${ATTR_LABEL.get(attr)}: ${lo ?? "*"}–${hi ?? "*"}`, () =>
        setRange(attr, {}),
      );
    }
    if (getToggle(attr)) {
      addChip(`${ATTR_LABEL.get(attr)}`, () => setToggle(attr, false));
    }
  }

  return wrap;
}

function buildPanel(
  target: Window & typeof globalThis,
  refresh: Refresher,
): { panel: HTMLElement; update: () => void } {
  const doc = target.document;
  const panel = el(doc, "div", undefined);
  panel.id = PANEL_ID;

  const updaters: (() => void)[] = [];
  const registerUpdate = (fn: () => void): void => {
    updaters.push(fn);
  };

  const head = el(doc, "div", "vrcfb-panel-head");
  head.appendChild(el(doc, "span", "vrcfb-panel-title", "Filters"));
  const clear = el(doc, "button", "vrcfb-clear", "Clear all");
  clear.type = "button";
  clear.addEventListener("click", () => {
    clearAllFilters();
    refresh();
  });
  head.appendChild(clear);
  panel.appendChild(head);

  let chips = buildChips(doc, refresh);
  panel.appendChild(chips);

  panel.appendChild(buildSort(doc, target, refresh, registerUpdate));

  for (const section of SECTIONS) {
    if (section.kind === "group") {
      const group = el(doc, "section", "vrcfb-section");
      group.appendChild(el(doc, "h2", "vrcfb-section-heading", section.label));
      if (section.hint) {
        group.appendChild(el(doc, "p", "vrcfb-hint", section.hint));
      }
      for (const item of section.items) {
        group.appendChild(buildItem(doc, item, refresh, registerUpdate, true));
      }
      panel.appendChild(group);
    } else {
      panel.appendChild(buildItem(doc, section, refresh, registerUpdate, false));
    }
  }

  const update = (): void => {
    clear.disabled = !hasActiveFilters();
    const nextChips = buildChips(doc, refresh);
    chips.replaceWith(nextChips);
    chips = nextChips;
    for (const fn of updaters) {
      fn();
    }
  };

  update();
  return { panel, update };
}

export function installFilterSidebar(
  target: Window & typeof globalThis,
  onRefresh: Refresher,
  onVisible?: () => void,
): void {
  ensureStyles(target);
  bridgeWindow = target;

  let update: (() => void) | null = null;

  const mount = (): void => {
    const doc = target.document;
    if (!isLocationCovered(target)) {
      doc.getElementById(PANEL_ID)?.remove();
      return;
    }
    if (doc.getElementById(PANEL_ID)) {
      return;
    }
    const container = doc.querySelector<HTMLElement>(SIDEBAR_CONTAINER_SELECTOR);
    if (!container) {
      return;
    }
    const built = buildPanel(target, onRefresh);
    update = built.update;
    container.insertBefore(built.panel, container.firstChild);
    // Populate facet counts whenever the panel (re)appears, e.g. after SPA
    // navigation re-renders Canny's sidebar.
    onVisible?.();
  };

  mount();

  const observer = new MutationObserver(() => {
    if (!target.document.getElementById(PANEL_ID)) {
      mount();
    }
  });
  observer.observe(target.document.documentElement, {
    childList: true,
    subtree: true,
  });

  onFacets((facets: SearchFacets) => {
    const boardName = facets.facets.board_name ?? facetData.facets.board_name;
    facetData = {
      stats: facets.stats,
      facets: {
        ...facets.facets,
        ...(boardName ? { board_name: boardName } : {}),
      },
    };
    update?.();
  });

  onFilterStateChange(() => {
    update?.();
  });

  installSearchQueryWatch(target, () => {
    update?.();
  });
}
