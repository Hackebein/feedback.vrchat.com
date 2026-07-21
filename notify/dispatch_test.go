package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestSnapshotBaselineCollapsed(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name                string
		complete            bool
		prevCount, hitCount int
		want                bool
	}{
		{name: "incomplete ignored", complete: false, prevCount: 34000, hitCount: 0, want: false},
		{name: "small baseline ignored", complete: true, prevCount: snapshotMinBaseline - 1, hitCount: 0, want: false},
		{name: "empty vs established", complete: true, prevCount: snapshotMinBaseline, hitCount: 0, want: true},
		{name: "empty large corpus", complete: true, prevCount: 34000, hitCount: 0, want: true},
		{name: "vanish over cap", complete: true, prevCount: 34000, hitCount: 34000 - snapshotMaxVanish - 1, want: true},
		{name: "vanish at cap ok", complete: true, prevCount: 34000, hitCount: 34000 - snapshotMaxVanish, want: false},
		{name: "one deleted ok", complete: true, prevCount: 34000, hitCount: 33999, want: false},
		{name: "full corpus ok", complete: true, prevCount: 100, hitCount: 100, want: false},
		{name: "small vanish under cap ok", complete: true, prevCount: 100, hitCount: 90, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := snapshotBaselineCollapsed(tc.complete, tc.prevCount, tc.hitCount)
			if got != tc.want {
				t.Fatalf("snapshotBaselineCollapsed(%v, %d, %d) = %v, want %v",
					tc.complete, tc.prevCount, tc.hitCount, got, tc.want)
			}
		})
	}
}

func TestProcessSnapshotCollapseGuard(t *testing.T) {
	const baselineN = snapshotMaxVanish + 50

	cases := []struct {
		name       string
		hitCount   int
		wantErr    bool
		wantStateN int
		missingID  string // if set and !wantErr, this id should be deleted
	}{
		{
			name:       "empty complete aborts",
			hitCount:   0,
			wantErr:    true,
			wantStateN: baselineN,
		},
		{
			name:       "vanish over cap aborts",
			hitCount:   baselineN - snapshotMaxVanish - 1,
			wantErr:    true,
			wantStateN: baselineN,
		},
		{
			name:       "one delete reconciles",
			hitCount:   baselineN - 1,
			wantErr:    false,
			wantStateN: baselineN - 1,
			missingID:  "post-0",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := openTestStore(t)
			// Build the full hit list once; serve InstantSearch pages from it.
			startID := 0
			if tc.missingID == "post-0" {
				startID = 1
			}
			allHits := make([]json.RawMessage, 0, tc.hitCount)
			for i := startID; i < startID+tc.hitCount; i++ {
				allHits = append(allHits, mustHitJSON(t, fmt.Sprintf("post-%d", i)))
			}
			gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req []struct {
					Params struct {
						Page        int `json:"page"`
						HitsPerPage int `json:"hitsPerPage"`
					} `json:"params"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req) == 0 {
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				page, size := req[0].Params.Page, req[0].Params.HitsPerPage
				if size <= 0 {
					size = 1000
				}
				lo := page * size
				if lo > len(allHits) {
					lo = len(allHits)
				}
				hi := lo + size
				if hi > len(allHits) {
					hi = len(allHits)
				}
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"results": []map[string]interface{}{
						{"hits": allHits[lo:hi]},
					},
				})
			}))
			t.Cleanup(gw.Close)

			hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.wantErr {
					t.Fatalf("webhook must not be called on collapse abort")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(hook.Close)

			id, _, err := store.UpsertWebhookSubscription(Subscription{
				Events:     []string{EventDeleted},
				Target:     "webhook",
				WebhookURL: hook.URL,
				FilterJSON: `{"query":""}`,
				Label:      "test",
			}, 1_000_000)
			if err != nil {
				t.Fatalf("UpsertWebhookSubscription: %v", err)
			}
			if err := store.MarkSeeded(id, 1_000_000); err != nil {
				t.Fatalf("MarkSeeded: %v", err)
			}
			for i := 0; i < baselineN; i++ {
				pid := fmt.Sprintf("post-%d", i)
				if err := store.UpsertPostState(id, PostState{
					PostID: pid, Title: pid, URL: "https://example.com/" + pid,
					Board: "Board", Score: 1, Status: "open", CreatedMS: int64(i),
				}); err != nil {
					t.Fatalf("UpsertPostState: %v", err)
				}
			}

			d := newDispatcher(Config{
				GatewayURL: gw.URL,
				IndexName:  "feedback-posts",
			}, store)
			subs, err := store.ListAll()
			if err != nil {
				t.Fatalf("ListAll: %v", err)
			}
			var sub Subscription
			for _, s := range subs {
				if s.ID == id {
					sub = s
					break
				}
			}
			if sub.ID == 0 {
				t.Fatal("subscription not found")
			}

			err = d.processSnapshot(context.Background(), sub, 1)
			if tc.wantErr {
				if err == nil {
					t.Fatal("processSnapshot error = nil, want collapse error")
				}
			} else if err != nil {
				t.Fatalf("processSnapshot: %v", err)
			}

			state, err := store.ListPostState(id)
			if err != nil {
				t.Fatalf("ListPostState: %v", err)
			}
			if len(state) != tc.wantStateN {
				t.Fatalf("post_state len = %d, want %d", len(state), tc.wantStateN)
			}
			if tc.missingID != "" {
				if _, ok := state[tc.missingID]; ok {
					t.Fatalf("post_state still has %s after reconcile", tc.missingID)
				}
			}
		})
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notify.db")
	store, err := openStore(path)
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func mustHitJSON(t *testing.T, postID string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]interface{}{
		"post_id":      postID,
		"_id":          postID,
		"title":        postID,
		"urlName":      postID,
		"created":      "2020-01-01T00:00:00.000Z",
		"status":       "open",
		"score":        1,
		"commentCount": 0,
		"board":        map[string]string{"name": "Board", "urlName": "board"},
		"voters":       []interface{}{},
	})
	if err != nil {
		t.Fatalf("marshal hit: %v", err)
	}
	return raw
}
