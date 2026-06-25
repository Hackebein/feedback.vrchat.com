package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"

	_ "modernc.org/sqlite"
)

// Store wraps the SQLite database that persists push subscriptions, the filter
// subscriptions (browser push or webhook) attached to them, and the per-post
// state snapshots used to detect vote/status/deletion changes.
type Store struct {
	db *sql.DB
}

// Event types a subscription can be interested in.
const (
	EventPost    = "post"
	EventComment = "comment"
	EventVotes   = "votes"
	EventStatus  = "status"
	EventDeleted = "deleted"
)

func validEvent(e string) bool {
	switch e {
	case EventPost, EventComment, EventVotes, EventStatus, EventDeleted:
		return true
	}
	return false
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
  events               TEXT NOT NULL DEFAULT '[]',
  target               TEXT NOT NULL,
  push_subscription_id INTEGER REFERENCES push_subscription(id) ON DELETE CASCADE,
  webhook_url          TEXT,
  lucene               INTEGER NOT NULL DEFAULT 0,
  filter_json          TEXT NOT NULL,
  label                TEXT NOT NULL DEFAULT '',
  watermark_ms         INTEGER NOT NULL,
  watermark_comment_ms INTEGER NOT NULL DEFAULT 0,
  error_since_ms       INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_push ON subscription(push_subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_webhook ON subscription(webhook_url) WHERE target = 'webhook';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_push_filter ON subscription(push_subscription_id, filter_json) WHERE target = 'push';

CREATE TABLE IF NOT EXISTS post_state (
  subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  post_id         TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL DEFAULT '',
  board           TEXT NOT NULL DEFAULT '',
  score           INTEGER NOT NULL,
  status          TEXT NOT NULL,
  comment_count   INTEGER NOT NULL,
  voters_json     TEXT NOT NULL DEFAULT '{}',
  created_ms      INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, post_id)
);
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
	Events             []string // any of: post, comment, votes, status, deleted
	Target             string   // "push" | "webhook"
	PushSubscriptionID sql.NullInt64
	WebhookURL         string
	Lucene             bool
	FilterJSON         string
	Label              string
	WatermarkMS        int64 // watermark for new posts (post.created)
	CommentWatermarkMS int64 // watermark for new comments (comment.created)
	ErrorSinceMS       sql.NullInt64
	CreatedAtMS        int64
	Push               PushKeys
}

// HasEvent reports whether the subscription is interested in the event type.
func (s Subscription) HasEvent(e string) bool {
	for _, ev := range s.Events {
		if ev == e {
			return true
		}
	}
	return false
}

// PostState is the snapshot of a post the dispatcher diffs against to detect
// vote/status/deletion changes between polls.
type PostState struct {
	PostID       string
	Title        string
	URL          string
	Board        string
	Score        int
	Status       string
	CommentCount int
	VotersJSON   string // JSON array of [voterID, displayName] pairs, sorted by id
	CreatedMS    int64
}

// SubscriptionView is the trimmed shape returned to the browser for listing.
// Filter/Lucene are included so the UI can re-upsert a saved filter's event set.
type SubscriptionView struct {
	ID        int64           `json:"id"`
	Events    []string        `json:"events"`
	Label     string          `json:"label"`
	Filter    json.RawMessage `json:"filter"`
	Lucene    bool            `json:"lucene"`
	CreatedAt int64           `json:"createdAt"`
}

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return s, nil
}

// migrate rebuilds a legacy `subscription` table (single `kind` column) into the
// current events-set schema. Fresh installs skip this and openStore's schema
// CREATE handles everything.
func (s *Store) migrate() error {
	hasKind, hasEvents, err := s.subscriptionColumns()
	if err != nil {
		return err
	}
	if !hasKind || hasEvents {
		return nil // fresh install or already migrated
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`
CREATE TABLE subscription_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  events               TEXT NOT NULL DEFAULT '[]',
  target               TEXT NOT NULL,
  push_subscription_id INTEGER REFERENCES push_subscription(id) ON DELETE CASCADE,
  webhook_url          TEXT,
  lucene               INTEGER NOT NULL DEFAULT 0,
  filter_json          TEXT NOT NULL,
  label                TEXT NOT NULL DEFAULT '',
  watermark_ms         INTEGER NOT NULL,
  watermark_comment_ms INTEGER NOT NULL DEFAULT 0,
  error_since_ms       INTEGER,
  created_at           INTEGER NOT NULL
);`); err != nil {
		return fmt.Errorf("migrate create: %w", err)
	}

	// json_array(kind) turns the old single kind into a one-element events set.
	if _, err := tx.Exec(`
INSERT INTO subscription_new
  (id, events, target, push_subscription_id, webhook_url, lucene, filter_json,
   label, watermark_ms, watermark_comment_ms, error_since_ms, created_at)
SELECT id, json_array(kind), target, push_subscription_id, webhook_url, lucene,
       filter_json, label, watermark_ms, watermark_ms, error_since_ms, created_at
  FROM subscription;`); err != nil {
		return fmt.Errorf("migrate copy: %w", err)
	}

	if _, err := tx.Exec(`DROP TABLE subscription;`); err != nil {
		return fmt.Errorf("migrate drop: %w", err)
	}
	if _, err := tx.Exec(`ALTER TABLE subscription_new RENAME TO subscription;`); err != nil {
		return fmt.Errorf("migrate rename: %w", err)
	}
	return tx.Commit()
}

func (s *Store) subscriptionColumns() (hasKind, hasEvents bool, err error) {
	rows, err := s.db.Query(`PRAGMA table_info(subscription)`)
	if err != nil {
		return false, false, err
	}
	defer rows.Close()
	any := false
	for rows.Next() {
		any = true
		var (
			cid     int
			name    string
			ctype   string
			notnull int
			dflt    sql.NullString
			pk      int
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, false, err
		}
		switch name {
		case "kind":
			hasKind = true
		case "events":
			hasEvents = true
		}
	}
	if !any {
		// Table does not exist yet: treat as fresh (no migration needed).
		return false, false, rows.Err()
	}
	return hasKind, hasEvents, rows.Err()
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

// UpsertPushFilterSubscription creates or overwrites the push subscription for a
// browser endpoint + filter pair. Re-toggling the same filter overwrites its
// event set. Returns the subscription id and whether the row was newly created.
func (s *Store) UpsertPushFilterSubscription(sub Subscription, nowMS int64) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(
		`SELECT id FROM subscription
		  WHERE target = 'push' AND push_subscription_id = ? AND filter_json = ?`,
		sub.PushSubscriptionID, sub.FilterJSON,
	).Scan(&id)
	if err == nil {
		_, uerr := s.db.Exec(
			`UPDATE subscription SET events = ?, lucene = ?, label = ? WHERE id = ?`,
			marshalEvents(sub.Events), boolToInt(sub.Lucene), sub.Label, id,
		)
		return id, false, uerr
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}
	res, err := s.db.Exec(
		`INSERT INTO subscription
		   (events, target, push_subscription_id, webhook_url, lucene, filter_json, label, watermark_ms, watermark_comment_ms, created_at)
		 VALUES (?, 'push', ?, NULL, ?, ?, ?, ?, ?, ?)`,
		marshalEvents(sub.Events), sub.PushSubscriptionID, boolToInt(sub.Lucene),
		sub.FilterJSON, sub.Label, nowMS, nowMS, nowMS,
	)
	if err != nil {
		return 0, false, err
	}
	newID, err := res.LastInsertId()
	return newID, true, err
}

// UpsertWebhookSubscription creates or overwrites the subscription for a webhook
// URL. A known webhook URL overwrites its previously committed settings (filter,
// events, lucene, label). Returns the subscription id and whether it was new.
func (s *Store) UpsertWebhookSubscription(sub Subscription, nowMS int64) (int64, bool, error) {
	var id int64
	err := s.db.QueryRow(
		`SELECT id FROM subscription WHERE target = 'webhook' AND webhook_url = ?`,
		sub.WebhookURL,
	).Scan(&id)
	if err == nil {
		// Overwrite committed settings and reset the watermark/error streak so the
		// reconfigured webhook behaves like a fresh subscription.
		_, uerr := s.db.Exec(
			`UPDATE subscription
			    SET events = ?, lucene = ?, filter_json = ?, label = ?,
			        watermark_ms = ?, watermark_comment_ms = ?, error_since_ms = NULL
			  WHERE id = ?`,
			marshalEvents(sub.Events), boolToInt(sub.Lucene), sub.FilterJSON, sub.Label,
			nowMS, nowMS, id,
		)
		if uerr != nil {
			return 0, false, uerr
		}
		// Drop stale snapshots so the reconfigured filter re-seeds cleanly.
		if _, derr := s.db.Exec(`DELETE FROM post_state WHERE subscription_id = ?`, id); derr != nil {
			return 0, false, derr
		}
		return id, false, nil
	}
	if err != sql.ErrNoRows {
		return 0, false, err
	}
	res, err := s.db.Exec(
		`INSERT INTO subscription
		   (events, target, push_subscription_id, webhook_url, lucene, filter_json, label, watermark_ms, watermark_comment_ms, created_at)
		 VALUES (?, 'webhook', NULL, ?, ?, ?, ?, ?, ?, ?)`,
		marshalEvents(sub.Events), sub.WebhookURL, boolToInt(sub.Lucene),
		sub.FilterJSON, sub.Label, nowMS, nowMS, nowMS,
	)
	if err != nil {
		return 0, false, err
	}
	newID, err := res.LastInsertId()
	return newID, true, err
}

// ListByEndpoint returns the push subscriptions belonging to a single browser,
// for the management dropdown.
func (s *Store) ListByEndpoint(endpoint string) ([]SubscriptionView, error) {
	rows, err := s.db.Query(
		`SELECT sub.id, sub.events, sub.label, sub.filter_json, sub.lucene, sub.created_at
		   FROM subscription sub
		   JOIN push_subscription ps ON ps.id = sub.push_subscription_id
		  WHERE ps.endpoint = ? AND sub.target = 'push'
		  ORDER BY sub.created_at DESC`,
		endpoint,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubscriptionView{}
	for rows.Next() {
		var v SubscriptionView
		var events, filterJSON string
		var lucene int
		if err := rows.Scan(&v.ID, &events, &v.Label, &filterJSON, &lucene, &v.CreatedAt); err != nil {
			return nil, err
		}
		v.Events = parseEvents(events)
		v.Filter = json.RawMessage(filterJSON)
		v.Lucene = lucene != 0
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

// deletePushFilter removes the push subscription for an endpoint + filter pair
// (used when the UI toggles every event off). Returns whether a row was deleted.
func (s *Store) deletePushFilter(pushID sql.NullInt64, filterJSON string) (bool, error) {
	res, err := s.db.Exec(
		`DELETE FROM subscription
		  WHERE target = 'push' AND push_subscription_id = ? AND filter_json = ?`,
		pushID, filterJSON,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// deleteWebhook removes the subscription for a webhook URL. Returns whether a
// row was deleted.
func (s *Store) deleteWebhook(url string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM subscription WHERE target = 'webhook' AND webhook_url = ?`, url)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ListAll returns every subscription joined with push keys, for dispatching.
func (s *Store) ListAll() ([]Subscription, error) {
	rows, err := s.db.Query(
		`SELECT sub.id, sub.events, sub.target, sub.push_subscription_id, COALESCE(sub.webhook_url, ''),
		        sub.lucene, sub.filter_json, sub.label, sub.watermark_ms, sub.watermark_comment_ms,
		        sub.error_since_ms, sub.created_at,
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
		var events string
		if err := rows.Scan(
			&sub.ID, &events, &sub.Target, &sub.PushSubscriptionID, &sub.WebhookURL,
			&lucene, &sub.FilterJSON, &sub.Label, &sub.WatermarkMS, &sub.CommentWatermarkMS,
			&sub.ErrorSinceMS, &sub.CreatedAtMS,
			&sub.Push.Endpoint, &sub.Push.P256dh, &sub.Push.Auth,
		); err != nil {
			return nil, err
		}
		sub.Lucene = lucene != 0
		sub.Events = parseEvents(events)
		out = append(out, sub)
	}
	return out, rows.Err()
}

// UpdateWatermark advances the new-post watermark.
func (s *Store) UpdateWatermark(id, watermarkMS int64) error {
	_, err := s.db.Exec(`UPDATE subscription SET watermark_ms = ? WHERE id = ?`, watermarkMS, id)
	return err
}

// UpdateCommentWatermark advances the new-comment watermark.
func (s *Store) UpdateCommentWatermark(id, watermarkMS int64) error {
	_, err := s.db.Exec(`UPDATE subscription SET watermark_comment_ms = ? WHERE id = ?`, watermarkMS, id)
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

// ListPostState loads every snapshot row for a subscription, keyed by post id.
func (s *Store) ListPostState(subID int64) (map[string]PostState, error) {
	rows, err := s.db.Query(
		`SELECT post_id, title, url, board, score, status, comment_count, voters_json, created_ms
		   FROM post_state WHERE subscription_id = ?`,
		subID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]PostState{}
	for rows.Next() {
		var ps PostState
		if err := rows.Scan(&ps.PostID, &ps.Title, &ps.URL, &ps.Board, &ps.Score, &ps.Status, &ps.CommentCount, &ps.VotersJSON, &ps.CreatedMS); err != nil {
			return nil, err
		}
		out[ps.PostID] = ps
	}
	return out, rows.Err()
}

// UpsertPostState writes (or refreshes) a single snapshot row.
func (s *Store) UpsertPostState(subID int64, ps PostState) error {
	_, err := s.db.Exec(
		`INSERT INTO post_state
		   (subscription_id, post_id, title, url, board, score, status, comment_count, voters_json, created_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(subscription_id, post_id) DO UPDATE SET
		   title = excluded.title,
		   url = excluded.url,
		   board = excluded.board,
		   score = excluded.score,
		   status = excluded.status,
		   comment_count = excluded.comment_count,
		   voters_json = excluded.voters_json,
		   created_ms = excluded.created_ms`,
		subID, ps.PostID, ps.Title, ps.URL, ps.Board, ps.Score, ps.Status, ps.CommentCount, ps.VotersJSON, ps.CreatedMS,
	)
	return err
}

// DeletePostState removes a single snapshot row.
func (s *Store) DeletePostState(subID int64, postID string) error {
	_, err := s.db.Exec(`DELETE FROM post_state WHERE subscription_id = ? AND post_id = ?`, subID, postID)
	return err
}

func marshalEvents(events []string) string {
	if events == nil {
		events = []string{}
	}
	b, err := json.Marshal(events)
	if err != nil {
		return "[]"
	}
	return string(b)
}

func parseEvents(s string) []string {
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return []string{}
	}
	filtered := out[:0]
	for _, e := range out {
		if validEvent(e) {
			filtered = append(filtered, e)
		}
	}
	return filtered
}

// votersFingerprint serializes a voter id->name map deterministically so two
// snapshots can be compared and the JSON form is stable across polls.
func votersFingerprint(voters map[string]string) string {
	if len(voters) == 0 {
		return "{}"
	}
	keys := make([]string, 0, len(voters))
	for k := range voters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make([][2]string, 0, len(keys))
	for _, k := range keys {
		ordered = append(ordered, [2]string{k, voters[k]})
	}
	b, err := json.Marshal(ordered)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func decodeVoters(s string) map[string]string {
	out := map[string]string{}
	if s == "" || s == "{}" {
		return out
	}
	var ordered [][2]string
	if err := json.Unmarshal([]byte(s), &ordered); err == nil {
		for _, pair := range ordered {
			out[pair[0]] = pair[1]
		}
		return out
	}
	// Tolerate a plain object form too.
	_ = json.Unmarshal([]byte(s), &out)
	return out
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
