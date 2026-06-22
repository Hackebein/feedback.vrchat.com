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
	"time"
)

// Dispatcher polls the search gateway on an interval and delivers
// notifications for any new posts/comments that match each subscription.
type Dispatcher struct {
	cfg    Config
	store  *Store
	client *http.Client
}

func newDispatcher(cfg Config, store *Store) *Dispatcher {
	return &Dispatcher{
		cfg:    cfg,
		store:  store,
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

// Run blocks, polling until ctx is cancelled.
func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.cfg.PollInterval)
	defer ticker.Stop()
	d.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.tick(ctx)
		}
	}
}

func (d *Dispatcher) tick(ctx context.Context) {
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
		if err := d.processSubscription(ctx, sub); err != nil {
			log.Printf("[notify] subscription %d (%s/%s): %v", sub.ID, sub.Target, sub.Kind, err)
		}
	}
}

// gwHit is the subset of a gateway search hit we care about.
type gwHit struct {
	PostID  string `json:"post_id"`
	Title   string `json:"title"`
	Details string `json:"details"`
	URLName string `json:"urlName"`
	Created string `json:"created"`
	Board   struct {
		Name    string `json:"name"`
		URLName string `json:"urlName"`
	} `json:"board"`
	Author struct {
		Name string `json:"name"`
	} `json:"author"`
	Comments []gwComment `json:"comments"`
}

type gwComment struct {
	ID      string `json:"_id"`
	Value   string `json:"value"`
	Created string `json:"created"`
	Author  struct {
		Name string `json:"name"`
	} `json:"author"`
}

type gwResponse struct {
	Results []struct {
		Hits []json.RawMessage `json:"hits"`
	} `json:"results"`
}

func (d *Dispatcher) processSubscription(ctx context.Context, sub Subscription) error {
	hits, err := d.queryGateway(ctx, sub, d.cfg.IndexName+"_created_asc", true, 100)
	if err != nil {
		return err
	}

	nowMS := time.Now().UnixMilli()
	events, maxSeen := buildEvents(sub, hits, sub.WatermarkMS)

	log.Printf("[notify] sub=%d target=%s kind=%s hits=%d events=%d watermark=%d", sub.ID, sub.Target, sub.Kind, len(hits), len(events), sub.WatermarkMS)

	if len(events) == 0 {
		// Nothing matched; nudge the watermark forward so the search window
		// does not grow without bound. Stay WatermarkLag behind wall-clock so
		// posts that are still propagating through the ingest pipeline (and
		// therefore carry a `created` timestamp older than now) are not skipped
		// once they become searchable.
		safeMS := nowMS - d.cfg.WatermarkLag.Milliseconds()
		if safeMS > sub.WatermarkMS {
			return d.store.UpdateWatermark(sub.ID, safeMS)
		}
		return nil
	}

	d.deliver(ctx, sub, events)

	// Delivery is best-effort: a down webhook records an error streak (and is
	// eventually auto-expired) rather than re-sending the same events forever,
	// so the watermark always advances past processed content.
	return d.store.UpdateWatermark(sub.ID, maxSeen)
}

// SendInitial delivers the single most recent existing item matching the
// subscription's filter, as a "first message" right after the subscription is
// created. It ignores the watermark and does not advance it: the item already
// exists (created <= now == watermark), so the regular poll loop will not
// re-send it. Best-effort; errors are logged.
func (d *Dispatcher) SendInitial(ctx context.Context, sub Subscription) {
	index := d.cfg.IndexName
	if sub.Kind == "comment" {
		// Order by activity so posts carrying the newest comments come first.
		index = d.cfg.IndexName + "_activity_desc"
	}
	hits, err := d.queryGateway(ctx, sub, index, false, 25)
	if err != nil {
		log.Printf("[notify] initial sub=%d target=%s kind=%s: %v", sub.ID, sub.Target, sub.Kind, err)
		return
	}

	events, _ := buildEvents(sub, hits, -1)
	if len(events) == 0 {
		log.Printf("[notify] initial sub=%d target=%s kind=%s: no matching item", sub.ID, sub.Target, sub.Kind)
		return
	}

	latest := events[0]
	latestMS, _ := parseTimeMS(latest.Created)
	for _, ev := range events[1:] {
		ms, ok := parseTimeMS(ev.Created)
		if ok && ms > latestMS {
			latest, latestMS = ev, ms
		}
	}

	log.Printf("[notify] initial sub=%d target=%s kind=%s delivering latest=%s", sub.ID, sub.Target, sub.Kind, latest.Created)
	d.deliver(ctx, sub, []NotificationEvent{latest})
}

// buildEvents turns gateway hits into notification events for content created
// after sinceMS (exclusive). It returns the events plus the greatest created
// timestamp seen (clamped to at least sinceMS) so callers can advance a
// watermark. Pass sinceMS = -1 to include every item.
func buildEvents(sub Subscription, hits []json.RawMessage, sinceMS int64) ([]NotificationEvent, int64) {
	maxSeen := sinceMS
	events := []NotificationEvent{}

	for _, raw := range hits {
		var hit gwHit
		if err := json.Unmarshal(raw, &hit); err != nil {
			continue
		}
		link := cannyPostURL(hit.Board.URLName, hit.URLName)
		if sub.Kind == "post" {
			createdMS, ok := parseTimeMS(hit.Created)
			if !ok || createdMS <= sinceMS {
				continue
			}
			if createdMS > maxSeen {
				maxSeen = createdMS
			}
			events = append(events, NotificationEvent{
				Type:    "post",
				Title:   fmt.Sprintf("New post in %s", boardLabel(hit.Board.Name, hit.Board.URLName)),
				Body:    hit.Title,
				URL:     link,
				Board:   hit.Board.Name,
				Author:  hit.Author.Name,
				Excerpt: excerpt(hit.Details, 200),
				Created: hit.Created,
			})
		} else { // comment
			for _, c := range hit.Comments {
				createdMS, ok := parseTimeMS(c.Created)
				if !ok || createdMS <= sinceMS {
					continue
				}
				if createdMS > maxSeen {
					maxSeen = createdMS
				}
				events = append(events, NotificationEvent{
					Type:    "comment",
					Title:   fmt.Sprintf("New comment on %q", hit.Title),
					Body:    excerpt(c.Value, 200),
					URL:     link,
					Board:   hit.Board.Name,
					Author:  c.Author.Name,
					Excerpt: excerpt(c.Value, 200),
					Created: c.Created,
				})
			}
		}
	}

	return events, maxSeen
}

// queryGateway replays the stored InstantSearch filter against the given index
// replica. When applyWatermark is true it adds a numeric filter on the
// registered created facet so only content newer than the watermark comes back.
func (d *Dispatcher) queryGateway(ctx context.Context, sub Subscription, indexName string, applyWatermark bool, hitsPerPage int) ([]json.RawMessage, error) {
	var params map[string]interface{}
	if err := json.Unmarshal([]byte(sub.FilterJSON), &params); err != nil || params == nil {
		params = map[string]interface{}{}
	}

	if applyWatermark {
		watermarkAttr := "post_created"
		if sub.Kind == "comment" {
			watermarkAttr = "comment_created"
		}
		watermarkFilter := fmt.Sprintf("%s > %d", watermarkAttr, sub.WatermarkMS)
		existing, _ := params["numericFilters"].([]interface{})
		params["numericFilters"] = append(existing, watermarkFilter)
	}
	params["page"] = 0
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
	// trim leading/trailing single space
	res := string(out)
	if len(res) > 0 && res[0] == ' ' {
		res = res[1:]
	}
	if len(res) > 0 && res[len(res)-1] == ' ' {
		res = res[:len(res)-1]
	}
	return res
}
