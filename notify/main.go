package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "genvapid" {
		if err := generateVAPID(); err != nil {
			log.Fatalf("[notify] genvapid: %v", err)
		}
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("[notify] config: %v", err)
	}

	store, err := openStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("[notify] open store (%s): %v", cfg.DBPath, err)
	}
	defer store.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	dispatcher := newDispatcher(cfg, store)
	go dispatcher.Run(ctx)

	srv := newServer(cfg, store, dispatcher)
	addr := net.JoinHostPort(cfg.Bind, strconv.Itoa(cfg.Port))
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("[notify] listening addr=%s gateway=%s db=%s poll=%s", addr, cfg.GatewayURL, cfg.DBPath, cfg.PollInterval)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(fmt.Errorf("[notify] server: %w", err))
	}
}

// generateVAPID prints a fresh VAPID keypair as shell-style env assignments so
// bootstrap scripts can capture it into notify.env.
func generateVAPID() error {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return err
	}
	fmt.Printf("VAPID_PUBLIC_KEY=%s\n", pub)
	fmt.Printf("VAPID_PRIVATE_KEY=%s\n", priv)
	return nil
}
