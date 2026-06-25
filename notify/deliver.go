package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	neturl "net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// FileAttachment is a file/image shipped with a post or comment.
type FileAttachment struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Mime string `json:"mime,omitempty"`
}

// NotificationEvent is the normalized payload sent to browsers and webhooks.
type NotificationEvent struct {
	Type         string           `json:"type"` // post|comment|votes|status|deleted
	Title        string           `json:"title"`
	PostTitle    string           `json:"postTitle,omitempty"`
	Body         string           `json:"body"`
	URL          string           `json:"url"`
	Board        string           `json:"board,omitempty"`
	Category     string           `json:"category,omitempty"`
	Author       string           `json:"author,omitempty"`
	VoteCount    int              `json:"voteCount,omitempty"`
	CommentCount int              `json:"commentCount,omitempty"`
	PrevStatus   string           `json:"prevStatus,omitempty"`
	NewStatus    string           `json:"newStatus,omitempty"`
	Images       []string         `json:"images,omitempty"`
	Files        []FileAttachment `json:"files,omitempty"`
	PostExcerpt  string           `json:"postExcerpt,omitempty"`
	ParentChain  []string         `json:"parentChain,omitempty"`
	Created      string           `json:"created"`
}

// maxEventsPerTick caps how many notifications a single subscription emits per
// poll so a burst of matches cannot flood a browser or webhook.
const maxEventsPerTick = 10

// Text budgets for assembling notification bodies.
const (
	postExcerptMax        = 400
	commentBodyMax        = 1500
	parentCommentMax      = 240
	parentChainCharBudget = 1200
	parentChainMaxItems   = 5
)

// Discord webhook attachment limits.
const (
	maxAttachments    = 5
	maxAttachmentSize = 8 << 20 // 8 MiB per file
)

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
			if err := d.store.DeletePushSubscriptionByEndpoint(sub.Push.Endpoint); err != nil {
				log.Printf("[notify] delete gone push endpoint: %v", err)
			}
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

func categoryName(hit gwHit) string {
	if hit.Category != nil {
		return trimSpace(hit.Category.Name)
	}
	return ""
}

func convFiles(files []gwFile) []FileAttachment {
	out := make([]FileAttachment, 0, len(files))
	for _, f := range files {
		if f.URL == "" {
			continue
		}
		name := f.Name
		if name == "" {
			name = urlBasename(f.URL)
		}
		out = append(out, FileAttachment{Name: name, URL: f.URL, Mime: f.MimeType})
	}
	return out
}

func displayName(name string) string {
	if n := trimSpace(name); n != "" {
		return n
	}
	return "Anonymous"
}

func newPostEvent(hit gwHit) NotificationEvent {
	names := buildUserNameMap(hit)
	board := boardLabel(hit.Board.Name, hit.Board.URLName)
	return NotificationEvent{
		Type:         EventPost,
		Title:        fmt.Sprintf("New post in %s", board),
		PostTitle:    hit.Title,
		Body:         excerpt(substituteMentions(hit.Details, names), commentBodyMax),
		URL:          cannyPostURL(hit.Board.URLName, hit.URLName),
		Board:        board,
		Category:     categoryName(hit),
		Author:       hit.Author.Name,
		VoteCount:    hit.Score,
		CommentCount: hit.CommentCount,
		Images:       hit.ImageURLs,
		Files:        convFiles(hit.Files),
		Created:      hit.Created,
	}
}

func commentBody(c gwComment) string {
	if trimSpace(c.Value) != "" {
		return c.Value
	}
	if c.StatusChangeNewStatus != "" {
		return "marked this post as " + c.StatusChangeNewStatus
	}
	return ""
}

func newCommentEvent(hit gwHit, c gwComment, names map[string]string) NotificationEvent {
	board := boardLabel(hit.Board.Name, hit.Board.URLName)
	return NotificationEvent{
		Type:         EventComment,
		Title:        fmt.Sprintf("New comment on %q", hit.Title),
		PostTitle:    hit.Title,
		Body:         excerpt(substituteMentions(commentBody(c), names), commentBodyMax),
		URL:          cannyPostURL(hit.Board.URLName, hit.URLName),
		Board:        board,
		Category:     categoryName(hit),
		Author:       c.Author.Name,
		VoteCount:    hit.Score,
		CommentCount: hit.CommentCount,
		Images:       c.ImageURLs,
		Files:        convFiles(c.Files),
		PostExcerpt:  excerpt(substituteMentions(hit.Details, names), postExcerptMax),
		ParentChain:  buildParentChain(hit, c, names),
		Created:      c.Created,
	}
}

// buildParentChain walks a sub-comment's ancestors (parent, grandparent, ...)
// and returns them oldest-first as "Author: body" lines, bounded by a count and
// character budget so the webhook body stays within Discord's limits.
func buildParentChain(hit gwHit, c gwComment, names map[string]string) []string {
	if c.ParentID == "" {
		return nil
	}
	byID := make(map[string]gwComment, len(hit.Comments))
	for _, cc := range hit.Comments {
		if cc.ID != "" {
			byID[cc.ID] = cc
		}
	}
	// Climb nearest-first.
	var nearestFirst []gwComment
	pid := c.ParentID
	for guard := 0; pid != "" && guard < 50; guard++ {
		parent, ok := byID[pid]
		if !ok {
			break
		}
		nearestFirst = append(nearestFirst, parent)
		pid = parent.ParentID
	}
	// Select within budget, preferring the nearest ancestors.
	var selected []gwComment
	used := 0
	for _, p := range nearestFirst {
		if len(selected) >= parentChainMaxItems {
			break
		}
		line := excerpt(p.Value, parentCommentMax)
		if used+len(line) > parentChainCharBudget && len(selected) > 0 {
			break
		}
		used += len(line)
		selected = append(selected, p)
	}
	// Emit oldest-first.
	out := make([]string, 0, len(selected))
	for i := len(selected) - 1; i >= 0; i-- {
		p := selected[i]
		body := substituteMentions(excerpt(commentBody(p), parentCommentMax), names)
		out = append(out, fmt.Sprintf("%s: %s", displayName(p.Author.Name), body))
	}
	return out
}

func buildVotesEvent(hit gwHit, old PostState, curVoters, names map[string]string) NotificationEvent {
	prevVoters := decodeVoters(old.VotersJSON)
	var added, removed []string
	for id, name := range curVoters {
		if _, ok := prevVoters[id]; !ok {
			added = append(added, displayName(name))
		}
	}
	for id, name := range prevVoters {
		if _, ok := curVoters[id]; !ok {
			removed = append(removed, displayName(name))
		}
	}
	sort.Strings(added)
	sort.Strings(removed)

	parts := []string{fmt.Sprintf("Votes: %d \u2192 %d", old.Score, hit.Score)}
	if len(added) > 0 {
		parts = append(parts, "Added: "+strings.Join(added, ", "))
	}
	if len(removed) > 0 {
		parts = append(parts, "Removed: "+strings.Join(removed, ", "))
	}

	board := boardLabel(hit.Board.Name, hit.Board.URLName)
	return NotificationEvent{
		Type:         EventVotes,
		Title:        fmt.Sprintf("Votes changed on %q", hit.Title),
		PostTitle:    hit.Title,
		Body:         strings.Join(parts, "\n"),
		URL:          cannyPostURL(hit.Board.URLName, hit.URLName),
		Board:        board,
		Category:     categoryName(hit),
		Author:       hit.Author.Name,
		VoteCount:    hit.Score,
		CommentCount: hit.CommentCount,
		Created:      time.Now().UTC().Format(time.RFC3339),
	}
}

func buildStatusEvent(hit gwHit, prevStatus, newStatus string, names map[string]string) NotificationEvent {
	prevLabel := prevStatus
	if prevLabel == "" {
		prevLabel = "unknown"
	}
	board := boardLabel(hit.Board.Name, hit.Board.URLName)
	return NotificationEvent{
		Type:         EventStatus,
		Title:        fmt.Sprintf("Status changed on %q", hit.Title),
		PostTitle:    hit.Title,
		Body:         fmt.Sprintf("%s \u2192 %s", prevLabel, newStatus),
		URL:          cannyPostURL(hit.Board.URLName, hit.URLName),
		Board:        board,
		Category:     categoryName(hit),
		Author:       hit.Author.Name,
		VoteCount:    hit.Score,
		CommentCount: hit.CommentCount,
		PrevStatus:   prevStatus,
		NewStatus:    newStatus,
		Created:      time.Now().UTC().Format(time.RFC3339),
	}
}

// watchConfirmation builds a one-time confirmation for a state-change event
// type (votes/status/deleted) when it is first enabled. These watch a whole
// filter (potentially many posts with different statuses/vote counts), so the
// message describes the filter-level watch rather than asserting any single
// post's current state.
func watchConfirmation(sub Subscription, eventType string) NotificationEvent {
	label := trimSpace(sub.Label)
	if label == "" {
		label = "all posts"
	}
	ev := NotificationEvent{
		Type:    eventType,
		URL:     "https://feedback.vrchat.com",
		Created: time.Now().UTC().Format(time.RFC3339),
	}
	switch eventType {
	case EventVotes:
		ev.Title = "Now watching for vote changes"
		ev.Body = fmt.Sprintf("You'll be notified when votes change on posts matching this filter: %s.", label)
	case EventStatus:
		ev.Title = "Now watching for status changes"
		ev.Body = fmt.Sprintf("You'll be notified when a matching post's status changes. Filter: %s.", label)
	case EventDeleted:
		ev.Title = "Now watching for deletions"
		ev.Body = fmt.Sprintf("You'll be notified when a matching post is deleted or migrated. Filter: %s.", label)
	}
	return ev
}

func buildDeletedEvent(old PostState) NotificationEvent {
	board := old.Board
	title := old.Title
	if title == "" {
		title = "(removed post)"
	}
	return NotificationEvent{
		Type:      EventDeleted,
		Title:     fmt.Sprintf("Post removed: %q", title),
		PostTitle: title,
		Body:      "This post was deleted or migrated.",
		URL:       old.URL,
		Board:     board,
		Created:   time.Now().UTC().Format(time.RFC3339),
	}
}

func urlBasename(u string) string {
	clean := u
	if i := strings.IndexAny(clean, "?#"); i >= 0 {
		clean = clean[:i]
	}
	base := path.Base(clean)
	if base == "." || base == "/" || base == "" {
		return "file"
	}
	return base
}

// ---------------------------------------------------------------------------
// Discord webhook delivery
// ---------------------------------------------------------------------------

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
	discordColorVotes          = 0x5865F2
	discordColorStatus         = 0xEB459E
	discordColorDeleted        = 0xED4245
)

func discordColor(eventType string) int {
	switch eventType {
	case EventComment:
		return discordColorComment
	case EventVotes:
		return discordColorVotes
	case EventStatus:
		return discordColorStatus
	case EventDeleted:
		return discordColorDeleted
	default:
		return discordColorPost
	}
}

// discordDescription assembles the embed body: for comments it prepends the
// post excerpt and any ancestor comments (quoted) before the comment itself.
func discordDescription(ev NotificationEvent) string {
	if ev.Type != EventComment {
		return ev.Body
	}
	var parts []string
	if ev.PostExcerpt != "" {
		parts = append(parts, "> "+ev.PostExcerpt)
	}
	for _, p := range ev.ParentChain {
		parts = append(parts, "> "+p)
	}
	if ev.Body != "" {
		parts = append(parts, ev.Body)
	}
	return strings.Join(parts, "\n\n")
}

// addField appends an inline embed field only when the value is non-empty after
// trimming. Discord rejects fields with empty/whitespace-only values (and the
// whole embed with it), so this guards every field we emit.
func addField(fields []discordField, name, value string) []discordField {
	value = trimSpace(value)
	if value == "" {
		return fields
	}
	return append(fields, discordField{Name: name, Value: truncate(value, discordEmbedFieldValueMax), Inline: true})
}

// validEmbedURL reports whether s is safe to use as an embed/link URL. Discord
// rejects an embed outright if its url is present but malformed.
func validEmbedURL(s string) bool {
	s = trimSpace(s)
	if s == "" {
		return false
	}
	u, err := neturl.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

func eventToEmbed(ev NotificationEvent) discordEmbed {
	title := trimSpace(ev.PostTitle)
	if title == "" {
		title = trimSpace(ev.Title)
	}
	if title == "" {
		title = "VRChat feedback"
	}

	fields := make([]discordField, 0, 5)
	fields = addField(fields, "Author", ev.Author)
	fields = addField(fields, "Board", ev.Board)
	fields = addField(fields, "Category", ev.Category)
	if ev.VoteCount > 1 {
		fields = addField(fields, "Votes", strconv.Itoa(ev.VoteCount))
	}
	if ev.CommentCount > 0 {
		fields = addField(fields, "Comments", strconv.Itoa(ev.CommentCount))
	}

	embed := discordEmbed{
		Title:       truncate(title, discordEmbedTitleMax),
		Description: truncate(discordDescription(ev), discordEmbedDescriptionMax),
		Color:       discordColor(ev.Type),
		Fields:      fields,
		Timestamp:   ev.Created,
	}
	// Only attach a url when it is well-formed; a bad url rejects the embed.
	if validEmbedURL(ev.URL) {
		embed.URL = trimSpace(ev.URL)
	}
	return embed
}

func buildDiscordEmbeds(events []NotificationEvent) []discordEmbed {
	embeds := make([]discordEmbed, 0, len(events))
	for _, ev := range events {
		embeds = append(embeds, eventToEmbed(ev))
	}
	return embeds
}

// buildDiscordWebhookPayload renders the embeds-only JSON body (no attachments).
func buildDiscordWebhookPayload(events []NotificationEvent) ([]byte, error) {
	return json.Marshal(discordWebhookPayload{Embeds: buildDiscordEmbeds(events)})
}

type webhookAttachment struct {
	filename string
	data     []byte
}

func (d *Dispatcher) deliverWebhook(ctx context.Context, sub Subscription, events []NotificationEvent) {
	payload := discordWebhookPayload{Embeds: buildDiscordEmbeds(events)}
	attachments := d.collectAttachments(ctx, events)

	req, err := buildWebhookRequest(ctx, sub.WebhookURL, payload, attachments)
	if err != nil {
		log.Printf("[notify] webhook sub=%d build request: %v", sub.ID, err)
		d.recordWebhookFailure(sub)
		return
	}
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
		log.Printf("[notify] webhook sub=%d status=%d events=%d files=%d delivered", sub.ID, resp.StatusCode, len(events), len(attachments))
		if sub.ErrorSinceMS.Valid {
			if err := d.store.ClearWebhookError(sub.ID); err != nil {
				log.Printf("[notify] clear webhook error sub=%d: %v", sub.ID, err)
			}
		}
		return
	}
	// Include the payload we sent so a rejection (e.g. an invalid embed) can be
	// diagnosed without re-deploying: the response alone is often opaque.
	sentJSON, _ := json.Marshal(payload)
	log.Printf("[notify] webhook sub=%d status=%d events=%d rejected: %s | sent: %s",
		sub.ID, resp.StatusCode, len(events), truncate(string(respBody), 300), truncate(string(sentJSON), 1500))
	d.recordWebhookFailure(sub)
}

// buildWebhookRequest builds either a JSON request (no files) or a multipart
// request with payload_json + downloaded file parts (Discord attachments).
func buildWebhookRequest(ctx context.Context, webhookURL string, payload discordWebhookPayload, attachments []webhookAttachment) (*http.Request, error) {
	if len(attachments) == 0 {
		body, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		return req, nil
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	if err := mw.WriteField("payload_json", string(payloadJSON)); err != nil {
		return nil, err
	}
	for i, a := range attachments {
		part, err := mw.CreateFormFile(fmt.Sprintf("files[%d]", i), a.filename)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(a.data); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req, nil
}

// collectAttachments downloads images and files referenced by the events, up to
// maxAttachments and maxAttachmentSize each. Oversized or failing downloads are
// skipped.
func (d *Dispatcher) collectAttachments(ctx context.Context, events []NotificationEvent) []webhookAttachment {
	type ref struct{ name, url string }
	var refs []ref
	seen := map[string]bool{}
	for _, ev := range events {
		for _, img := range ev.Images {
			if img != "" && !seen[img] {
				seen[img] = true
				refs = append(refs, ref{urlBasename(img), img})
			}
		}
		for _, f := range ev.Files {
			if f.URL != "" && !seen[f.URL] {
				seen[f.URL] = true
				name := f.Name
				if name == "" {
					name = urlBasename(f.URL)
				}
				refs = append(refs, ref{name, f.URL})
			}
		}
	}

	out := make([]webhookAttachment, 0, maxAttachments)
	used := map[string]int{}
	for _, r := range refs {
		if len(out) >= maxAttachments {
			break
		}
		data, ok := d.downloadCapped(ctx, r.url, maxAttachmentSize)
		if !ok {
			continue
		}
		name := r.name
		// Discord requires distinct filenames per request.
		if used[name] > 0 {
			name = fmt.Sprintf("%d-%s", used[name], name)
		}
		used[r.name]++
		out = append(out, webhookAttachment{filename: name, data: data})
	}
	return out
}

// downloadCapped fetches up to limit bytes; returns false if the request fails
// or the body exceeds the limit.
func (d *Dispatcher) downloadCapped(ctx context.Context, rawURL string, limit int64) ([]byte, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, false
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, false
	}
	if int64(len(data)) > limit {
		return nil, false // too large to attach
	}
	return data, true
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
