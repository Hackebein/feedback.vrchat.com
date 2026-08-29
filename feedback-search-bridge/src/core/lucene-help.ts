export type LuceneHelpRow = {
  field: string;
  kind: string;
  example: string;
};

export const LUCENE_HELP_ROWS: LuceneHelpRow[] = [
  { field: "aiCategories", kind: "text", example: "aiCategories:groups" },
  {
    field: "aiCategories.keyword",
    kind: "keyword",
    example: 'aiCategories.keyword:"groups.calendar"',
  },
  {
    field: "aiTaggedAt",
    kind: "date",
    example: 'aiTaggedAt:["2025-01-01" TO "*"]',
  },
  { field: "author.name", kind: "text", example: "author.name:Alice" },
  {
    field: "author.name.keyword",
    kind: "keyword",
    example: 'author.name.keyword:"Jane Doe"',
  },
  { field: "board.name", kind: "text", example: "board.name:bug" },
  {
    field: "board.name.keyword",
    kind: "keyword",
    example: 'board.name.keyword:"Feature Requests"',
  },
  { field: "board.urlName", kind: "keyword", example: "board.urlName:bug-reports" },
  { field: "category.name", kind: "text", example: "category.name:sdk" },
  {
    field: "category.name.keyword",
    kind: "keyword",
    example: "category.name.keyword:SDK",
  },
  { field: "combined_text", kind: "text", example: "combined_text:performance" },
  { field: "commentCount", kind: "numeric", example: "commentCount:[1 TO 50]" },
  { field: "comments.author.name", kind: "text", example: "comments.author.name:Alice" },
  {
    field: "comments.author.name.keyword",
    kind: "keyword",
    example: 'comments.author.name.keyword:"Jane Doe"',
  },
  {
    field: "comments.created",
    kind: "date",
    example: 'comments.created:["2025-01-01" TO "*"]',
  },
  { field: "comments.likeCount", kind: "numeric", example: "comments.likeCount:[1 TO *]" },
  { field: "comments.pinned", kind: "keyword", example: "comments.pinned:true" },
  { field: "comments.value", kind: "text", example: 'comments.value:"network lag"' },
  {
    field: "created",
    kind: "date",
    example: 'created:["2025-01-01" TO "2026-01-01"]',
  },
  { field: "details", kind: "text", example: 'details:"network lag"' },
  { field: "maxScore", kind: "numeric", example: "maxScore:[100 TO *]" },
  { field: "mergeCount", kind: "numeric", example: "mergeCount:[1 TO *]" },
  { field: "score", kind: "numeric", example: "score:[10 TO *]" },
  { field: "status", kind: "keyword", example: "status:open" },
  {
    field: "statusChanged",
    kind: "date",
    example: 'statusChanged:["2025-01-01" TO "*"]',
  },
  { field: "title", kind: "text", example: "title:avatar" },
  { field: "trendingScore", kind: "numeric", example: "trendingScore:[500 TO *]" },
  {
    field: "updatedAt",
    kind: "date",
    example: 'updatedAt:["2025-01-01" TO "*"]',
  },
  { field: "voters.name", kind: "text", example: "voters.name:Alice" },
  {
    field: "voters.name.keyword",
    kind: "keyword",
    example: 'voters.name.keyword:"Jane Doe"',
  },
  {
    field: "voteSettings.highEngagement",
    kind: "keyword/bool-like",
    example: "voteSettings.highEngagement:true",
  },
  {
    field: "voteSettings.lowEngagement",
    kind: "keyword/bool-like",
    example: "voteSettings.lowEngagement:true",
  },
  {
    field: "voteSettings.moderateEngagement",
    kind: "keyword/bool-like",
    example: "voteSettings.moderateEngagement:true",
  },
];

export const LUCENE_HELP_INTRO = [
  "Check Lucene for field:value queries; uncheck for plain keyword search with filters.",
  "Use field:value in the search box. Quotes for phrases. [min TO max] for ranges.",
  "comments.* and voters.* match if any nested comment/voter satisfies the clause.",
  "Bare terms search combined title, body, and author name.",
];

export const SORT_HELP = [
  "Pick a sort with the dropdown next to the search box or in the filter sidebar.",
  "With a search query, Relevance is used until you pick another sort.",
  "Newest — most recently created posts first (default when not searching).",
  "Oldest — earliest created posts first.",
  "Newest activity / Oldest activity — sort by last update.",
  "Most voters / Fewest voters — sort by vote count.",
  "Relevance — best match to your search query.",
];
