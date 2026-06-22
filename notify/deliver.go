package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// NotificationEvent is the normalized payload sent to browsers and webhooks.
type NotificationEvent struct {
	Type    string `json:"type"` // "post" | "comment"
	Title   string `json:"title"`
	Body    string `json:"body"`
	URL     string `json:"url"`
	Board   string `json:"board"`
	Author  string `json:"author"`
	Excerpt string `json:"excerpt"`
	Created string `json:"created"`
}

// maxEventsPerTick caps how many notifications a single subscription emits per
// poll so a burst of matches cannot flood a browser or webhook.
const maxEventsPerTick = 10

func (d *Dispatcher) deliver(ctx context.Context, sub Subscription, events []NotificationEvent) {
	if len(events) > maxEventsPerTick {
		events = events[len(events)-maxEventsPerTick:]
	}
	switch sub.Target {
	case "push":
		d.deliverPush(sub, events)
	case "webhook":
		d.deliverWebhook(ctx, sub, events)
	}
}

func (d *Dispatcher) deliverPush(sub Subscription, events []NotificationEvent) {
	pushSub := &webpush.Subscription{
		Endpoint: sub.Push.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.Push.P256dh,
			Auth:   sub.Push.Auth,
		},
	}
	for _, ev := range events {
		payload, err := json.Marshal(ev)
		if err != nil {
			continue
		}
		resp, err := webpush.SendNotification(payload, pushSub, &webpush.Options{
			Subscriber:      d.cfg.VAPIDSubject,
			VAPIDPublicKey:  d.cfg.VAPIDPublicKey,
			VAPIDPrivateKey: d.cfg.VAPIDPrivateKey,
			TTL:             86400,
		})
		if err != nil {
			log.Printf("[notify] push send sub=%d: %v", sub.ID, err)
			return
		}
		status := resp.StatusCode
		resp.Body.Close()
		if status == http.StatusNotFound || status == http.StatusGone {
			// Browser unsubscribed / endpoint expired: drop it and cascade.
			if err := d.store.DeletePushSubscriptionByEndpoint(sub.Push.Endpoint); err != nil {
				log.Printf("[notify] delete gone push endpoint: %v", err)
			}
			return
		}
	}
}

type discordWebhookPayload struct {
	Embeds []discordEmbed `json:"embeds"`
}

type discordEmbed struct {
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	URL         string         `json:"url,omitempty"`
	Color       int            `json:"color,omitempty"`
	Fields      []discordField `json:"fields,omitempty"`
	Timestamp   string         `json:"timestamp,omitempty"`
}

type discordField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline,omitempty"`
}

const (
	discordEmbedTitleMax       = 256
	discordEmbedDescriptionMax = 4096
	discordEmbedFieldValueMax  = 1024
	discordColorPost           = 0x57F287
	discordColorComment        = 0xFEE75C
)

func buildDiscordWebhookPayload(events []NotificationEvent) ([]byte, error) {
	embeds := make([]discordEmbed, 0, len(events))
	for _, ev := range events {
		color := discordColorPost
		if ev.Type == "comment" {
			color = discordColorComment
		}
		desc := ev.Body
		if desc == "" {
			desc = ev.Excerpt
		}
		// Discord rejects an embed field whose value is empty (HTTP 400), so
		// only emit Board/Author when they actually carry a value.
		fields := make([]discordField, 0, 2)
		if board := truncate(ev.Board, discordEmbedFieldValueMax); board != "" {
			fields = append(fields, discordField{Name: "Board", Value: board, Inline: true})
		}
		if author := truncate(ev.Author, discordEmbedFieldValueMax); author != "" {
			fields = append(fields, discordField{Name: "Author", Value: author, Inline: true})
		}
		embeds = append(embeds, discordEmbed{
			Title:       truncate(ev.Title, discordEmbedTitleMax),
			Description: truncate(desc, discordEmbedDescriptionMax),
			URL:         ev.URL,
			Color:       color,
			Fields:      fields,
			Timestamp:   ev.Created,
		})
	}
	return json.Marshal(discordWebhookPayload{Embeds: embeds})
}

func (d *Dispatcher) deliverWebhook(ctx context.Context, sub Subscription, events []NotificationEvent) {
	body, err := buildDiscordWebhookPayload(events)
	if err != nil {
		log.Printf("[notify] webhook sub=%d build payload: %v", sub.ID, err)
		d.recordWebhookFailure(sub)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.WebhookURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("[notify] webhook sub=%d build request: %v", sub.ID, err)
		d.recordWebhookFailure(sub)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "feedback-notify/1.0")

	resp, err := d.client.Do(req)
	if err != nil {
		log.Printf("[notify] webhook sub=%d transport error: %v", sub.ID, err)
		d.recordWebhookFailure(sub)
		return
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("[notify] webhook sub=%d status=%d events=%d delivered", sub.ID, resp.StatusCode, len(events))
		if sub.ErrorSinceMS.Valid {
			if err := d.store.ClearWebhookError(sub.ID); err != nil {
				log.Printf("[notify] clear webhook error sub=%d: %v", sub.ID, err)
			}
		}
		return
	}
	log.Printf("[notify] webhook sub=%d status=%d events=%d rejected: %s", sub.ID, resp.StatusCode, len(events), truncate(string(respBody), 300))
	d.recordWebhookFailure(sub)
}

// recordWebhookFailure starts (or continues) the error streak for a webhook and
// deletes it once it has been failing continuously for the configured TTL.
func (d *Dispatcher) recordWebhookFailure(sub Subscription) {
	nowMS := time.Now().UnixMilli()
	if !sub.ErrorSinceMS.Valid {
		if err := d.store.SetWebhookError(sub.ID, nowMS); err != nil {
			log.Printf("[notify] set webhook error sub=%d: %v", sub.ID, err)
		}
		return
	}
	if nowMS-sub.ErrorSinceMS.Int64 >= d.cfg.WebhookErrorTTL.Milliseconds() {
		log.Printf("[notify] webhook sub=%d expired after %s of errors; deleting", sub.ID, d.cfg.WebhookErrorTTL)
		if err := d.store.DeleteSubscription(sub.ID); err != nil {
			log.Printf("[notify] delete expired webhook sub=%d: %v", sub.ID, err)
		}
	}
}
