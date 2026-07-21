type PostQueries = Record<string, unknown>;

function postQueryKeyHasSearch(key: string): boolean {
  try {
    const parsed = JSON.parse(key) as { textSearch?: unknown };
    return (
      typeof parsed.textSearch === "string" && parsed.textSearch.trim().length > 0
    );
  } catch {
    return key.includes('"textSearch"') || key.includes("textSearch");
  }
}

export function stripSearchPostQueries(data: Record<string, unknown>): number {
  const postQueries = data.postQueries;
  if (!postQueries || typeof postQueries !== "object" || Array.isArray(postQueries)) {
    return 0;
  }

  const queries = postQueries as PostQueries;
  let removed = 0;
  for (const key of Object.keys(queries)) {
    if (!postQueryKeyHasSearch(key)) {
      continue;
    }
    delete queries[key];
    removed += 1;
  }
  return removed;
}

function startScrubPoller(target: Window & typeof globalThis): void {
  const scrub = (): void => {
    const data = (target as Window & { __data?: Record<string, unknown> }).__data;
    if (!data || typeof data !== "object") {
      return;
    }
    stripSearchPostQueries(data);
  };

  scrub();

  const deadline = Date.now() + 15000;
  const tick = (): void => {
    scrub();
    if (Date.now() < deadline) {
      target.requestAnimationFrame(tick);
    }
  };
  target.requestAnimationFrame(tick);
}

export function installSsrHook(target: Window & typeof globalThis = window): void {
  const win = target as Window & { __data?: Record<string, unknown> };
  let stored = win.__data;

  if (stored && typeof stored === "object") {
    stripSearchPostQueries(stored);
  }

  try {
    Object.defineProperty(win, "__data", {
      configurable: true,
      enumerable: true,
      get() {
        return stored;
      },
      set(value: Record<string, unknown>) {
        if (value && typeof value === "object") {
          stripSearchPostQueries(value);
        }
        stored = value;
      },
    });
  } catch (error) {
    console.warn("[vrcfb] SSR hook using poller only", error);
  }

  startScrubPoller(target);
}
