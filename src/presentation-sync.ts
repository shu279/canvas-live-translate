/**
 * Reconcile an inert reading copy without replacing its scroll container or
 * resetting already translated Text nodes. Snapshots describe the ORIGINAL
 * source; the copy's current text may be English and is never used as a key.
 */
export type PreparePresentationNode = (source: ChildNode) => Node | null;

interface Description {
  source: ChildNode;
  prepared: Node;
  kind: string;
  fingerprint: string;
  key?: string;
  text: string | null;
  children: Description[];
}

interface Entry {
  source: ChildNode;
  node: Node;
  kind: string;
  fingerprint: string;
  key?: string;
  text: string | null;
  children: Entry[];
}

interface Plan {
  description: Description;
  entry: Entry;
  children: Plan[];
}

function kindOf(node: Node): string {
  return node.nodeType === 1
    ? `1:${(node as Element).namespaceURI ?? ""}:${(node as Element).tagName}` : String(node.nodeType);
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(36);
}

function semanticAttributes(node: Element): string {
  return ["id", "data-line", "data-source", "data-heading", "href", "data-href", "src"]
    .map(name => `${name}=${node.getAttribute(name) ?? ""}`).join("\u0000");
}

function stableKey(node: Element): string | undefined {
  for (const name of ["id", "data-line", "data-source", "data-heading"]) {
    const value = node.getAttribute(name);
    if (value) return `${name}:${value}`;
  }
  return undefined;
}

export class PresentationSync {
  private entries: Entry[] = [];
  private originals = new WeakMap<Node, Node>();

  constructor(private readonly target: HTMLElement) {}

  /**
   * prepare returns a SHALLOW sanitized clone. Returning null excludes the
   * whole source subtree. Recursing here keeps sourceFor exact even when
   * scripts/editors/form controls have been omitted from the presentation.
   */
  sync(sources: readonly ChildNode[], prepare: PreparePresentationNode): void {
    const newSources = new Set<Node>();
    const describe = (source: ChildNode): Description | null => {
      const prepared = prepare(source);
      if (!prepared) return null;
      // Do not allow a callback to accidentally make the reading copy own a
      // native source node. The contract is a clone, but a defensive copy is
      // cheap here and guarantees that reconciliation never rewrites source.
      const node = prepared === source ? prepared.cloneNode(false) : prepared;
      while (node.firstChild) node.removeChild(node.firstChild);
      newSources.add(source);
      const children = Array.from(source.childNodes).map(describe)
        .filter((child): child is Description => child !== null);
      const kind = kindOf(node);
      const text = node.nodeType === 3 || node.nodeType === 8 ? node.nodeValue : null;
      const intrinsic = node.nodeType === 1 ? semanticAttributes(node as Element) : text ?? "";
      return {
        source, prepared: node, kind, text, children,
        key: node.nodeType === 1 ? stableKey(node as Element) : undefined,
        fingerprint: `${kind}:${hash(`${intrinsic}\u0001${children.map(child => child.fingerprint).join("\u0002")}`)}`
      };
    };
    const descriptions = sources.map(describe).filter((node): node is Description => node !== null);
    const previousBySource = new Map<Node, Entry>();
    const indexPrevious = (entry: Entry) => {
      previousBySource.set(entry.source, entry);
      entry.children.forEach(indexPrevious);
    };
    this.entries.forEach(indexPrevious);
    const used = new Set<Entry>();

    const planChildren = (next: Description[], previous: Entry[]): Plan[] => {
      const chosen: Array<Entry | undefined> = new Array(next.length);
      const byFingerprint = new Map<string, Entry[]>();
      const byKey = new Map<string, Entry[]>();
      for (const entry of previous) {
        const matching = byFingerprint.get(entry.fingerprint) ?? [];
        matching.push(entry); byFingerprint.set(entry.fingerprint, matching);
        if (entry.key) {
          const key = `${entry.kind}:${entry.key}`;
          const keyed = byKey.get(key) ?? [];
          keyed.push(entry); byKey.set(key, keyed);
        }
      }
      const eligible = (entry: Entry | undefined, description: Description): entry is Entry =>
        Boolean(entry && !used.has(entry) && entry.kind === description.kind &&
          (!newSources.has(entry.source) || entry.source === description.source));
      const choose = (index: number, entry: Entry) => { chosen[index] = entry; used.add(entry); };
      const take = (bucket: Entry[] | undefined, description: Description): Entry | undefined => {
        while (bucket?.length) {
          const entry = bucket.shift()!;
          if (eligible(entry, description)) return entry;
        }
        return undefined;
      };

      // Reserve all surviving native identities before positional matching.
      // This also lets a paragraph move between source parents without losing
      // its translated copy; DOM placement happens only after the full plan.
      next.forEach((description, index) => {
        const entry = previousBySource.get(description.source);
        if (eligible(entry, description)) choose(index, entry);
      });
      // Native preview renderers may replace an entire source subtree with an
      // equivalent one. Match original semantic content before edited nodes
      // can consume unchanged neighbours by their previous array position.
      next.forEach((description, index) => {
        if (chosen[index]) return;
        const entry = take(byFingerprint.get(description.fingerprint), description);
        if (entry) choose(index, entry);
      });
      next.forEach((description, index) => {
        if (chosen[index] || !description.key) return;
        const entry = take(byKey.get(`${description.kind}:${description.key}`), description);
        if (entry) choose(index, entry);
      });
      next.forEach((description, index) => {
        if (chosen[index]) return;
        const entry = eligible(previous[index], description) ? previous[index]
          : previous.find(candidate => eligible(candidate, description));
        if (entry) choose(index, entry);
      });
      return next.map((description, index) => {
        const entry = chosen[index] ?? {
          source: description.source, node: description.prepared, kind: description.kind,
          fingerprint: description.fingerprint, key: description.key,
          text: description.text, children: []
        };
        return { description, entry, children: planChildren(description.children, entry.children) };
      });
    };

    const plans = planChildren(descriptions, this.entries);
    const originals = new WeakMap<Node, Node>();
    const removals: Array<{ parent: Node; child: Node }> = [];
    const place = (parent: Node, children: Plan[]): Entry[] => {
      const wanted = new Set(children.map(plan => plan.entry.node));
      let cursor = parent.firstChild;
      // Insert/move the minimum number of children BEFORE removing obsolete
      // ones. Emptying a long preview first would clamp its scrollTop to zero.
      for (const plan of children) {
        const child = plan.entry.node;
        if (child === cursor) cursor = cursor.nextSibling;
        else parent.insertBefore(child, cursor);
      }
      const entries = children.map(apply);
      for (const child of Array.from(parent.childNodes)) {
        if (!wanted.has(child)) removals.push({ parent, child });
      }
      return entries;
    };
    const apply = (plan: Plan): Entry => {
      const { entry, description } = plan;
      const target = entry.node, prepared = description.prepared;
      if (target.nodeType === 1 && prepared.nodeType === 1) {
        const element = target as Element, nextElement = prepared as Element;
        for (const attribute of Array.from(element.attributes)) {
          if (!nextElement.hasAttributeNS(attribute.namespaceURI, attribute.localName)) {
            element.removeAttributeNS(attribute.namespaceURI, attribute.localName);
          }
        }
        for (const attribute of Array.from(nextElement.attributes)) {
          if (element.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value) {
            element.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
          }
        }
      } else if (entry.text !== description.text) {
        // Retain current English when original text is unchanged. An actual
        // source edit resets just this Text so the caller can translate it.
        target.nodeValue = description.text;
      }
      originals.set(target, description.source);
      entry.children = place(target, plan.children);
      entry.source = description.source;
      entry.kind = description.kind;
      entry.fingerprint = description.fingerprint;
      entry.key = description.key;
      entry.text = description.text;
      return entry;
    };
    this.entries = place(this.target, plans);
    // Finish all additions (including children of new wrappers) before any
    // removals, so a shorter empty intermediate tree never clamps scrolling.
    for (const { parent, child } of removals) {
      if (child.parentNode === parent) parent.removeChild(child);
    }
    this.originals = originals;
  }

  sourceFor(node: Node): Node | undefined { return this.originals.get(node); }
}
