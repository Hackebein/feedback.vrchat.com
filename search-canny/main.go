package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	apiURL = "https://feedback.vrchat.com/api/posts/get"

	stdinWorkers    = 8  // parallel seed queries from stdin
	queueWorkers    = 16 // parallel AND-split jobs per board collect
	httpConcurrency = 64 // max in-flight HTTP requests

	maxBackoff   = time.Minute
	saveInterval = 30 * time.Second
	maxAttempts  = 3 // total tries per search on non-429 errors
)

func boardOutputFile(board string) string {
	return "url-names-" + board + ".txt"
}

var (
	boards = []string{"feature-requests"}
	// Default ranking first (empty = omit sort). Extra sorts surface posts past the 500 cap.
	sorts   = []string{"", "newest", "oldest", "score", "trendingScore"}
	httpSem = make(chan struct{}, httpConcurrency)
	client  = &http.Client{Timeout: 60 * time.Second}
)

type requestBody struct {
	Pages         int      `json:"pages"`
	TextSearch    string   `json:"textSearch"`
	BoardURLNames []string `json:"boardURLNames"`
	Sort          string   `json:"sort,omitempty"`
}

type post struct {
	URLName string `json:"urlName"`
	Title   string `json:"title"`
}

type responseBody struct {
	Result struct {
		HasNextPage bool   `json:"hasNextPage"`
		Posts       []post `json:"posts"`
	} `json:"result"`
}

type job struct {
	query string // canonical word-set query
	depth int
}

type nameStore struct {
	mu    sync.Mutex
	names map[string]struct{}
	dirty bool
}

// progress holds run-wide counters for stderr (not per-worker snapshots).
type progress struct {
	mu       sync.Mutex
	done     int64
	inflight int64
	queued   int64
}

func (p *progress) addQueued(n int) {
	if n == 0 {
		return
	}
	p.mu.Lock()
	p.queued += int64(n)
	if p.queued < 0 {
		p.queued = 0
	}
	p.mu.Unlock()
}

func (p *progress) takeQueued() {
	p.mu.Lock()
	p.queued--
	p.mu.Unlock()
}

func (p *progress) startSearch() {
	p.mu.Lock()
	p.inflight++
	p.mu.Unlock()
}

func (p *progress) finishSearch(query, board string, added, unique int) {
	p.mu.Lock()
	p.inflight--
	p.done++
	done, inflight, queued := p.done, p.inflight, p.queued
	p.mu.Unlock()
	fmt.Fprintf(os.Stderr,
		"done=%d inflight=%d queued=%d [%s] unique=%d (+%d) %q\n",
		done, inflight, queued, board, unique, added, query)
}

func main() {
	stores := make(map[string]*nameStore, len(boards))
	for _, board := range boards {
		path := boardOutputFile(board)
		store, err := loadStore(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "load %s: %v\n", path, err)
			os.Exit(1)
		}
		stores[board] = store
		fmt.Fprintf(os.Stderr, "loaded %d urlNames from %s\n", store.len(), path)
	}

	stopSaver := make(chan struct{})
	var saverWG sync.WaitGroup
	saverWG.Add(1)
	go func() {
		defer saverWG.Done()
		t := time.NewTicker(saveInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				saveAllStores(stores)
			case <-stopSaver:
				return
			}
		}
	}()

	var searched sync.Map // board\x00canonicalQuery -> struct{}
	var prog progress

	var (
		wg       sync.WaitGroup
		errMu    sync.Mutex
		firstErr error
		stdinSem = make(chan struct{}, stdinWorkers)
		seedSeen = make(map[string]struct{})
	)

	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		query := canonicalQuery(sc.Text())
		if query == "" {
			continue
		}
		if _, ok := seedSeen[query]; ok {
			continue
		}
		seedSeen[query] = struct{}{}

		errMu.Lock()
		err := firstErr
		errMu.Unlock()
		if err != nil {
			break
		}

		wg.Add(1)
		stdinSem <- struct{}{}
		go func(query string) {
			defer wg.Done()
			defer func() { <-stdinSem }()

			var boardWG sync.WaitGroup
			var boardMu sync.Mutex
			var boardErr error

			for _, board := range boards {
				boardWG.Add(1)
				go func(board string) {
					defer boardWG.Done()
					if err := collect(query, board, stores[board], &searched, &prog); err != nil {
						boardMu.Lock()
						if boardErr == nil {
							boardErr = fmt.Errorf("%q [%s]: %w", query, board, err)
						}
						boardMu.Unlock()
					}
				}(board)
			}
			boardWG.Wait()

			if boardErr != nil {
				errMu.Lock()
				if firstErr == nil {
					firstErr = boardErr
				}
				errMu.Unlock()
			}
		}(query)
	}
	wg.Wait()

	close(stopSaver)
	saverWG.Wait()

	saveAllStores(stores)
	for _, board := range boards {
		path := boardOutputFile(board)
		fmt.Fprintf(os.Stderr, "have %d urlNames in %s\n", stores[board].len(), path)
	}

	if err := sc.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "stdin: %v\n", err)
		os.Exit(1)
	}
	if firstErr != nil {
		fmt.Fprintln(os.Stderr, firstErr)
		os.Exit(1)
	}
}

func saveAllStores(stores map[string]*nameStore) {
	for _, board := range boards {
		path := boardOutputFile(board)
		if err := stores[board].saveIfDirty(path); err != nil {
			fmt.Fprintf(os.Stderr, "save %s: %v\n", path, err)
		}
	}
}

func loadStore(path string) (*nameStore, error) {
	s := &nameStore{names: make(map[string]struct{})}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name := strings.TrimSpace(sc.Text())
		if name != "" {
			s.names[name] = struct{}{}
		}
	}
	return s, sc.Err()
}

func (s *nameStore) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.names)
}

func (s *nameStore) addAll(found map[string]struct{}) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	added := 0
	for name := range found {
		if name == "" {
			continue
		}
		if _, ok := s.names[name]; ok {
			continue
		}
		s.names[name] = struct{}{}
		added++
		s.dirty = true
	}
	return added
}

func (s *nameStore) saveIfDirty(path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return nil
	}
	if err := writeNames(path, s.names); err != nil {
		return err
	}
	s.dirty = false
	fmt.Fprintf(os.Stderr, "saved %d urlNames to %s\n", len(s.names), path)
	return nil
}

func writeNames(path string, names map[string]struct{}) error {
	out := make([]string, 0, len(names))
	for name := range names {
		out = append(out, name)
	}
	sort.Strings(out)

	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".url-names-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			os.Remove(tmpName)
		}
	}()

	w := bufio.NewWriter(tmp)
	for _, name := range out {
		if _, err := fmt.Fprintln(w, name); err != nil {
			tmp.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	ok = true
	return nil
}

// canonicalQuery lowercases, splits on whitespace, dedupes, and sorts words
// so "local avatar" and "avatar local" are the same query.
func canonicalQuery(q string) string {
	fields := strings.Fields(strings.ToLower(q))
	if len(fields) == 0 {
		return ""
	}
	sort.Strings(fields)
	uniq := make([]string, 0, len(fields))
	var prev string
	for i, w := range fields {
		if i > 0 && w == prev {
			continue
		}
		uniq = append(uniq, w)
		prev = w
	}
	return strings.Join(uniq, " ")
}

func claimQuery(searched *sync.Map, board, query string) bool {
	key := board + "\x00" + query
	_, loaded := searched.LoadOrStore(key, struct{}{})
	return !loaded
}

// collect gathers urlNames for query on board. The API never returns a match
// total—only hasNextPage—so when sorts still leave the set incomplete, we
// AND-split by appending title words (each extra word must also match).
func collect(query, board string, store *nameStore, searched *sync.Map, prog *progress) error {
	query = canonicalQuery(query)
	if query == "" {
		return nil
	}

	var (
		mu       sync.Mutex
		queue    = []job{{query: query, depth: 0}}
		inFlight int
		fatalErr error
	)
	prog.addQueued(1)
	cond := sync.NewCond(&mu)

	var wg sync.WaitGroup
	wg.Add(queueWorkers)
	for i := 0; i < queueWorkers; i++ {
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				for len(queue) == 0 && inFlight > 0 && fatalErr == nil {
					cond.Wait()
				}
				if fatalErr != nil || (len(queue) == 0 && inFlight == 0) {
					mu.Unlock()
					return
				}
				j := queue[0]
				queue = queue[1:]
				prog.takeQueued()
				if !claimQuery(searched, board, j.query) {
					mu.Unlock()
					continue
				}
				inFlight++
				mu.Unlock()

				prog.startSearch()
				found, titles, incomplete, err := searchAllSorts(j.query, board)

				mu.Lock()
				inFlight--
				if err != nil {
					prog.finishSearch(j.query, board, 0, store.len())
					if fatalErr == nil {
						fatalErr = err
					}
					cond.Broadcast()
					mu.Unlock()
					return
				}
				added := store.addAll(found)
				prog.finishSearch(j.query, board, added, store.len())

				if incomplete && !(j.depth > 0 && added == 0) {
					children := 0
					for _, word := range splitWords(titles, j.query) {
						child := canonicalQuery(j.query + " " + word)
						if child == "" || child == j.query {
							continue
						}
						queue = append(queue, job{query: child, depth: j.depth + 1})
						children++
					}
					prog.addQueued(children)
				}
				cond.Broadcast()
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	left := len(queue)
	mu.Unlock()
	if left > 0 {
		prog.addQueued(-left)
	}
	return fatalErr
}

func searchAllSorts(query, board string) (map[string]struct{}, []string, bool, error) {
	names := make(map[string]struct{})
	var titles []string

	posts, hasNext, err := search(query, board, sorts[0])
	if err != nil {
		return nil, nil, false, err
	}
	for _, p := range posts {
		if p.URLName != "" {
			names[p.URLName] = struct{}{}
		}
		if p.Title != "" {
			titles = append(titles, p.Title)
		}
	}
	if !hasNext {
		return names, titles, false, nil
	}

	type sortResult struct {
		posts   []post
		hasNext bool
		err     error
	}
	remaining := sorts[1:]
	results := make([]sortResult, len(remaining))
	var wg sync.WaitGroup
	for i, sortBy := range remaining {
		wg.Add(1)
		go func(i int, sortBy string) {
			defer wg.Done()
			posts, hasNext, err := search(query, board, sortBy)
			results[i] = sortResult{posts: posts, hasNext: hasNext, err: err}
		}(i, sortBy)
	}
	wg.Wait()

	incomplete := true
	for _, r := range results {
		if r.err != nil {
			return nil, nil, false, r.err
		}
		for _, p := range r.posts {
			if p.URLName != "" {
				names[p.URLName] = struct{}{}
			}
			if p.Title != "" {
				titles = append(titles, p.Title)
			}
		}
		if !r.hasNext {
			incomplete = false
		}
	}
	return names, titles, incomplete, nil
}

func splitWords(titles []string, query string) []string {
	inQuery := make(map[string]struct{})
	for _, w := range strings.Fields(query) {
		inQuery[w] = struct{}{}
	}

	freq := make(map[string]int)
	for _, title := range titles {
		seen := make(map[string]struct{})
		for _, w := range tokenizeTitle(title) {
			if _, skip := inQuery[w]; skip {
				continue
			}
			if _, ok := seen[w]; ok {
				continue
			}
			seen[w] = struct{}{}
			freq[w]++
		}
	}

	type pair struct {
		word string
		n    int
	}
	pairs := make([]pair, 0, len(freq))
	for w, n := range freq {
		pairs = append(pairs, pair{w, n})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].n != pairs[j].n {
			return pairs[i].n > pairs[j].n
		}
		return pairs[i].word < pairs[j].word
	})

	out := make([]string, len(pairs))
	for i, p := range pairs {
		out[i] = p.word
	}
	return out
}

func tokenizeTitle(title string) []string {
	var out []string
	var b strings.Builder
	flush := func() {
		w := b.String()
		b.Reset()
		if w == "" {
			return
		}
		for _, r := range w {
			if !unicode.IsLetter(r) {
				return
			}
		}
		out = append(out, w)
	}
	for _, r := range strings.ToLower(title) {
		if unicode.IsLetter(r) {
			b.WriteRune(r)
			continue
		}
		flush()
	}
	flush()
	return out
}

func search(query, board, sortBy string) ([]post, bool, error) {
	backoff429 := time.Second
	attempt := 0
	for {
		posts, hasNext, status, retryAfter, err := doSearch(query, board, sortBy)
		if status == http.StatusTooManyRequests {
			wait := backoff429
			if retryAfter > 0 {
				wait = retryAfter
			}
			fmt.Fprintf(os.Stderr, "429 for %q [%s] sort=%q; sleeping %s\n",
				query, board, sortBy, wait)
			time.Sleep(wait)
			if backoff429 < maxBackoff {
				backoff429 *= 2
				if backoff429 > maxBackoff {
					backoff429 = maxBackoff
				}
			}
			continue
		}
		if err == nil && status == http.StatusOK {
			return posts, hasNext, nil
		}

		attempt++
		var cause error
		if err != nil {
			cause = err
		} else {
			cause = fmt.Errorf("HTTP %d", status)
		}
		if attempt >= maxAttempts {
			return nil, false, cause
		}
		wait := time.Duration(attempt) * time.Second
		fmt.Fprintf(os.Stderr, "%v for %q [%s] sort=%q; retry %d/%d sleeping %s\n",
			cause, query, board, sortBy, attempt, maxAttempts, wait)
		time.Sleep(wait)
	}
}

func doSearch(query, board, sortBy string) ([]post, bool, int, time.Duration, error) {
	body, err := json.Marshal(requestBody{
		Pages:         50,
		TextSearch:    query,
		BoardURLNames: []string{board},
		Sort:          sortBy,
	})
	if err != nil {
		return nil, false, 0, 0, err
	}

	req, err := http.NewRequest(http.MethodPost, apiURL, bytes.NewReader(body))
	if err != nil {
		return nil, false, 0, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; FeedbackSearch/1.0)")

	httpSem <- struct{}{}
	resp, err := client.Do(req)
	if err != nil {
		<-httpSem
		return nil, false, 0, 0, err
	}
	defer func() {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		<-httpSem
	}()

	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, false, resp.StatusCode, parseRetryAfter(resp), nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, false, resp.StatusCode, 0, nil
	}

	var parsed responseBody
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, false, resp.StatusCode, 0, err
	}
	return parsed.Result.Posts, parsed.Result.HasNextPage, resp.StatusCode, 0, nil
}

func parseRetryAfter(resp *http.Response) time.Duration {
	v := resp.Header.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		if secs < 0 {
			return 0
		}
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil {
		d := time.Until(t)
		if d > 0 {
			return d
		}
	}
	return 0
}
