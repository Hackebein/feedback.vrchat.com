const STYLE_ID = "vrcfb-canny-dropdown-style";

const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const SEARCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>';

const DROPDOWN_CSS = `
.vrcfb-dropdown {
  position: relative;
  width: 100%;
}
.vrcfb-dropdown-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  min-height: 32px;
  padding: 0 8px 0 12px;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  text-transform: none;
  cursor: pointer;
}
.vrcfb-dropdown-trigger .vrcfb-dropdown-value {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vrcfb-dropdown-trigger.is-placeholder .vrcfb-dropdown-value {
  opacity: 0.65;
}
.vrcfb-dropdown-chevron {
  flex-shrink: 0;
  display: flex;
  opacity: 0.65;
}
.vrcfb-dropdown-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 5250;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.vrcfb-dropdown-panel.hidden {
  display: none;
}
.vrcfb-dropdown-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
}
.vrcfb-dropdown-search svg {
  flex-shrink: 0;
  opacity: 0.65;
}
.vrcfb-dropdown-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0;
  min-width: 0;
}
.vrcfb-dropdown-search input::placeholder {
  opacity: 0.65;
}
.vrcfb-dropdown-options {
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}
.vrcfb-dropdown-option {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-transform: none;
  padding: 6px 8px;
  cursor: pointer;
}
.vrcfb-dropdown-empty {
  padding: 8px;
  opacity: 0.6;
  font-size: 12px;
}
.vrcfb-dropdown.vrcfb-dropdown-compact {
  width: auto;
  min-width: 120px;
}
.vrcfb-dropdown.vrcfb-dropdown-compact .vrcfb-dropdown-trigger {
  min-height: 26px;
  padding: 2px 6px 2px 8px;
  font-size: 12px;
}
.vrcfb-dropdown.vrcfb-dropdown-compact .vrcfb-dropdown-panel {
  min-width: 160px;
}
`;

export type DropdownOption = { value: string; label: string };

export type CannyDropdownOptions = {
  doc: Document;
  options: DropdownOption[];
  value: string;
  placeholder?: string;
  /** When true, always show search. When false, never. When omitted, search appears for 9+ options. */
  searchable?: boolean;
  variant?: "default" | "compact";
  triggerClassName?: string;
  onChange: (value: string) => void;
};

export type CannyDropdownHandle = {
  root: HTMLElement;
  setValue: (value: string) => void;
  setOptions: (options: DropdownOption[]) => void;
  destroy: () => void;
};

let closeOpenDropdown: (() => void) | null = null;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = DROPDOWN_CSS;
  doc.documentElement.appendChild(style);
}

function labelFor(options: DropdownOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function createCannyDropdown(opts: CannyDropdownOptions): CannyDropdownHandle {
  ensureStyles(opts.doc);
  const doc = opts.doc;

  let options = opts.options;
  let value = opts.value;
  let searchText = "";
  let open = false;

  const searchable =
    opts.searchable ?? options.length > 8;

  const root = doc.createElement("div");
  root.className =
    opts.variant === "compact"
      ? "vrcfb-dropdown vrcfb-dropdown-compact"
      : "vrcfb-dropdown";

  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = ["vrcfb-dropdown-trigger", "input-border", opts.triggerClassName]
    .filter(Boolean)
    .join(" ");
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const valueEl = doc.createElement("span");
  valueEl.className = "vrcfb-dropdown-value";

  const chevron = doc.createElement("span");
  chevron.className = "vrcfb-dropdown-chevron";
  chevron.innerHTML = CHEVRON_SVG;

  trigger.append(valueEl, chevron);

  const panel = doc.createElement("div");
  panel.className =
    "vrcfb-dropdown-panel bg-popover text-popover-foreground base-border shadow-md rounded-sm hidden";
  panel.setAttribute("role", "listbox");

  let searchInput: HTMLInputElement | null = null;
  if (searchable) {
    const searchWrap = doc.createElement("div");
    searchWrap.className = "vrcfb-dropdown-search base-border-b p-1";
    searchWrap.innerHTML = SEARCH_SVG;
    searchInput = doc.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search";
    searchInput.setAttribute("aria-label", "Search");
    searchWrap.appendChild(searchInput);
    panel.appendChild(searchWrap);
  }

  const optionsEl = doc.createElement("div");
  optionsEl.className = "vrcfb-dropdown-options";
  panel.appendChild(optionsEl);

  root.append(trigger, panel);

  const syncTrigger = (): void => {
    const label = labelFor(options, value);
    const hasValue = options.some((option) => option.value === value);
    if (hasValue) {
      valueEl.textContent = label;
      trigger.classList.remove("is-placeholder");
    } else {
      valueEl.textContent = opts.placeholder ?? label;
      trigger.classList.add("is-placeholder");
    }
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const renderOptions = (): void => {
    optionsEl.replaceChildren();
    const query = searchText.trim().toLowerCase();
    const filtered = query
      ? options.filter((option) => option.label.toLowerCase().includes(query))
      : options;

    if (filtered.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "vrcfb-dropdown-empty";
      empty.textContent = "No results";
      optionsEl.appendChild(empty);
      return;
    }

    for (const option of filtered) {
      const button = doc.createElement("button");
      button.type = "button";
      const selected = option.value === value;
      button.className = [
        "vrcfb-dropdown-option",
        "rounded-sm",
        "hover:bg-accent",
        "hover:text-accent-foreground",
        selected ? "bg-accent text-accent-foreground" : "",
      ]
        .filter(Boolean)
        .join(" ");
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", option.value === value ? "true" : "false");
      button.textContent = option.label;
      button.addEventListener("click", () => {
        if (option.value !== value) {
          value = option.value;
          opts.onChange(value);
        }
        closePanel();
        syncTrigger();
        renderOptions();
      });
      optionsEl.appendChild(button);
    }
  };

  const closePanel = (): void => {
    if (!open) {
      return;
    }
    open = false;
    panel.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
    if (closeOpenDropdown === closePanel) {
      closeOpenDropdown = null;
    }
  };

  const openPanel = (): void => {
    closeOpenDropdown?.();
    open = true;
    closeOpenDropdown = closePanel;
    panel.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    searchText = "";
    if (searchInput) {
      searchInput.value = "";
    }
    renderOptions();
    if (searchInput) {
      searchInput.focus();
    }
  };

  trigger.addEventListener("click", () => {
    if (open) {
      closePanel();
    } else {
      openPanel();
    }
  });

  searchInput?.addEventListener("input", () => {
    searchText = searchInput?.value ?? "";
    renderOptions();
  });

  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePanel();
      trigger.focus();
    }
  });

  const onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Node) || !root.contains(target)) {
      closePanel();
    }
  };

  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      closePanel();
    }
  };

  doc.addEventListener("click", onDocumentClick, true);
  doc.addEventListener("keydown", onDocumentKeydown, true);

  syncTrigger();
  renderOptions();

  return {
    root,
    setValue(next) {
      value = next;
      syncTrigger();
      renderOptions();
    },
    setOptions(next) {
      options = next;
      syncTrigger();
      renderOptions();
    },
    destroy() {
      closePanel();
      doc.removeEventListener("click", onDocumentClick, true);
      doc.removeEventListener("keydown", onDocumentKeydown, true);
      root.remove();
    },
  };
}
