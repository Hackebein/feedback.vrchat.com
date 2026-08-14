export type FacetEntry = { value: string; count: number };

export type NestedBoardNode = {
  value: string;
  count: number;
  children: FacetEntry[];
};

/** Display-only parent → child board names. Filters stay exclusive. */
export const BOARD_SUBBOARDS: Readonly<Record<string, readonly string[]>> = {
  "Bug Reports": ["In-Client Bug Reporting"],
};

function childNamesOf(parent: string): readonly string[] {
  return BOARD_SUBBOARDS[parent] ?? [];
}

function childSet(): Set<string> {
  const names = new Set<string>();
  for (const children of Object.values(BOARD_SUBBOARDS)) {
    for (const child of children) {
      names.add(child);
    }
  }
  return names;
}

/** Pull configured children out of the top-level list and attach them under their parent. */
export function nestBoardFacetEntries(entries: FacetEntry[]): NestedBoardNode[] {
  const children = childSet();
  const byValue = new Map(entries.map((entry) => [entry.value, entry]));
  const nodes: NestedBoardNode[] = [];
  const seenParents = new Set<string>();

  for (const entry of entries) {
    if (children.has(entry.value)) {
      continue;
    }
    seenParents.add(entry.value);
    nodes.push({
      value: entry.value,
      count: entry.count,
      children: childNamesOf(entry.value).map(
        (name) => byValue.get(name) ?? { value: name, count: 0 },
      ),
    });
  }

  for (const [parent, childNames] of Object.entries(BOARD_SUBBOARDS)) {
    if (seenParents.has(parent)) {
      continue;
    }
    const attached = childNames
      .map((name) => byValue.get(name))
      .filter((entry): entry is FacetEntry => entry != null);
    if (attached.length === 0) {
      continue;
    }
    nodes.push({
      value: parent,
      count: byValue.get(parent)?.count ?? 0,
      children: attached,
    });
  }

  return nodes;
}

/** Keep a parent when it or any child matches; unmatched siblings of a matching child are dropped. */
export function filterNestedBoardNodes(
  nodes: NestedBoardNode[],
  search: string,
): NestedBoardNode[] {
  const needle = search.trim().toLowerCase();
  if (!needle) {
    return nodes;
  }
  const out: NestedBoardNode[] = [];
  for (const node of nodes) {
    const parentHit = node.value.toLowerCase().includes(needle);
    const matchingChildren = node.children.filter((child) =>
      child.value.toLowerCase().includes(needle),
    );
    if (parentHit) {
      out.push(node);
    } else if (matchingChildren.length > 0) {
      out.push({ ...node, children: matchingChildren });
    }
  }
  return out;
}
