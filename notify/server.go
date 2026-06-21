package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Server exposes the notification management API consumed by the frontend.
type Server struct {
	cfg   Config
	store *Store
}

func newServer(cfg Config, store *Store) *Server {
	return &Server{cfg: cfg, store: store}
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
	Kind             string                  `json:"kind"`
	PushSubscription pushSubscriptionPayload `json:"pushSubscription"`
	Filter           map[string]interface{}  `json:"filter"`
	Lucene           bool                    `json:"lucene"`
	Label            string                  `json:"label"`
}

type createWebhookRequest struct {
	Kind       string                 `json:"kind"`
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

func (s *Server) handleCreateSubscription(w http.ResponseWriter, r *http.Request) {
	var req createSubscriptionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Kind != "post" && req.Kind != "comment" {
		writeError(w, http.StatusBadRequest, "kind must be 'post' or 'comment'")
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

	id, err := s.store.CreateSubscription(Subscription{
		Kind:               req.Kind,
		Target:             "push",
		PushSubscriptionID: sql.NullInt64{Int64: pushID, Valid: true},
		Lucene:             req.Lucene,
		FilterJSON:         filterJSON,
		Label:              strings.TrimSpace(req.Label),
		WatermarkMS:        nowMS,
	}, nowMS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create subscription")
		return
	}
	writeJSON(w, http.StatusCreated, SubscriptionView{
		ID:        id,
		Kind:      req.Kind,
		Label:     strings.TrimSpace(req.Label),
		CreatedAt: nowMS,
	})
}

func (s *Server) handleListSubscriptions(w http.ResponseWriter, r *http.Request) {
	endpoint := r.URL.Query().Get("endpoint")
	if endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint query param is required")
		return
	}
	kind := r.URL.Query().Get("kind")
	if kind != "" && kind != "post" && kind != "comment" {
		writeError(w, http.StatusBadRequest, "kind must be 'post' or 'comment'")
		return
	}
	views, err := s.store.ListByEndpoint(endpoint, kind)
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
	if req.Kind != "post" && req.Kind != "comment" {
		writeError(w, http.StatusBadRequest, "kind must be 'post' or 'comment'")
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

	nowMS := time.Now().UnixMilli()
	id, err := s.store.CreateSubscription(Subscription{
		Kind:        req.Kind,
		Target:      "webhook",
		WebhookURL:  url,
		Lucene:      req.Lucene,
		FilterJSON:  filterJSON,
		Label:       strings.TrimSpace(req.Label),
		WatermarkMS: nowMS,
	}, nowMS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create webhook")
		return
	}
	writeJSON(w, http.StatusCreated, SubscriptionView{
		ID:        id,
		Kind:      req.Kind,
		Label:     strings.TrimSpace(req.Label),
		CreatedAt: nowMS,
	})
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
