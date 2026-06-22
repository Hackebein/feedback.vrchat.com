package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Bind            string
	Port            int
	GatewayURL      string
	IndexName       string
	VAPIDPublicKey  string
	VAPIDPrivateKey string
	VAPIDSubject    string
	DBPath          string
	PollInterval    time.Duration
	WebhookErrorTTL time.Duration
}

func envStr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func loadConfig() (Config, error) {
	cfg := Config{
		Bind:            envStr("NOTIFY_BIND", "127.0.0.1"),
		GatewayURL:      strings.TrimRight(envStr("GATEWAY_URL", "http://127.0.0.1:3333"), "/"),
		IndexName:       envStr("INDEX_NAME", "feedback-posts"),
		VAPIDPublicKey:  envStr("VAPID_PUBLIC_KEY", ""),
		VAPIDPrivateKey: envStr("VAPID_PRIVATE_KEY", ""),
		VAPIDSubject:    envStr("VAPID_SUBJECT", "mailto:admin@hackebein.dev"),
		PollInterval:    60 * time.Second,
		WebhookErrorTTL: 3 * 24 * time.Hour,
	}

	port, err := strconv.Atoi(envStr("NOTIFY_PORT", "3334"))
	if err != nil || port < 1 {
		return Config{}, fmt.Errorf("NOTIFY_PORT must be a positive integer")
	}
	cfg.Port = port

	// systemd StateDirectory= exports STATE_DIRECTORY; allow explicit override.
	dbPath := strings.TrimSpace(os.Getenv("NOTIFY_DB_PATH"))
	if dbPath == "" {
		stateDir := envStr("STATE_DIRECTORY", "")
		if stateDir == "" {
			stateDir = "."
		}
		// STATE_DIRECTORY may be a colon-separated list; take the first entry.
		stateDir = strings.Split(stateDir, ":")[0]
		dbPath = filepath.Join(stateDir, "notify.db")
	}
	cfg.DBPath = dbPath

	if secs := strings.TrimSpace(os.Getenv("NOTIFY_POLL_SECONDS")); secs != "" {
		if n, err := strconv.Atoi(secs); err == nil && n > 0 {
			cfg.PollInterval = time.Duration(n) * time.Second
		}
	}

	if cfg.VAPIDPublicKey == "" || cfg.VAPIDPrivateKey == "" {
		return Config{}, fmt.Errorf("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set")
	}

	return cfg, nil
}
