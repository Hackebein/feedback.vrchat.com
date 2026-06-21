import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentSearchParams } from "./searchFilterStore";

const NOTIFY_BASE = "/api/notify";

type Kind = "post" | "comment";

interface SubscriptionView {
  id: number;
  kind: Kind;
  label: string;
  createdAt: number;
}

const KIND_LABEL: Record<Kind, string> = {
  post: "new posts",
  comment: "new comments",
};

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
function describeFilter(params: Record<string, unknown>, kind: Kind): string {
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
    return kind === "comment" ? "All comments" : "All posts";
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

interface BellMenuProps {
  kind: Kind;
  vapidKey: string | null;
  endpoint: string | null;
  subs: SubscriptionView[];
  busy: boolean;
  error: string | null;
  open: boolean;
  luceneMode: boolean;
  onToggle: () => void;
  onEnable: () => void;
  onDelete: (id: number) => void;
}

function BellMenu({
  kind,
  vapidKey,
  endpoint,
  subs,
  busy,
  error,
  open,
  luceneMode,
  onToggle,
  onEnable,
  onDelete,
}: BellMenuProps) {
  const [webhook, setWebhook] = useState("");
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [webhookBusy, setWebhookBusy] = useState(false);
  const active = subs.length > 0;

  const addWebhook = useCallback(async () => {
    const url = webhook.trim();
    if (!url) return;
    setWebhookBusy(true);
    setWebhookStatus(null);
    try {
      const filter = getCurrentSearchParams();
      const res = await fetch(`${NOTIFY_BASE}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          webhookUrl: url,
          filter,
          lucene: luceneMode,
          label: describeFilter(filter, kind),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(data?.message ?? "Could not add webhook.");
      }
      setWebhook("");
      setWebhookStatus(`Webhook added for ${KIND_LABEL[kind]}.`);
    } catch (err) {
      setWebhookStatus(err instanceof Error ? err.message : "Could not add webhook.");
    } finally {
      setWebhookBusy(false);
    }
  }, [webhook, kind, luceneMode]);

  return (
    <div className="notify-bell">
      <button
        type="button"
        className={`notify-bell-button${active ? " is-active" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        title={`Notifications for ${KIND_LABEL[kind]}`}
        onClick={onToggle}
        disabled={!vapidKey}
      >
        <BellIcon filled={active} />
        {active ? <span className="notify-badge">{subs.length}</span> : null}
      </button>
      {open ? (
        <div className="notify-menu" role="menu">
          <div className="notify-menu-head">Notify me of {KIND_LABEL[kind]}</div>
          <button
            type="button"
            className="notify-enable"
            onClick={onEnable}
            disabled={busy}
          >
            {busy ? "Enabling\u2026" : "Enable for current filter"}
          </button>
          {error ? <div className="notify-error">{error}</div> : null}
          <div className="notify-list">
            {subs.length === 0 ? (
              <div className="notify-empty">No active subscriptions.</div>
            ) : (
              subs.map((s) => (
                <div className="notify-item" key={s.id}>
                  <span className="notify-item-label" title={s.label}>
                    {s.label || "(filter)"}
                  </span>
                  <button
                    type="button"
                    className="notify-remove"
                    title="Remove"
                    aria-label="Remove subscription"
                    onClick={() => onDelete(s.id)}
                    disabled={!endpoint}
                  >
                    {"\u00d7"}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="notify-webhook notify-webhook-menu">
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
              disabled={webhookBusy || webhook.trim() === ""}
            >
              {webhookBusy ? "Adding\u2026" : "Add webhook"}
            </button>
            {webhookStatus ? (
              <span className="notify-webhook-status">{webhookStatus}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Notifications({ luceneMode }: { luceneMode: boolean }) {
  const supported = pushSupported();
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [subs, setSubs] = useState<Record<Kind, SubscriptionView[]>>({
    post: [],
    comment: [],
  });
  const [openMenu, setOpenMenu] = useState<Kind | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [errors, setErrors] = useState<Record<Kind, string | null>>({
    post: null,
    comment: null,
  });
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
    // Reuse an existing browser push subscription if one is already registered.
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
      const next: Record<Kind, SubscriptionView[]> = { post: [], comment: [] };
      for (const s of data.subscriptions ?? []) {
        if (s.kind === "post" || s.kind === "comment") next[s.kind].push(s);
      }
      setSubs(next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (endpoint) void refreshList(endpoint);
  }, [endpoint, refreshList]);

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!openMenu) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openMenu]);

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

  const enableBell = useCallback(
    async (kind: Kind) => {
      setBusy(kind);
      setErrors((e) => ({ ...e, [kind]: null }));
      try {
        const result = await ensureSubscription();
        if (!result) throw new Error("Push notifications are unavailable.");
        const filter = getCurrentSearchParams();
        const label = describeFilter(filter, kind);
        const res = await fetch(`${NOTIFY_BASE}/subscriptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            pushSubscription: result.json,
            filter,
            lucene: luceneMode,
            label,
          }),
        });
        if (!res.ok) throw new Error("Could not save the subscription.");
        setEndpoint(result.endpoint);
        await refreshList(result.endpoint);
      } catch (err) {
        setErrors((e) => ({
          ...e,
          [kind]: err instanceof Error ? err.message : "Something went wrong.",
        }));
      } finally {
        setBusy(null);
      }
    },
    [ensureSubscription, luceneMode, refreshList],
  );

  const deleteSub = useCallback(
    async (kind: Kind, id: number) => {
      if (!endpoint) return;
      try {
        const res = await fetch(
          `${NOTIFY_BASE}/subscriptions/${id}?endpoint=${encodeURIComponent(endpoint)}`,
          { method: "DELETE" },
        );
        if (res.ok) await refreshList(endpoint);
      } catch {
        setErrors((e) => ({ ...e, [kind]: "Could not remove subscription." }));
      }
    },
    [endpoint, refreshList],
  );

  if (!supported) {
    return null;
  }

  return (
    <div className="notify-bar" ref={rootRef}>
      {(["post", "comment"] as Kind[]).map((kind) => (
        <BellMenu
          key={kind}
          kind={kind}
          vapidKey={vapidKey}
          endpoint={endpoint}
          subs={subs[kind]}
          busy={busy === kind}
          error={errors[kind]}
          open={openMenu === kind}
          luceneMode={luceneMode}
          onToggle={() => setOpenMenu((m) => (m === kind ? null : kind))}
          onEnable={() => void enableBell(kind)}
          onDelete={(id) => void deleteSub(kind, id)}
        />
      ))}
    </div>
  );
}
