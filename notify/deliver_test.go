package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func fieldNames(e discordEmbed) []string {
	names := make([]string, 0, len(e.Fields))
	for _, f := range e.Fields {
		names = append(names, f.Name)
	}
	return names
}

func TestSubstituteMentions(t *testing.T) {
	hit := gwHit{
		Author: gwUser{ID: "0123456789abcdef01234567", Name: "Alice"},
		Comments: []gwComment{
			{MentionedUsers: []gwUser{{ID: "0123456789abcdef0123abcd", Name: "Bob"}}},
		},
	}
	names := buildUserNameMap(hit)
	got := substituteMentions(
		"hi @{0123456789abcdef01234567|full_name} and @{0123456789abcdef0123abcd|full_name}",
		names,
	)
	if want := "hi @Alice and @Bob"; got != want {
		t.Fatalf("substituteMentions = %q, want %q", got, want)
	}
	// Unknown ids are left untouched.
	const unknown = "@{ffffffffffffffffffffffff|full_name}"
	if got := substituteMentions(unknown, names); got != unknown {
		t.Fatalf("unknown mention = %q, want unchanged", got)
	}
}

func TestEventToEmbedFieldThresholds(t *testing.T) {
	ev := NotificationEvent{
		Type:         EventPost,
		PostTitle:    "Title",
		Author:       "alice",
		Board:        "Feature Requests",
		Category:     "Worlds",
		VoteCount:    2,
		CommentCount: 1,
	}
	got := fieldNames(eventToEmbed(ev))
	want := []string{"Author", "Board", "Category", "Votes", "Comments"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("fields = %v, want %v", got, want)
	}

	// Votes only shows for >1, Comments only for >0.
	ev.VoteCount = 1
	ev.CommentCount = 0
	got = fieldNames(eventToEmbed(ev))
	for _, n := range got {
		if n == "Votes" || n == "Comments" {
			t.Fatalf("unexpected field %q when vote=1/comments=0", n)
		}
	}
}

func TestEventToEmbedTypeFooter(t *testing.T) {
	cases := []struct {
		eventType string
		wantLabel string
	}{
		{EventPost, "Post"},
		{EventComment, "Comment"},
		{EventVotes, "Upvote"},
		{EventStatus, "Status change"},
		{EventDeleted, "Deleted"},
	}
	for _, tc := range cases {
		t.Run(tc.eventType, func(t *testing.T) {
			embed := eventToEmbed(NotificationEvent{Type: tc.eventType, Title: "Test"})
			if embed.Footer == nil {
				t.Fatal("footer is nil")
			}
			if embed.Footer.Text != tc.wantLabel {
				t.Fatalf("footer text = %q, want %q", embed.Footer.Text, tc.wantLabel)
			}
		})
	}
}

func TestEventToEmbedDropsBlankFieldsAndBadURL(t *testing.T) {
	ev := NotificationEvent{
		Type:      EventVotes,
		PostTitle: "  ", // whitespace title -> must fall back
		Title:     "",   // no fallback title either
		Body:      "Votes: 4 → 5",
		Author:    "   ", // whitespace-only -> dropped
		Board:     "Feature Requests",
		URL:       "not a url", // malformed -> dropped
	}
	embed := eventToEmbed(ev)
	if embed.Title == "" {
		t.Fatal("title must never be empty (Discord rejects empty title with url)")
	}
	if embed.URL != "" {
		t.Fatalf("malformed url should be dropped, got %q", embed.URL)
	}
	for _, f := range embed.Fields {
		if strings.TrimSpace(f.Value) == "" {
			t.Fatalf("field %q has blank value; Discord rejects these", f.Name)
		}
		if f.Name == "Author" {
			t.Fatal("whitespace-only Author should have been dropped")
		}
	}

	// A good url is preserved.
	ev.URL = "https://feedback.vrchat.com/feature-requests/p/x"
	if got := eventToEmbed(ev).URL; got != ev.URL {
		t.Fatalf("valid url dropped: %q", got)
	}
}

func TestClipMarksTruncation(t *testing.T) {
	long := strings.Repeat("x", 100)
	got := clip(long, 40)
	if runeLen(got) > 40 {
		t.Fatalf("clip exceeded max: len=%d", runeLen(got))
	}
	if !strings.HasSuffix(got, embedCutNote) {
		t.Fatalf("clip did not mark truncation: %q", got)
	}
	if clip(long, 100) != long {
		t.Fatal("clip altered string that fit within max")
	}
}

func TestEnforceMessageBudget(t *testing.T) {
	// Ten embeds each with a 4096-char description would be ~40k chars: far over
	// Discord's 6000 limit. After enforcement the whole message must fit.
	events := make([]NotificationEvent, 0, 12)
	for i := 0; i < 12; i++ {
		events = append(events, NotificationEvent{
			Type:      EventComment,
			PostTitle: fmt.Sprintf("Post %d", i),
			Body:      strings.Repeat("y", 4096),
			Board:     "Feature Requests",
			Author:    "alice",
			URL:       "https://feedback.vrchat.com/feature-requests/p/x",
		})
	}
	embeds := buildDiscordEmbeds(events)
	if len(embeds) > maxEmbedsPerMessage {
		t.Fatalf("embed count %d exceeds Discord max %d", len(embeds), maxEmbedsPerMessage)
	}
	total := 0
	for _, e := range embeds {
		total += embedFixedSize(e) + runeLen(e.Description)
	}
	if total > discordMessageCharBudget {
		t.Fatalf("message size %d exceeds Discord budget %d", total, discordMessageCharBudget)
	}
}

func TestBuildVotesEvent(t *testing.T) {
	hit := gwHit{
		Title:  "Dark mode",
		Score:  5,
		Voters: []gwUser{{ID: "a", Name: "Al"}, {ID: "b", Name: "Bo"}},
	}
	old := PostState{Score: 4, VotersJSON: votersFingerprint(map[string]string{"a": "Al"})}
	ev := buildVotesEvent(hit, old, votersMap(hit.Voters), buildUserNameMap(hit), true)
	if ev.Type != EventVotes {
		t.Fatalf("type = %q, want votes", ev.Type)
	}
	if !strings.Contains(ev.Body, "Votes: 4 \u2192 5") {
		t.Fatalf("body missing vote delta: %q", ev.Body)
	}
	if !strings.Contains(ev.Body, "Added: Bo") {
		t.Fatalf("body missing added voter: %q", ev.Body)
	}

	// When unreliable (partial voter list), only the score delta is shown.
	unrel := buildVotesEvent(hit, old, votersMap(hit.Voters), buildUserNameMap(hit), false)
	if strings.Contains(unrel.Body, "Added") || strings.Contains(unrel.Body, "Removed") {
		t.Fatalf("unreliable votes event must omit named diff: %q", unrel.Body)
	}
}

func TestBuildVotesEventBoundsLargeVoterList(t *testing.T) {
	// Simulate a popular post whose indexed voter list flipped between the
	// embedded subset and the full list, producing a huge "removed" diff.
	prev := map[string]string{}
	for i := 0; i < 500; i++ {
		id := fmt.Sprintf("voter-%03d", i)
		prev[id] = fmt.Sprintf("SomeReallyLongVoterDisplayName_%03d", i)
	}
	hit := gwHit{Title: "Popular request", Score: 1230}
	old := PostState{Score: 1231, VotersJSON: votersFingerprint(prev)}

	ev := buildVotesEvent(hit, old, votersMap(hit.Voters), buildUserNameMap(hit), true)
	if !strings.Contains(ev.Body, "more voters") {
		t.Fatalf("expected a '… and N more voters' tail, got body:\n%s", ev.Body)
	}
	embed := eventToEmbed(ev)
	total := len(embed.Title) + len(embed.Description)
	for _, f := range embed.Fields {
		total += len(f.Name) + len(f.Value)
	}
	if total > 6000 {
		t.Fatalf("embed size %d exceeds Discord's 6000 limit", total)
	}
}

func TestBuildStatusEvent(t *testing.T) {
	hit := gwHit{Title: "Dark mode"}
	ev := buildStatusEvent(hit, "open", "planned", nil)
	if ev.Type != EventStatus {
		t.Fatalf("type = %q, want status", ev.Type)
	}
	if ev.Body != "open \u2192 planned" {
		t.Fatalf("body = %q", ev.Body)
	}
}

func TestDiscordDescriptionComment(t *testing.T) {
	ev := NotificationEvent{
		Type:        EventComment,
		Body:        "the reply",
		PostExcerpt: "the original post",
		ParentChain: []string{"Alice: a parent comment"},
	}
	desc := discordDescription(ev)
	for _, want := range []string{"> the original post", "> Alice: a parent comment", "the reply"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("description %q missing %q", desc, want)
		}
	}
}

func TestBuildWebhookRequestJSONvsMultipart(t *testing.T) {
	payload := discordWebhookPayload{Embeds: []discordEmbed{{Title: "x"}}}

	jsonReq, err := buildWebhookRequest(context.Background(), "https://example.com/hook", payload, nil)
	if err != nil {
		t.Fatalf("json request: %v", err)
	}
	if ct := jsonReq.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("json content-type = %q", ct)
	}

	mpReq, err := buildWebhookRequest(context.Background(), "https://example.com/hook", payload,
		[]webhookAttachment{{filename: "a.png", data: []byte("img")}})
	if err != nil {
		t.Fatalf("multipart request: %v", err)
	}
	if ct := mpReq.Header.Get("Content-Type"); !strings.HasPrefix(ct, "multipart/form-data") {
		t.Fatalf("multipart content-type = %q", ct)
	}
}

func TestWebhookRetryAfter(t *testing.T) {
	// JSON retry_after (fractional seconds) is preferred.
	resp := &http.Response{Header: http.Header{}}
	if got := webhookRetryAfter(resp, []byte(`{"message":"rate limited","retry_after":0.75}`)); got != 750*time.Millisecond {
		t.Fatalf("json retry_after = %s, want 750ms", got)
	}
	// Falls back to the Retry-After header.
	resp.Header.Set("Retry-After", "2")
	if got := webhookRetryAfter(resp, []byte(`{}`)); got != 2*time.Second {
		t.Fatalf("header retry_after = %s, want 2s", got)
	}
	// Missing both -> default 1s.
	if got := webhookRetryAfter(&http.Response{Header: http.Header{}}, nil); got != time.Second {
		t.Fatalf("default = %s, want 1s", got)
	}
	// Clamped to the ceiling.
	if got := webhookRetryAfter(&http.Response{Header: http.Header{}}, []byte(`{"retry_after":600}`)); got != maxWebhookRetryDelay {
		t.Fatalf("clamp = %s, want %s", got, maxWebhookRetryDelay)
	}
}

func TestParseEvents(t *testing.T) {
	got := parseEvents(`["post","bogus","comment","comment"]`)
	// Invalid names dropped; duplicates from JSON are preserved by parseEvents
	// (server-side sanitizeEvents handles de-duplication of client input).
	want := []string{"post", "comment", "comment"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseEvents = %v, want %v", got, want)
	}
	if sanitized := sanitizeEvents(got); strings.Join(sanitized, ",") != "post,comment" {
		t.Fatalf("sanitizeEvents = %v, want post,comment", sanitized)
	}
}

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
	if parsed.Embeds[0].Footer == nil || parsed.Embeds[0].Footer.Text != "Post" {
		t.Fatalf("post footer = %#v, want Post", parsed.Embeds[0].Footer)
	}
	if parsed.Embeds[1].Footer == nil || parsed.Embeds[1].Footer.Text != "Comment" {
		t.Fatalf("comment footer = %#v, want Comment", parsed.Embeds[1].Footer)
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

func TestFilenameWithMimeExt(t *testing.T) {
	const src = "https://canny-assets.io/files/abc123.txt"
	cases := []struct {
		name, mime, url, want string
	}{
		{"output_log_2025-06-30_23-43-00", "text/plain", src, "output_log_2025-06-30_23-43-00.txt"},
		{"notes.TXT", "text/plain", src, "notes.TXT"},
		{"notes.txt", "text/plain", src, "notes.txt"},
		{"clip", "video/mp4", "https://canny-assets.io/files/abc.mp4", "clip.mp4"},
		{"recording", "video/quicktime", "https://canny-assets.io/files/abc.mov", "recording.mov"},
		{"ScreenRecording_2026.05.17-16.07.14", "video/mp4", "https://canny-assets.io/files/abc.mp4", "ScreenRecording_2026.05.17-16.07.14.mp4"},
		{"doc", "application/pdf", "https://canny-assets.io/files/abc.pdf", "doc.pdf"},
		{"data", "text/csv", "https://canny-assets.io/files/abc.csv", "data.csv"},
		{"payload", "application/json", "https://canny-assets.io/files/abc.json", "payload.json"},
		{"movie", "video/avi", "https://canny-assets.io/files/abc.avi", "movie.avi"},
		{"log", "", src, "log.txt"},
		{"log", "text/plain; charset=utf-8", src, "log.txt"},
		{"weird", "application/x-unknown", "https://canny-assets.io/files/abc.bin", "weird.bin"},
		{"plain", "application/x-unknown", "https://example.com/files/noext", "plain"},
		{"", "text/plain", src, "abc123.txt"},
	}
	for _, tc := range cases {
		got := filenameWithMimeExt(tc.name, tc.mime, tc.url)
		if got != tc.want {
			t.Errorf("filenameWithMimeExt(%q, %q, %q) = %q, want %q", tc.name, tc.mime, tc.url, got, tc.want)
		}
	}
}
