package main

import (
	"encoding/json"
	"testing"
)

func TestBuildDiscordWebhookPayload(t *testing.T) {
	body, err := buildDiscordWebhookPayload([]NotificationEvent{
		{
			Type:    "post",
			Title:   "New post in Feature Requests",
			Body:    "Add dark mode",
			URL:     "https://feedback.vrchat.com/feature-requests/p/dark-mode",
			Board:   "Feature Requests",
			Author:  "alice",
			Created: "2026-06-22T12:00:00Z",
		},
		{
			Type:    "comment",
			Title:   "New comment on \"Add dark mode\"",
			Body:    "+1 please",
			URL:     "https://feedback.vrchat.com/feature-requests/p/dark-mode",
			Board:   "Feature Requests",
			Author:  "bob",
			Created: "2026-06-22T12:05:00Z",
		},
	})
	if err != nil {
		t.Fatalf("buildDiscordWebhookPayload: %v", err)
	}

	var parsed discordWebhookPayload
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(parsed.Embeds) != 2 {
		t.Fatalf("embeds len = %d, want 2", len(parsed.Embeds))
	}
	if parsed.Embeds[0].Color != discordColorPost {
		t.Fatalf("post color = %d, want %d", parsed.Embeds[0].Color, discordColorPost)
	}
	if parsed.Embeds[1].Color != discordColorComment {
		t.Fatalf("comment color = %d, want %d", parsed.Embeds[1].Color, discordColorComment)
	}
	if parsed.Embeds[0].URL != "https://feedback.vrchat.com/feature-requests/p/dark-mode" {
		t.Fatalf("unexpected post url: %q", parsed.Embeds[0].URL)
	}
}

func TestBuildDiscordWebhookPayloadOmitsEmptyFields(t *testing.T) {
	body, err := buildDiscordWebhookPayload([]NotificationEvent{
		{
			Type:  "post",
			Title: "New post",
			Body:  "Anonymous content",
			URL:   "https://feedback.vrchat.com/feature-requests/p/anon",
			// Board and Author intentionally empty.
		},
	})
	if err != nil {
		t.Fatalf("buildDiscordWebhookPayload: %v", err)
	}

	var parsed discordWebhookPayload
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(parsed.Embeds) != 1 {
		t.Fatalf("embeds len = %d, want 1", len(parsed.Embeds))
	}
	for _, f := range parsed.Embeds[0].Fields {
		if f.Value == "" {
			t.Fatalf("embed field %q has empty value; Discord rejects these", f.Name)
		}
	}
	if len(parsed.Embeds[0].Fields) != 0 {
		t.Fatalf("fields len = %d, want 0 when board/author empty", len(parsed.Embeds[0].Fields))
	}
}
