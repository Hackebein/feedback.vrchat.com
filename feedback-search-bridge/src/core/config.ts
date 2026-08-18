export const GATEWAY_ORIGIN = "https://vrchat-canny.hackebein.dev";
export const INDEX_NAME = "feedback-posts";
export const SEARCH_API_PATH = "/api/search";
export const INDEX_API_PATH = "/api/index";

export const STORAGE_KEYS = {
  luceneMode: "vrcfb.luceneMode",
  viewerVotes: "vrcfb.viewerVotes",
} as const;

/**
 * The index drops the scrape bot from `voters` and decrements `score` by this
 * amount. Restore it on Canny-facing counts so the vote button matches Canny.
 */
export const SCRAPER_VOTE_COUNT = 1;

export function cannyScoreFromIndex(score: number): number {
  return score + SCRAPER_VOTE_COUNT;
}

export function indexScoreFromCanny(score: number): number {
  return score - SCRAPER_VOTE_COUNT;
}
