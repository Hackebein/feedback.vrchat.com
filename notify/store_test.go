package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// TestMigrateLegacyKind verifies a database created with the old single-`kind`
// schema is cleaned (legacy subscriptions dropped) and reopens on the new
// schema without error, while keeping push endpoint registrations.
func TestMigrateLegacyKind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	if _, err := db.Exec(`
CREATE TABLE push_subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE subscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  push_subscription_id INTEGER REFERENCES push_subscription(id) ON DELETE CASCADE,
  webhook_url TEXT,
  lucene INTEGER NOT NULL DEFAULT 0,
  filter_json TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  watermark_ms INTEGER NOT NULL,
  error_since_ms INTEGER,
  created_at INTEGER NOT NULL
);
INSERT INTO push_subscription (endpoint, p256dh, auth, created_at)
VALUES ('https://push.example/ep', 'p', 'a', 1000);
-- Two legacy rows for the same endpoint+filter (post + comment): the old
-- two-bell model. These would collide on the new unique index, so migration
-- must clear them.
INSERT INTO subscription (kind, target, push_subscription_id, lucene, filter_json, label, watermark_ms, created_at)
VALUES ('post', 'push', 1, 0, '{}', 'All posts', 1000, 1000),
       ('comment', 'push', 1, 0, '{}', 'All posts', 1000, 1000);`); err != nil {
		t.Fatalf("seed legacy schema: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close raw: %v", err)
	}

	store, err := openStore(path)
	if err != nil {
		t.Fatalf("openStore (migrate): %v", err)
	}
	defer store.Close()

	subs, err := store.ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(subs) != 0 {
		t.Fatalf("subs len = %d, want 0 (legacy cleared)", len(subs))
	}

	// The push endpoint registration is kept and reusable.
	id, err := store.UpsertPushSubscription(PushKeys{Endpoint: "https://push.example/ep", P256dh: "p", Auth: "a"}, 2000)
	if err != nil {
		t.Fatalf("reuse push endpoint: %v", err)
	}
	if id != 1 {
		t.Fatalf("push endpoint id = %d, want 1 (preserved)", id)
	}
}

// TestUpsertWebhookOverwrites confirms reusing a known webhook URL overwrites
// its committed settings rather than creating a duplicate.
func TestUpsertWebhookOverwrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upsert.db")
	store, err := openStore(path)
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	defer store.Close()

	const url = "https://example.com/hook"
	id1, prev1, err := store.UpsertWebhookSubscription(Subscription{
		Events: []string{EventPost}, Target: "webhook", WebhookURL: url, FilterJSON: `{"a":1}`, Label: "first",
	}, 1000)
	if err != nil || prev1 != nil {
		t.Fatalf("first upsert: id=%d prev=%v err=%v (want new row, prev nil)", id1, prev1, err)
	}

	id2, prev2, err := store.UpsertWebhookSubscription(Subscription{
		Events: []string{EventVotes, EventStatus}, Target: "webhook", WebhookURL: url, FilterJSON: `{"b":2}`, Label: "second",
	}, 2000)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if len(prev2) != 1 || prev2[0] != EventPost {
		t.Fatalf("second upsert prev events = %v, want [post] (overwrite)", prev2)
	}
	if id1 != id2 {
		t.Fatalf("ids differ: %d vs %d", id1, id2)
	}

	subs, err := store.ListAll()
	if err != nil {
		t.Fatalf("ListAll: %v", err)
	}
	if len(subs) != 1 {
		t.Fatalf("subs len = %d, want 1 (overwrite)", len(subs))
	}
	got := subs[0]
	if got.FilterJSON != `{"b":2}` {
		t.Fatalf("filter not overwritten: %q", got.FilterJSON)
	}
	if len(got.Events) != 2 {
		t.Fatalf("events = %v, want 2", got.Events)
	}
}
