package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"sync/atomic"
	"time"
)

// Dispatcher polls the search gateway on an interval and delivers
// notifications for any new posts/comments that match each subscription, plus
// vote/status/deletion changes detected by diffing per-post snapshots.
type Dispatcher struct {
	cfg    Config
	store  *Store
	client *http.Client
	tick   atomic.Int64
}

func newDispatcher(cfg Config, store *Store) *Dispatcher {
	return &Dispatcher{
		cfg:    cfg,
		store:  store,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

// snapshotMaxHits caps how many matching posts the snapshot pass will page
// through. When a subscription's filter matches more than this, deletion
// detection is skipped that tick to avoid false "deleted" notifications for
// posts that merely fell off the end of the (incomplete) result set.
const snapshotMaxHits = 5000

// snapshotPageSize is the per-request page size for the snapshot pass.
const snapshotPageSize = 100

// Run blocks, polling until ctx is cancelled.
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.cfg.PollInterval)
	defer ticker.Stop()
	d.runTick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.runTick(ctx)
		}
	}
}

func (d *Dispatcher) runTick(ctx context.Context) {
	tick := d.tick.Add(1)
	subs, err := d.store.ListAll()
	if err != nil {
		log.Printf("[notify] list subscriptions: %v", err)
		return
	}
	for _, sub := range subs {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if err := d.processSubscription(ctx, sub, tick); err != nil {
			log.Printf("[notify] subscription %d (%s): %v", sub.ID, sub.Target, err)
		}
	}
}

func (d *Dispatcher) processSubscription(ctx context.Context, sub Subscription, tick int64) error {
	var firstErr error
	record := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if sub.HasEvent(EventPost) {
		record(d.processNewPosts(ctx, sub))
	}
	if sub.HasEvent(EventComment) {
		record(d.processNewComments(ctx, sub))
	}
	if sub.HasEvent(EventVotes) || sub.HasEvent(EventStatus) || sub.HasEvent(EventDeleted) {
		record(d.processSnapshot(ctx, sub, tick))
	}
	return firstErr
}

// gwHit is the subset of a gateway search hit we care about.
type gwHit struct {
	PostID       string   `json:"post_id"`
	ID           string   `json:"_id"`
	Title        string   `json:"title"`
	Details      string   `json:"details"`
	URLName      string   `json:"urlName"`
	Created      string   `json:"created"`
	Status       string   `json:"status"`
	Score        int      `json:"score"`
	CommentCount int      `json:"commentCount"`
	ImageURLs    []string `json:"imageURLs"`
	Files        []gwFile `json:"files"`
	Board        struct {
		Name    string `json:"name"`
		URLName string `json:"urlName"`
	} `json:"board"`
	Category      *gwNamed    `json:"category"`
	Author        gwUser      `json:"author"`
	By            *gwUser     `json:"by"`
	UpdatedBy     *gwUser     `json:"updatedBy"`
	Voters        []gwUser    `json:"voters"`
	Comments      []gwComment `json:"comments"`
	PinnedComment *gwComment  `json:"pinnedComment"`
}

func (h gwHit) id() string {
	if h.PostID != "" {
		return h.PostID
	}
	return h.ID
}

type gwNamed struct {
	Name string `json:"name"`
}

type gwUser struct {
	ID   string `json:"_id"`
	Name string `json:"name"`
}

type gwFile struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	MimeType string `json:"mimeType"`
}

type gwComment struct {
	ID                    string   `json:"_id"`
	ParentID              string   `json:"parentID"`
	Value                 string   `json:"value"`
	Created               string   `json:"created"`
	Author                gwUser   `json:"author"`
	Files                 []gwFile `json:"files"`
	ImageURLs             []string `json:"imageURLs"`
	MentionedUsers        []gwUser `json:"mentionedUsers"`
	StatusChangeNewStatus string   `json:"statusChangeNewStatus"`
	Deleted               bool     `json:"deleted"`
	Spam                  bool     `json:"spam"`
}

type gwResponse struct {
	Results []struct {
		Hits []json.RawMessage `json:"hits"`
	} `json:"results"`
}

// processNewPosts delivers notifications for posts created after the post
// watermark.
func (d *Dispatcher) processNewPosts(ctx context.Context, sub Subscription) error {
	hits, err := d.queryGatewayPage(ctx, sub, d.cfg.IndexName+"_created_asc", 0, 100,
		[]string{fmt.Sprintf("post_created > %d", sub.WatermarkMS)})
	if err != nil {
		return err
	}
	events, maxSeen := buildPostEvents(hits, sub.WatermarkMS)
	if len(events) == 0 {
		return nil
	}
	d.deliver(ctx, sub, events)
	return d.store.UpdateWatermark(sub.ID, maxSeen)
}

// processNewComments delivers notifications for comments created after the
// comment watermark.
func (d *Dispatcher) processNewComments(ctx context.Context, sub Subscription) error {
	hits, err := d.queryGatewayPage(ctx, sub, d.cfg.IndexName+"_created_asc", 0, 100,
		[]string{fmt.Sprintf("comment_created > %d", sub.CommentWatermarkMS)})
	if err != nil {
		return err
	}
	events, maxSeen := buildCommentEvents(hits, sub.CommentWatermarkMS)
	if len(events) == 0 {
		return nil
	}
	d.deliver(ctx, sub, events)
	return d.store.UpdateCommentWatermark(sub.ID, maxSeen)
}

// processSnapshot pages through the entire matching set, diffs each post
// against its stored snapshot, and emits vote/status/deletion events.
func (d *Dispatcher) processSnapshot(ctx context.Context, sub Subscription, tick int64) error {
	hits, complete, err := d.queryGatewayAll(ctx, sub)
	if err != nil {
		return err
	}
	prev, err := d.store.ListPostState(sub.ID)
	if err != nil {
		return err
	}

	present := make(map[string]bool, len(hits))
	var events []NotificationEvent

	for _, raw := range hits {
		var hit gwHit
		if err := json.Unmarshal(raw, &hit); err != nil {
			continue
		}
		pid := hit.id()
		if pid == "" {
			continue
		}
		present[pid] = true

		userMap := buildUserNameMap(hit)
		curVoters := votersMap(hit.Voters)
		createdMS, _ := parseTimeMS(hit.Created)
		cur := PostState{
			PostID:       pid,
			Title:        hit.Title,
			URL:          cannyPostURL(hit.Board.URLName, hit.URLName),
			Board:        boardLabel(hit.Board.Name, hit.Board.URLName),
			Score:        hit.Score,
			Status:       trimSpace(hit.Status),
			CommentCount: hit.CommentCount,
			VotersJSON:   votersFingerprint(curVoters),
			CreatedMS:    createdMS,
		}

		old, seen := prev[pid]
		if !seen {
			// First sighting for this subscription: seed only. New-post alerts are
			// the watermark pass's job, so we never notify here.
			_ = d.store.UpsertPostState(sub.ID, cur)
			continue
		}

		if sub.HasEvent(EventVotes) && (old.Score != cur.Score || old.VotersJSON != cur.VotersJSON) {
			events = append(events, buildVotesEvent(hit, old, curVoters, userMap))
		}
		if sub.HasEvent(EventStatus) && cur.Status != "" && old.Status != cur.Status {
			events = append(events, buildStatusEvent(hit, old.Status, cur.Status, userMap))
		}
		_ = d.store.UpsertPostState(sub.ID, cur)
	}

	// Reconcile vanished posts only when we retrieved the complete result set;
	// otherwise a post beyond the page cap would look deleted.
	if complete {
		for pid, old := range prev {
			if present[pid] {
				continue
			}
			if sub.HasEvent(EventDeleted) {
				events = append(events, buildDeletedEvent(old))
			}
			_ = d.store.DeletePostState(sub.ID, pid)
		}
	}

	if len(events) > 0 {
		d.deliver(ctx, sub, events)
	}
	return nil
}

// buildPostEvents turns gateway hits into new-post events for posts created
// after sinceMS (exclusive), returning the greatest created timestamp seen.
func buildPostEvents(hits []json.RawMessage, sinceMS int64) ([]NotificationEvent, int64) {
	maxSeen := sinceMS
	events := []NotificationEvent{}
	for _, raw := range hits {
		var hit gwHit
		if err := json.Unmarshal(raw, &hit); err != nil {
			continue
		}
		createdMS, ok := parseTimeMS(hit.Created)
		if !ok || createdMS <= sinceMS {
			continue
		}
		if createdMS > maxSeen {
			maxSeen = createdMS
		}
		events = append(events, newPostEvent(hit))
	}
	return events, maxSeen
}

// buildCommentEvents turns gateway hits into new-comment events for comments
// created after sinceMS (exclusive), returning the greatest created seen.
func buildCommentEvents(hits []json.RawMessage, sinceMS int64) ([]NotificationEvent, int64) {
	maxSeen := sinceMS
	events := []NotificationEvent{}
	for _, raw := range hits {
		var hit gwHit
		if err := json.Unmarshal(raw, &hit); err != nil {
			continue
		}
		userMap := buildUserNameMap(hit)
		for _, c := range hit.Comments {
			if c.Deleted || c.Spam {
				continue
			}
			createdMS, ok := parseTimeMS(c.Created)
			if !ok || createdMS <= sinceMS {
				continue
			}
			if createdMS > maxSeen {
				maxSeen = createdMS
			}
			events = append(events, newCommentEvent(hit, c, userMap))
		}
	}
	return events, maxSeen
}

// SendInitial delivers the single most recent existing item matching the
// subscription's filter, as a "first message" right after a push subscription
// is created. It ignores watermarks and does not advance them. Best-effort.
func (d *Dispatcher) SendInitial(ctx context.Context, sub Subscription) {
	index := d.cfg.IndexName
	if sub.HasEvent(EventComment) && !sub.HasEvent(EventPost) {
		index = d.cfg.IndexName + "_activity_desc"
	}
	hits, err := d.queryGatewayPage(ctx, sub, index, 0, 25, nil)
	if err != nil {
		log.Printf("[notify] initial sub=%d target=%s: %v", sub.ID, sub.Target, err)
		return
	}
	var events []NotificationEvent
	var maxMS int64 = -1
	if sub.HasEvent(EventPost) {
		evs, _ := buildPostEvents(hits, -1)
		for _, ev := range evs {
			if ms, ok := parseTimeMS(ev.Created); ok && ms > maxMS {
				maxMS, events = ms, []NotificationEvent{ev}
			}
		}
	}
	if len(events) == 0 && sub.HasEvent(EventComment) {
		evs, _ := buildCommentEvents(hits, -1)
		for _, ev := range evs {
			if ms, ok := parseTimeMS(ev.Created); ok && ms > maxMS {
				maxMS, events = ms, []NotificationEvent{ev}
			}
		}
	}
	if len(events) == 0 {
		return
	}
	d.deliver(ctx, sub, events)
}

// queryGatewayAll pages through every hit matching the subscription's filter,
// up to snapshotMaxHits. The second return reports whether the full set was
// retrieved (false when the cap was reached).
func (d *Dispatcher) queryGatewayAll(ctx context.Context, sub Subscription) ([]json.RawMessage, bool, error) {
	var all []json.RawMessage
	for page := 0; page*snapshotPageSize < snapshotMaxHits; page++ {
		hits, err := d.queryGatewayPage(ctx, sub, d.cfg.IndexName+"_created_asc", page, snapshotPageSize, nil)
		if err != nil {
			return nil, false, err
		}
		all = append(all, hits...)
		if len(hits) < snapshotPageSize {
			return all, true, nil // fewer than a full page: we reached the end
		}
	}
	return all, false, nil // hit the cap; set may be incomplete
}

// queryGatewayPage replays the stored InstantSearch filter against the given
// index replica for a single page, with optional extra numeric filters.
func (d *Dispatcher) queryGatewayPage(ctx context.Context, sub Subscription, indexName string, page, hitsPerPage int, extraNumeric []string) ([]json.RawMessage, error) {
	var params map[string]interface{}
	if err := json.Unmarshal([]byte(sub.FilterJSON), &params); err != nil || params == nil {
		params = map[string]interface{}{}
	}

	if len(extraNumeric) > 0 {
		existing, _ := params["numericFilters"].([]interface{})
		for _, f := range extraNumeric {
			existing = append(existing, f)
		}
		params["numericFilters"] = existing
	}
	params["page"] = page
	params["hitsPerPage"] = hitsPerPage
	// Strip presentation-only params: facets/highlighting are irrelevant for
	// dispatch, and any attributesToRetrieve/responseFields restriction would
	// trim the _source we need to build notifications.
	for _, k := range []string{
		"facets", "maxValuesPerFacet",
		"attributesToRetrieve", "responseFields",
		"attributesToHighlight", "attributesToSnippet",
		"highlightPreTag", "highlightPostTag",
	} {
		delete(params, k)
	}

	body := []map[string]interface{}{
		{
			"indexName": indexName,
			"params":    params,
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	endpoint := d.cfg.GatewayURL + "/api/search"
	if sub.Lucene {
		endpoint += "?" + url.Values{"mode": {"lucene"}}.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gateway status %d: %s", resp.StatusCode, truncate(string(data), 300))
	}

	var parsed gwResponse
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("decode gateway response: %w", err)
	}
	if len(parsed.Results) == 0 {
		return nil, nil
	}
	return parsed.Results[0].Hits, nil
}

func cannyPostURL(boardSlug, urlName string) string {
	if boardSlug == "" || urlName == "" {
		return "https://feedback.vrchat.com"
	}
	return fmt.Sprintf("https://feedback.vrchat.com/%s/p/%s", url.PathEscape(boardSlug), url.PathEscape(urlName))
}

func boardLabel(name, slug string) string {
	if name != "" {
		return name
	}
	if slug != "" {
		return slug
	}
	return "VRChat feedback"
}

func parseTimeMS(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}

func excerpt(s string, max int) string {
	s = collapseWhitespace(s)
	return truncate(s, max)
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "\u2026"
}

func trimSpace(s string) string {
	return string(bytes.TrimSpace([]byte(s)))
}

func collapseWhitespace(s string) string {
	out := make([]rune, 0, len(s))
	prevSpace := false
	for _, r := range s {
		if r == '\n' || r == '\r' || r == '\t' {
			r = ' '
		}
		if r == ' ' {
			if prevSpace {
				continue
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
		out = append(out, r)
	}
	res := string(out)
	if len(res) > 0 && res[0] == ' ' {
		res = res[1:]
	}
	if len(res) > 0 && res[len(res)-1] == ' ' {
		res = res[:len(res)-1]
	}
	return res
}

// ---------------------------------------------------------------------------
// Canny @-mention substitution (ported from search-ui/src/App.tsx).
// Canny encodes "@DisplayName" as "@{mongoId|full_name}" in post/comment bodies.
// ---------------------------------------------------------------------------

var cannyMentionTokenRe = regexp.MustCompile(`@\{([0-9a-f]{24})\|full_name\}`)

func registerCannyUser(m map[string]string, u gwUser) {
	if u.ID == "" || u.Name == "" {
		return
	}
	if _, ok := m[u.ID]; ok {
		return
	}
	m[u.ID] = u.Name
}

// buildUserNameMap aggregates Canny _id -> display name from everything shipped
// on the hit, so mention tokens can be resolved to readable names.
func buildUserNameMap(hit gwHit) map[string]string {
	m := map[string]string{}
	registerCannyUser(m, hit.Author)
	if hit.By != nil {
		registerCannyUser(m, *hit.By)
	}
	if hit.UpdatedBy != nil {
		registerCannyUser(m, *hit.UpdatedBy)
	}
	for _, v := range hit.Voters {
		registerCannyUser(m, v)
	}
	for _, c := range hit.Comments {
		registerCannyUser(m, c.Author)
		for _, mu := range c.MentionedUsers {
			registerCannyUser(m, mu)
		}
	}
	if hit.PinnedComment != nil {
		registerCannyUser(m, hit.PinnedComment.Author)
		for _, mu := range hit.PinnedComment.MentionedUsers {
			registerCannyUser(m, mu)
		}
	}
	return m
}

func substituteMentions(text string, names map[string]string) string {
	if text == "" || len(names) == 0 {
		return text
	}
	return cannyMentionTokenRe.ReplaceAllStringFunc(text, func(match string) string {
		sub := cannyMentionTokenRe.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		if name, ok := names[sub[1]]; ok {
			return "@" + name
		}
		return match
	})
}

func votersMap(voters []gwUser) map[string]string {
	out := make(map[string]string, len(voters))
	for _, v := range voters {
		if v.ID == "" {
			continue
		}
		out[v.ID] = v.Name
	}
	return out
}
