import tree from "../../feature_tree.json" with { type: "json" };

type Bucket = { id: string; description?: string };
type Location = { id: string; name?: string; description?: string };
type FeatureNode = {
  id: string;
  name?: string;
  description?: string;
  children?: FeatureNode[];
};

type TreeFile = {
  buckets?: Bucket[];
  locations?: Location[];
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

const INCLIENT_FIELD_LABELS: Record<string, string> = {
  "inclient.category": "Category",
  "inclient.frequency": "Frequency",
  "inclient.platform": "Platform",
  "inclient.store": "Store",
  "inclient.headset": "Headset",
  "inclient.raw-platform": "Raw Platform",
};

function inclientCategoryName(id: string): string | undefined {
  if (!id.startsWith("inclient.")) {
    return undefined;
  }
  if (id === "inclient.report") {
    return "In-Client Report";
  }
  if (id.startsWith("inclient.client-version.")) {
    return `Client ${id.slice("inclient.client-version.".length)}`;
  }
  if (id.startsWith("inclient.unity-version.")) {
    return `Unity ${id.slice("inclient.unity-version.".length)}`;
  }
  for (const [prefix, label] of Object.entries(INCLIENT_FIELD_LABELS)) {
    const head = `${prefix}.`;
    if (id.startsWith(head)) {
      return `${label}: ${titleizeId(id.slice(head.length))}`;
    }
  }
  return titleizeId(id.slice("inclient.".length));
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

  if (Array.isArray(data.locations)) {
    for (const loc of data.locations) {
      if (!loc?.id?.trim()) continue;
      const name =
        typeof loc.name === "string" && loc.name.trim()
          ? loc.name.trim()
          : titleizeId(loc.id);
      const desc =
        typeof loc.description === "string" && loc.description.trim()
          ? loc.description.trim()
          : "";
      map.set(loc.id, { name, description: desc });
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
  return inclientCategoryName(trimmed) ?? titleizeId(trimmed);
}

export function aiCategoryDescription(id: string): string | undefined {
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  const row = lookup.get(trimmed);
  const d = row?.description?.trim();
  return d || undefined;
}
