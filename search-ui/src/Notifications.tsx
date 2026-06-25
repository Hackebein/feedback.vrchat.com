import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentSearchParams } from "./searchFilterStore";

const NOTIFY_BASE = "/api/notify";

type EventType = "post" | "comment" | "votes" | "status" | "deleted";

const EVENT_ORDER: EventType[] = ["post", "comment", "votes", "status", "deleted"];

interface SubscriptionView {
  id: number;
  events: EventType[];
  label: string;
  filter: Record<string, unknown> | null;
  lucene: boolean;
  createdAt: number;
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Build a short, human-readable label from the live search filter. */
function describeFilter(params: Record<string, unknown>): string {
  const parts: string[] = [];
  const q = typeof params.query === "string" ? params.query.trim() : "";
  if (q) parts.push(`"${q}"`);

  const flat: string[] = [];
  const ff = params.facetFilters;
  if (Array.isArray(ff)) {
    for (const f of ff) {
      if (Array.isArray(f)) flat.push(...f.map((x) => String(x)));
      else if (typeof f === "string") flat.push(f);
    }
  }
  for (const f of flat) {
    const idx = f.indexOf(":");
    parts.push(idx > -1 ? f.slice(idx + 1) : f);
  }

  if (parts.length === 0) {
    return "All posts";
  }
  return parts.join(" \u00b7 ");
}

const BellIcon = ({ filled }: { filled: boolean }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

/** Icon glyphs for each event type, rendered inside the toggle buttons. */
function EventGlyph({ type }: { type: EventType }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (type) {
    case "post":
      return (
        <svg {...common}>
          <path d="M14 3v4a1 1 0 0 0 1 1h4" />
          <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M12 11v6M9 14h6" />
        </svg>
      );
    case "comment":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "votes":
      return (
        <svg {...common}>
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      );
    case "status":
      return (
        <svg {...common}>
          <path d="M4 22V4a1 1 0 0 1 1-1h11l-2 4 2 4H5" />
        </svg>
      );
    case "deleted":
      return (
        <svg {...common}>
          <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
      );
  }
}

const EVENT_LABEL: Record<EventType, string> = {
  post: "New posts",
  comment: "New comments",
  votes: "Vote changes",
  status: "Status changes",
  deleted: "Deletions / migrations",
};

function EventToggle({
  type,
  active,
  disabled,
  onToggle,
}: {
  type: EventType;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`notify-toggle${active ? " is-on" : ""}`}
      title={EVENT_LABEL[type]}
      aria-label={EVENT_LABEL[type]}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
    >
      <EventGlyph type={type} />
    </button>
  );
}

function toggleEvent(events: EventType[], type: EventType): EventType[] {
  if (events.includes(type)) {
    return events.filter((e) => e !== type);
  }
  return [...events, type];
}

/** Recursively sort object keys so two equivalent filters serialize identically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonical(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable identity for a filter, so the current filter and a saved row that
 *  describe the same search resolve to a single subscription. */
function filterKey(filter: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(canonical(filter ?? {}));
}

export function Notifications({ luceneMode }: { luceneMode: boolean }) {
  const supported = pushSupported();
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubscriptionView[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [webhook, setWebhook] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<EventType[]>(["post"]);
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    fetch(`${NOTIFY_BASE}/vapid-public-key`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.key === "string") {
          setVapidKey(data.key);
        }
      })
      .catch(() => undefined);
    navigator.serviceWorker
      .getRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled && sub) setEndpoint(sub.endpoint);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const refreshList = useCallback(async (ep: string) => {
    try {
      const res = await fetch(
        `${NOTIFY_BASE}/subscriptions?endpoint=${encodeURIComponent(ep)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { subscriptions?: SubscriptionView[] };
      setSubs(data.subscriptions ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (endpoint) void refreshList(endpoint);
  }, [endpoint, refreshList]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const ensureSubscription = useCallback(async (): Promise<{
    endpoint: string;
    json: PushSubscriptionJSON;
  } | null> => {
    if (!vapidKey) return null;
    if (Notification.permission === "denied") {
      throw new Error("Notifications are blocked in your browser settings.");
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
    return { endpoint: sub.endpoint, json: sub.toJSON() };
  }, [vapidKey]);

  // Persist the event set for a given filter (push). An empty set deletes it.
  const applyEvents = useCallback(
    async (
      filter: Record<string, unknown>,
      lucene: boolean,
      label: string,
      events: EventType[],
    ) => {
      setBusy(true);
      setError(null);
      try {
        const result = await ensureSubscription();
        if (!result) throw new Error("Push notifications are unavailable.");
        const res = await fetch(`${NOTIFY_BASE}/subscriptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            events,
            pushSubscription: result.json,
            filter,
            lucene,
            label,
          }),
        });
        if (!res.ok) throw new Error("Could not save the subscription.");
        setEndpoint(result.endpoint);
        await refreshList(result.endpoint);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [ensureSubscription, refreshList],
  );

  const deleteSub = useCallback(
    async (id: number) => {
      if (!endpoint) return;
      try {
        const res = await fetch(
          `${NOTIFY_BASE}/subscriptions/${id}?endpoint=${encodeURIComponent(endpoint)}`,
          { method: "DELETE" },
        );
        if (res.ok) await refreshList(endpoint);
      } catch {
        setError("Could not remove subscription.");
      }
    },
    [endpoint, refreshList],
  );

  const addWebhook = useCallback(async () => {
    const url = webhook.trim();
    if (!url || webhookEvents.length === 0) return;
    setWebhookBusy(true);
    setWebhookStatus(null);
    try {
      const filter = getCurrentSearchParams();
      const res = await fetch(`${NOTIFY_BASE}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: webhookEvents,
          webhookUrl: url,
          filter,
          lucene: luceneMode,
          label: describeFilter(filter),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(data?.message ?? "Could not add webhook.");
      }
      setWebhook("");
      setWebhookStatus("Webhook saved.");
    } catch (err) {
      setWebhookStatus(
        err instanceof Error ? err.message : "Could not add webhook.",
      );
    } finally {
      setWebhookBusy(false);
    }
  }, [webhook, webhookEvents, luceneMode]);

  // Match the live filter to a saved subscription by filter contents (not label,
  // which can collide), so the current row and saved list stay in sync and never
  // duplicate the same filter.
  const currentFilter = getCurrentSearchParams();
  const currentLabel = describeFilter(currentFilter);
  const currentKey = filterKey(currentFilter);
  const currentSub =
    subs.find((s) => filterKey(s.filter) === currentKey) ?? null;
  const currentEvents = currentSub?.events ?? [];
  const otherSubs = subs.filter((s) => s.id !== currentSub?.id);

  const toggleCurrent = useCallback(
    (type: EventType) => {
      const next = toggleEvent(currentEvents, type);
      void applyEvents(getCurrentSearchParams(), luceneMode, currentLabel, next);
    },
    [applyEvents, currentEvents, currentLabel, luceneMode],
  );

  const toggleSaved = useCallback(
    (sub: SubscriptionView, type: EventType) => {
      const next = toggleEvent(sub.events, type);
      void applyEvents(sub.filter ?? {}, sub.lucene, sub.label, next);
    },
    [applyEvents],
  );

  if (!supported) {
    return null;
  }

  const activeCount = subs.length;

  const renderToggles = (
    events: EventType[],
    onToggle: (type: EventType) => void,
  ): ReactNode => (
    <div className="notify-toggles">
      {EVENT_ORDER.map((type) => (
        <EventToggle
          key={type}
          type={type}
          active={events.includes(type)}
          disabled={busy || !vapidKey}
          onToggle={() => onToggle(type)}
        />
      ))}
    </div>
  );

  return (
    <div className="notify-bar" ref={rootRef}>
      <div className="notify-bell">
        <button
          type="button"
          className={`notify-bell-button${activeCount > 0 ? " is-active" : ""}`}
          aria-haspopup="true"
          aria-expanded={open}
          title="Notifications"
          onClick={() => setOpen((v) => !v)}
          disabled={!vapidKey}
        >
          <BellIcon filled={activeCount > 0} />
          {activeCount > 0 ? (
            <span className="notify-badge">{activeCount}</span>
          ) : null}
        </button>
        {open ? (
          <div className="notify-menu" role="menu">
            <div className="notify-menu-head">Notify me of</div>

            <div className="notify-section">
              <div className="notify-section-title">Current filter</div>
              <div className="notify-item is-current">
                <span className="notify-item-label" title={currentLabel}>
                  {currentLabel}
                </span>
                {renderToggles(currentEvents, toggleCurrent)}
              </div>
            </div>

            {error ? <div className="notify-error">{error}</div> : null}

            {otherSubs.length > 0 ? (
              <div className="notify-section">
                <div className="notify-section-title">Saved filters</div>
                <div className="notify-list">
                  {otherSubs.map((s) => (
                    <div className="notify-item" key={s.id}>
                      <span className="notify-item-label" title={s.label}>
                        {s.label || "(filter)"}
                      </span>
                      {renderToggles(s.events, (type) => toggleSaved(s, type))}
                      <button
                        type="button"
                        className="notify-remove"
                        title="Remove"
                        aria-label="Remove subscription"
                        onClick={() => void deleteSub(s.id)}
                        disabled={!endpoint}
                      >
                        {"\u00d7"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="notify-section notify-webhook-menu">
              <div className="notify-section-title">Discord webhook</div>
              <div className="notify-webhook">
                <input
                  type="url"
                  className="notify-webhook-input"
                  placeholder={"Webhook URL\u2026"}
                  value={webhook}
                  onChange={(e) => {
                    setWebhook(e.target.value);
                    setWebhookStatus(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addWebhook();
                  }}
                />
                <button
                  type="button"
                  className="notify-webhook-add"
                  onClick={() => void addWebhook()}
                  disabled={
                    webhookBusy ||
                    webhook.trim() === "" ||
                    webhookEvents.length === 0
                  }
                >
                  {webhookBusy ? "Saving\u2026" : "Save"}
                </button>
              </div>
              {renderWebhookToggles(webhookEvents, setWebhookEvents)}
              {webhookStatus ? (
                <span className="notify-webhook-status">{webhookStatus}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderWebhookToggles(
  events: EventType[],
  setEvents: (next: EventType[]) => void,
): ReactNode {
  return (
    <div className="notify-toggles notify-webhook-toggles">
      {EVENT_ORDER.map((type) => (
        <EventToggle
          key={type}
          type={type}
          active={events.includes(type)}
          disabled={false}
          onToggle={() => setEvents(toggleEvent(events, type))}
        />
      ))}
    </div>
  );
}
