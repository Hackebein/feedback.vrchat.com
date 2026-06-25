package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Server exposes the notification management API consumed by the frontend.
type Server struct {
	cfg      Config
	store    *Store
	dispatch *Dispatcher
}

func newServer(cfg Config, store *Store, dispatch *Dispatcher) *Server {
	return &Server{cfg: cfg, store: store, dispatch: dispatch}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/notify/health", s.handleHealth)
	mux.HandleFunc("GET /api/notify/vapid-public-key", s.handleVapidKey)
	mux.HandleFunc("POST /api/notify/subscriptions", s.handleCreateSubscription)
	mux.HandleFunc("GET /api/notify/subscriptions", s.handleListSubscriptions)
	mux.HandleFunc("DELETE /api/notify/subscriptions/{id}", s.handleDeleteSubscription)
	mux.HandleFunc("POST /api/notify/webhooks", s.handleCreateWebhook)
	return mux
}

type pushSubscriptionPayload struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type createSubscriptionRequest struct {
	Events           []string                `json:"events"`
	PushSubscription pushSubscriptionPayload `json:"pushSubscription"`
	Filter           map[string]interface{}  `json:"filter"`
	Lucene           bool                    `json:"lucene"`
	Label            string                  `json:"label"`
}

type createWebhookRequest struct {
	Events     []string               `json:"events"`
	WebhookURL string                 `json:"webhookUrl"`
	Filter     map[string]interface{} `json:"filter"`
	Lucene     bool                   `json:"lucene"`
	Label      string                 `json:"label"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleVapidKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"key": s.cfg.VAPIDPublicKey})
}

// addedEvents returns the events present in next but not in prev (the ones just
// toggled on), so we only send a test message for newly-enabled actions.
func addedEvents(next, prev []string) []string {
	prevSet := make(map[string]bool, len(prev))
	for _, e := range prev {
		prevSet[e] = true
	}
	var added []string
	for _, e := range next {
		if !prevSet[e] {
			added = append(added, e)
		}
	}
	return added
}

// sanitizeEvents keeps only known event names, de-duplicated and order-stable.
func sanitizeEvents(events []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(events))
	for _, e := range events {
		e = strings.TrimSpace(e)
		if !validEvent(e) || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

func (s *Server) handleCreateSubscription(w http.ResponseWriter, r *http.Request) {
	var req createSubscriptionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.PushSubscription.Endpoint == "" || req.PushSubscription.Keys.P256dh == "" || req.PushSubscription.Keys.Auth == "" {
		writeError(w, http.StatusBadRequest, "pushSubscription with endpoint and keys is required")
		return
	}
	filterJSON, err := marshalFilter(req.Filter)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid filter")
		return
	}
	events := sanitizeEvents(req.Events)

	nowMS := time.Now().UnixMilli()
	pushID, err := s.store.UpsertPushSubscription(PushKeys{
		Endpoint: req.PushSubscription.Endpoint,
		P256dh:   req.PushSubscription.Keys.P256dh,
		Auth:     req.PushSubscription.Keys.Auth,
	}, nowMS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "store push subscription")
		return
	}

	pushRef := sql.NullInt64{Int64: pushID, Valid: true}

	// An empty event set means "stop notifying for this filter": delete it.
	if len(events) == 0 {
		if _, derr := s.store.deletePushFilter(pushRef, filterJSON); derr != nil {
			writeError(w, http.StatusInternalServerError, "remove subscription")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	sub := Subscription{
		Events:             events,
		Target:             "push",
		PushSubscriptionID: pushRef,
		Lucene:             req.Lucene,
		FilterJSON:         filterJSON,
		Label:              strings.TrimSpace(req.Label),
	}
	id, prevEvents, err := s.store.UpsertPushFilterSubscription(sub, nowMS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create subscription")
		return
	}
	writeJSON(w, http.StatusCreated, SubscriptionView{
		ID:        id,
		Events:    events,
		Label:     strings.TrimSpace(req.Label),
		Filter:    json.RawMessage(filterJSON),
		Lucene:    req.Lucene,
		CreatedAt: nowMS,
	})

	// Best-effort: send a confirmation/test message for each newly-enabled event.
	if added := addedEvents(events, prevEvents); len(added) > 0 {
		go s.dispatch.SendTest(context.Background(), Subscription{
			ID:                 id,
			Events:             events,
			Target:             "push",
			PushSubscriptionID: pushRef,
			Lucene:             req.Lucene,
			FilterJSON:         filterJSON,
			WatermarkMS:        nowMS,
			CommentWatermarkMS: nowMS,
			Push: PushKeys{
				Endpoint: req.PushSubscription.Endpoint,
				P256dh:   req.PushSubscription.Keys.P256dh,
				Auth:     req.PushSubscription.Keys.Auth,
			},
		}, added)
	}
}

func (s *Server) handleListSubscriptions(w http.ResponseWriter, r *http.Request) {
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint query param is required")
		return
	}
	views, err := s.store.ListByEndpoint(endpoint)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list subscriptions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"subscriptions": views})
}

func (s *Server) handleDeleteSubscription(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return
	}
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint query param is required")
		return
	}
	ok, err := s.store.DeleteSubscriptionForEndpoint(id, endpoint)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "delete subscription")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "subscription not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	var req createWebhookRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	url := strings.TrimSpace(req.WebhookURL)
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
		writeError(w, http.StatusBadRequest, "webhookUrl must be an http(s) URL")
		return
	}
	filterJSON, err := marshalFilter(req.Filter)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid filter")
		return
	}
	events := sanitizeEvents(req.Events)

	nowMS := time.Now().UnixMilli()

	if len(events) == 0 {
		if _, derr := s.store.deleteWebhook(url); derr != nil {
			writeError(w, http.StatusInternalServerError, "remove webhook")
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	sub := Subscription{
		Events:     events,
		Target:     "webhook",
		WebhookURL: url,
		Lucene:     req.Lucene,
		FilterJSON: filterJSON,
		Label:      strings.TrimSpace(req.Label),
	}
	id, prevEvents, err := s.store.UpsertWebhookSubscription(sub, nowMS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create webhook")
		return
	}
	writeJSON(w, http.StatusCreated, SubscriptionView{
		ID:        id,
		Events:    events,
		Label:     strings.TrimSpace(req.Label),
		Filter:    json.RawMessage(filterJSON),
		Lucene:    req.Lucene,
		CreatedAt: nowMS,
	})

	// Best-effort: send a confirmation/test message for each newly-enabled event.
	if added := addedEvents(events, prevEvents); len(added) > 0 {
		go s.dispatch.SendTest(context.Background(), Subscription{
			ID:                 id,
			Events:             events,
			Target:             "webhook",
			WebhookURL:         url,
			Lucene:             req.Lucene,
			FilterJSON:         filterJSON,
			WatermarkMS:        nowMS,
			CommentWatermarkMS: nowMS,
		}, added)
	}
}

func decodeJSON(r *http.Request, dst interface{}) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 256*1024))
	return dec.Decode(dst)
}

func marshalFilter(filter map[string]interface{}) (string, error) {
	if filter == nil {
		filter = map[string]interface{}{}
	}
	b, err := json.Marshal(filter)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"message": msg})
}
