import { createCannyDropdown } from "./canny-dropdown";
import {
  DEFAULT_SORT,
  getEffectiveSort,
  needsListRefresh,
  onFilterStateChange,
  setSort,
} from "./filter-state";
import { LUCENE_CLASS, SORT_OPTIONS } from "./filter-sidebar";
import { LUCENE_HELP_INTRO, LUCENE_HELP_ROWS, SORT_HELP } from "./lucene-help";
import { installSearchQueryWatch, readActiveSearchQuery } from "./search-refresh";
import type { BridgeSettings, BridgeStorage } from "./types";
import { writeBridgeSettings } from "./state";
import {
  getPrivateIndexStatus,
  onPrivateIndexStatus,
  type PrivateIndexStatus,
} from "./private-index";

const STYLE_ID = "vrcfb-control-style";
const CONTROL_ID = "vrcfb-control-root";
const HELP_ID = "vrcfb-lucene-help";

const CONTROL_CSS = `
.searchBar:has(#${CONTROL_ID}) {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
#${CONTROL_ID} {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.06);
  color: inherit;
  border: 1px solid rgba(0, 0, 0, 0.08);
  font: 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif;
}
#${CONTROL_ID} label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  cursor: pointer;
  margin: 0;
}
#${CONTROL_ID} input {
  margin: 0;
}
#${CONTROL_ID} .vrcfb-control-sort {
  display: none;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
html.${LUCENE_CLASS} #${CONTROL_ID} .vrcfb-control-sort {
  display: inline-flex;
}
#${CONTROL_ID} .vrcfb-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.7);
  color: #4b5563;
  font: 650 11px/1 system-ui, sans-serif;
  cursor: pointer;
}
#${CONTROL_ID} .vrcfb-help-btn:hover,
#${CONTROL_ID} .vrcfb-help-btn[aria-expanded="true"] {
  color: #2563eb;
  border-color: rgba(37, 99, 235, 0.35);
}
#${CONTROL_ID} .vrcfb-private-status {
  opacity: 0.75;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${CONTROL_ID} .vrcfb-private-status[hidden] {
  display: none;
}
#${HELP_ID} {
  position: fixed;
  z-index: 2147482001;
  width: min(480px, calc(100vw - 24px));
  max-height: min(70vh, 560px);
  overflow: auto;
  padding: 12px 14px 14px;
  border-radius: 12px;
  background: rgba(17, 24, 39, 0.96);
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  font: 11px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
}
#${HELP_ID}[hidden] {
  display: none;
}
#${HELP_ID} h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 650;
}
#${HELP_ID} h4 {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 650;
  color: #d1d5db;
}
#${HELP_ID} ul {
  margin: 0 0 10px;
  padding-left: 16px;
  color: #9ca3af;
}
#${HELP_ID} table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
#${HELP_ID} th,
#${HELP_ID} td {
  padding: 4px 0;
  vertical-align: top;
  text-align: left;
}
#${HELP_ID} th {
  color: #9ca3af;
  font-weight: 600;
  padding-bottom: 6px;
}
#${HELP_ID} code {
  font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #bfdbfe;
  word-break: break-word;
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CONTROL_CSS;
  document.documentElement.appendChild(style);
}

function findSearchBar(): HTMLElement | null {
  const input = document.querySelector<HTMLInputElement>(
    '.searchContainer input[placeholder="Search…"]',
  );
  if (!input) {
    return null;
  }
  return input.closest(".searchBar");
}

function buildHelpPanel(): HTMLElement {
  const panel = document.createElement("aside");
  panel.id = HELP_ID;
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Lucene search syntax help");

  const heading = document.createElement("h3");
  heading.textContent = "Lucene search";

  const introList = document.createElement("ul");
  for (const line of LUCENE_HELP_INTRO) {
    const item = document.createElement("li");
    item.textContent = line;
    introList.append(item);
  }

  const sortHeading = document.createElement("h4");
  sortHeading.textContent = "Sorting";
  const sortList = document.createElement("ul");
  for (const line of SORT_HELP) {
    const item = document.createElement("li");
    item.textContent = line;
    sortList.append(item);
  }

  const fieldsHeading = document.createElement("h4");
  fieldsHeading.textContent = "Field reference";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Field</th><th>Kind</th><th>Example</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of LUCENE_HELP_ROWS) {
    const tr = document.createElement("tr");
    const fieldCell = document.createElement("td");
    const fieldCode = document.createElement("code");
    fieldCode.textContent = row.field;
    fieldCell.appendChild(fieldCode);
    const kindCell = document.createElement("td");
    kindCell.textContent = row.kind;
    const exampleCell = document.createElement("td");
    const exampleCode = document.createElement("code");
    exampleCode.textContent = row.example;
    exampleCell.appendChild(exampleCode);
    tr.append(fieldCell, kindCell, exampleCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  panel.append(heading, introList, sortHeading, sortList, fieldsHeading, table);
  return panel;
}

function positionHelpPanel(panel: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  panel.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  panel.style.top = `${rect.bottom + 8}px`;
  panel.style.bottom = "auto";
  panel.style.left = "auto";
}

function createControlRoot(
  storage: BridgeStorage,
  initial: BridgeSettings,
  target: Window & typeof globalThis,
  onChange: (next: BridgeSettings) => void,
  onSearchRefresh: () => void,
  helpPanel: HTMLElement,
): HTMLElement {
  let current = { ...initial };
  const root = document.createElement("div");
  root.id = CONTROL_ID;

  const luceneLabel = document.createElement("label");
  const luceneInput = document.createElement("input");
  luceneInput.type = "checkbox";
  luceneInput.checked = current.luceneMode;
  luceneInput.addEventListener("change", () => {
    current = { ...current, luceneMode: luceneInput.checked };
    void writeBridgeSettings(storage, current).then(() => {
      onChange(current);
      if (readActiveSearchQuery(target) || needsListRefresh()) {
        onSearchRefresh();
      }
    });
  });
  luceneLabel.append(luceneInput, document.createTextNode("Lucene"));

  const sortLabel = document.createElement("label");
  sortLabel.className = "vrcfb-control-sort";
  sortLabel.appendChild(document.createTextNode("Sort"));
  const sortDropdown = createCannyDropdown({
    doc: document,
    options: SORT_OPTIONS,
    value:
      getEffectiveSort(readActiveSearchQuery(target)) || DEFAULT_SORT,
    searchable: false,
    variant: "compact",
    onChange: (value) => {
      setSort(value);
      onSearchRefresh();
    },
  });
  const syncSortDropdown = (): void => {
    sortDropdown.setValue(
      getEffectiveSort(readActiveSearchQuery(target)) || DEFAULT_SORT,
    );
  };
  onFilterStateChange(syncSortDropdown);
  installSearchQueryWatch(target, syncSortDropdown);
  sortLabel.appendChild(sortDropdown.root);

  const helpBtn = document.createElement("button");
  helpBtn.type = "button";
  helpBtn.className = "vrcfb-help-btn";
  helpBtn.textContent = "?";
  helpBtn.title = "Lucene syntax and sorting help";
  helpBtn.setAttribute("aria-expanded", "false");

  helpBtn.addEventListener("click", () => {
    const open = helpPanel.hidden;
    if (open) {
      positionHelpPanel(helpPanel, helpBtn);
    }
    helpPanel.hidden = !open;
    helpBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  root.append(luceneLabel, sortLabel, helpBtn);

  const privateStatus = document.createElement("span");
  privateStatus.className = "vrcfb-private-status";
  privateStatus.hidden = true;
  const renderPrivateStatus = (currentStatus: PrivateIndexStatus): void => {
    let label = "";
    if (currentStatus.phase === "listing") {
      label =
        currentStatus.postCount > 0
          ? `Indexing… ${currentStatus.postCount}`
          : "Indexing…";
    } else if (currentStatus.phase === "comments") {
      label = `Comments ${currentStatus.commentDone}/${currentStatus.commentTotal}`;
    } else if (currentStatus.postCount > 0) {
      label = `${currentStatus.postCount} private`;
    }
    privateStatus.textContent = label;
    privateStatus.hidden = !label;
    privateStatus.title = label
      ? "Local index of private boards this account can see"
      : "";
  };
  renderPrivateStatus(getPrivateIndexStatus());
  onPrivateIndexStatus(renderPrivateStatus);
  root.append(privateStatus);

  document.addEventListener("vrcfb-settings-changed", ((event: CustomEvent<BridgeSettings>) => {
    current = event.detail;
    luceneInput.checked = current.luceneMode;
  }) as EventListener);

  return root;
}

export function mountBridgeControl(
  storage: BridgeStorage,
  initial: BridgeSettings,
  target: Window & typeof globalThis,
  onChange: (next: BridgeSettings) => void,
  onSearchRefresh: () => void,
): void {
  ensureStyles();

  let helpPanel = document.getElementById(HELP_ID);
  if (!helpPanel) {
    helpPanel = buildHelpPanel();
    document.documentElement.appendChild(helpPanel);

    document.addEventListener(
      "click",
      (event) => {
        if (helpPanel?.hidden) {
          return;
        }
        const target = event.target;
        const helpBtn = document.querySelector(`#${CONTROL_ID} .vrcfb-help-btn`);
        if (
          target instanceof Node &&
          helpPanel &&
          !helpPanel.contains(target) &&
          !(helpBtn instanceof Node && helpBtn.contains(target))
        ) {
          helpPanel.hidden = true;
          if (helpBtn instanceof HTMLElement) {
            helpBtn.setAttribute("aria-expanded", "false");
          }
        }
      },
      true,
    );
  }

  const mount = (): boolean => {
    if (document.getElementById(CONTROL_ID)) {
      return true;
    }
    const searchBar = findSearchBar();
    if (!searchBar) {
      return false;
    }
    const root = createControlRoot(
      storage,
      initial,
      target,
      onChange,
      onSearchRefresh,
      helpPanel!,
    );
    searchBar.appendChild(root);
    if (readActiveSearchQuery(target)) {
      target.setTimeout(() => onSearchRefresh(), 100);
    }
    return true;
  };

  if (mount()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (mount()) {
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
