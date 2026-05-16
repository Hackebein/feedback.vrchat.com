import tree from "../../boards/_feature_tree.json" with { type: "json" };

type Bucket = { id: string; description?: string };
type FeatureNode = {
  id: string;
  name?: string;
  description?: string;
  children?: FeatureNode[];
};

type TreeFile = {
  buckets?: Bucket[];
  features?: FeatureNode[];
};

const data = tree as TreeFile;

function titleizeId(id: string): string {
  return id
    .split(/[.\-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function visitFeatures(node: FeatureNode, map: Map<string, { name: string; description: string }>) {
  const name =
    typeof node.name === "string" && node.name.trim()
      ? node.name.trim()
      : titleizeId(node.id);
  const desc =
    typeof node.description === "string" && node.description.trim()
      ? node.description.trim()
      : "";
  map.set(node.id, { name, description: desc });
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      visitFeatures(c, map);
    }
  }
}

function buildLookup(): Map<string, { name: string; description: string }> {
  const map = new Map<string, { name: string; description: string }>();

  if (Array.isArray(data.buckets)) {
    for (const b of data.buckets) {
      if (!b?.id?.trim()) continue;
      const name = titleizeId(b.id);
      const desc =
        typeof b.description === "string" && b.description.trim()
          ? b.description.trim()
          : "";
      map.set(b.id, { name, description: desc });
    }
  }

  if (Array.isArray(data.features)) {
    for (const f of data.features) {
      visitFeatures(f, map);
    }
  }

  return map;
}

const lookup = buildLookup();

export function aiCategoryName(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  const row = lookup.get(trimmed);
  if (row) return row.name;
  return titleizeId(trimmed);
}

export function aiCategoryDescription(id: string): string | undefined {
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  const row = lookup.get(trimmed);
  const d = row?.description?.trim();
  return d || undefined;
}
