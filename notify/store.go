package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Store wraps the SQLite database that persists push subscriptions and the
// filter subscriptions (browser push or webhook) attached to them.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS push_subscription (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL,
  target               TEXT NOT NULL,
  push_subscription_id INTEGER REFERENCES push_subscription(id) ON DELETE CASCADE,
  webhook_url          TEXT,
  lucene               INTEGER NOT NULL DEFAULT 0,
  filter_json          TEXT NOT NULL,
  label                TEXT NOT NULL DEFAULT '',
  watermark_ms         INTEGER NOT NULL,
  error_since_ms       INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_push ON subscription(push_subscription_id);
`

// PushKeys is the browser-provided keying material needed to encrypt a push.
type PushKeys struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// Subscription is a filter subscription joined with its push keys (when the
// target is a browser push). It is the unit the dispatcher iterates over.
type Subscription struct {
	ID                 int64
	Kind               string // "post" | "comment"
	Target             string // "push" | "webhook"
	PushSubscriptionID sql.NullInt64
	WebhookURL         string
	Lucene             bool
	FilterJSON         string
	Label              string
	WatermarkMS        int64
	ErrorSinceMS       sql.NullInt64
	Push               PushKeys
}

// SubscriptionView is the trimmed shape returned to the browser for listing.
type SubscriptionView struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	CreatedAt int64  `json:"createdAt"`
}

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// UpsertPushSubscription stores (or refreshes) the keys for an endpoint and
// returns the row id.
func (s *Store) UpsertPushSubscription(keys PushKeys, nowMS int64) (int64, error) {
	_, err := s.db.Exec(
		`INSERT INTO push_subscription (endpoint, p256dh, auth, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
		keys.Endpoint, keys.P256dh, keys.Auth, nowMS,
	)
	if err != nil {
		return 0, err
	}
	var id int64
	if err := s.db.QueryRow(`SELECT id FROM push_subscription WHERE endpoint = ?`, keys.Endpoint).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

// DeletePushSubscriptionByEndpoint removes a browser and cascades to its
// filter subscriptions. Used when a push endpoint reports 404/410 Gone.
func (s *Store) DeletePushSubscriptionByEndpoint(endpoint string) error {
	_, err := s.db.Exec(`DELETE FROM push_subscription WHERE endpoint = ?`, endpoint)
	return err
}

// CreateSubscription inserts a filter subscription and returns its id.
func (s *Store) CreateSubscription(sub Subscription, nowMS int64) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO subscription
		   (kind, target, push_subscription_id, webhook_url, lucene, filter_json, label, watermark_ms, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sub.Kind, sub.Target, sub.PushSubscriptionID, nullStr(sub.WebhookURL),
		boolToInt(sub.Lucene), sub.FilterJSON, sub.Label, sub.WatermarkMS, nowMS,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListByEndpoint returns the push subscriptions belonging to a single browser,
// for the management dropdowns. An empty kind returns both posts and comments.
func (s *Store) ListByEndpoint(endpoint string, kind string) ([]SubscriptionView, error) {
	query := `SELECT sub.id, sub.kind, sub.label, sub.created_at
		   FROM subscription sub
		   JOIN push_subscription ps ON ps.id = sub.push_subscription_id
		  WHERE ps.endpoint = ? AND sub.target = 'push'`
	args := []interface{}{endpoint}
	if kind != "" {
		query += ` AND sub.kind = ?`
		args = append(args, kind)
	}
	query += ` ORDER BY sub.created_at DESC`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriptionView{}
	for rows.Next() {
		var v SubscriptionView
		if err := rows.Scan(&v.ID, &v.Kind, &v.Label, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// DeleteSubscriptionForEndpoint deletes a single push subscription, but only if
// it belongs to the requesting browser (endpoint), so users can only remove
// their own bells.
func (s *Store) DeleteSubscriptionForEndpoint(id int64, endpoint string) (bool, error) {
	res, err := s.db.Exec(
		`DELETE FROM subscription
		  WHERE id = ?
		    AND target = 'push'
		    AND push_subscription_id = (SELECT id FROM push_subscription WHERE endpoint = ?)`,
		id, endpoint,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// DeleteSubscription removes a subscription unconditionally (used for webhook
// auto-expiry).
func (s *Store) DeleteSubscription(id int64) error {
	_, err := s.db.Exec(`DELETE FROM subscription WHERE id = ?`, id)
	return err
}

// ListAll returns every subscription joined with push keys, for dispatching.
func (s *Store) ListAll() ([]Subscription, error) {
	rows, err := s.db.Query(
		`SELECT sub.id, sub.kind, sub.target, sub.push_subscription_id, COALESCE(sub.webhook_url, ''),
		        sub.lucene, sub.filter_json, sub.label, sub.watermark_ms, sub.error_since_ms,
		        COALESCE(ps.endpoint, ''), COALESCE(ps.p256dh, ''), COALESCE(ps.auth, '')
		   FROM subscription sub
		   LEFT JOIN push_subscription ps ON ps.id = sub.push_subscription_id
		  ORDER BY sub.id ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Subscription{}
	for rows.Next() {
		var sub Subscription
		var lucene int
		if err := rows.Scan(
			&sub.ID, &sub.Kind, &sub.Target, &sub.PushSubscriptionID, &sub.WebhookURL,
			&lucene, &sub.FilterJSON, &sub.Label, &sub.WatermarkMS, &sub.ErrorSinceMS,
			&sub.Push.Endpoint, &sub.Push.P256dh, &sub.Push.Auth,
		); err != nil {
			return nil, err
		}
		sub.Lucene = lucene != 0
		out = append(out, sub)
	}
	return out, rows.Err()
}

func (s *Store) UpdateWatermark(id, watermarkMS int64) error {
	_, err := s.db.Exec(`UPDATE subscription SET watermark_ms = ? WHERE id = ?`, watermarkMS, id)
	return err
}

func (s *Store) SetWebhookError(id, errorSinceMS int64) error {
	_, err := s.db.Exec(
		`UPDATE subscription SET error_since_ms = ? WHERE id = ? AND error_since_ms IS NULL`,
		errorSinceMS, id,
	)
	return err
}

func (s *Store) ClearWebhookError(id int64) error {
	_, err := s.db.Exec(`UPDATE subscription SET error_since_ms = NULL WHERE id = ?`, id)
	return err
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
