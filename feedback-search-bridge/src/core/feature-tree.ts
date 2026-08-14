import tree from "../../../feature_tree.json";

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
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
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

function visitFeatures(node: FeatureNode, map: Map<string, string>): void {
  const name =
    typeof node.name === "string" && node.name.trim()
      ? node.name.trim()
      : titleizeId(node.id);
  map.set(node.id, name);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visitFeatures(child, map);
    }
  }
}

function buildLookup(): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(data.buckets)) {
    for (const bucket of data.buckets) {
      if (bucket?.id?.trim()) {
        map.set(bucket.id, titleizeId(bucket.id));
      }
    }
  }
  if (Array.isArray(data.locations)) {
    for (const loc of data.locations) {
      if (loc?.id?.trim()) {
        map.set(
          loc.id,
          typeof loc.name === "string" && loc.name.trim()
            ? loc.name.trim()
            : titleizeId(loc.id),
        );
      }
    }
  }
  if (Array.isArray(data.features)) {
    for (const feature of data.features) {
      visitFeatures(feature, map);
    }
  }
  return map;
}

const lookup = buildLookup();

/** Maps an internal AI-category id (e.g. "loc.in-world") to its display name. */
export function aiCategoryName(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return id;
  }
  return inclientCategoryName(trimmed) ?? lookup.get(trimmed) ?? titleizeId(trimmed);
}
