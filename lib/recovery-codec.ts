/** Lossless JSON string interning for private recovery records, not encryption.
 * Keeps repeated catalog text/keys once while retaining exact snapshots and receipts.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_EXPANDED_CHARS = 16_000_000;
const MAX_NODES = 500_000;
const invalid = (): never => {
  throw new Error("PENDING_DATA_INVALID");
};

export function packRecovery(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > MAX_EXPANDED_CHARS)
    throw new Error("PENDING_DATA_TOO_LARGE");
  const json = JSON.parse(serialized) as Json;
  const strings: string[] = [];
  const indices = new Map<string, number>();
  const intern = (text: string) => {
    let index = indices.get(text);
    if (index === undefined) {
      index = strings.length;
      strings.push(text);
      indices.set(text, index);
    }
    return index;
  };
  let nodes = 0;
  const encode = (node: Json, depth = 0): unknown => {
    if (++nodes > MAX_NODES || depth > 128)
      throw new Error("PENDING_DATA_TOO_LARGE");
    if (typeof node === "string") return ["s", intern(node)];
    if (Array.isArray(node))
      return ["a", node.map((v) => encode(v, depth + 1))];
    if (node !== null && typeof node === "object")
      return [
        "o",
        Object.entries(node).map(([key, v]) => [
          intern(key),
          encode(v, depth + 1),
        ]),
      ];
    return node;
  };
  const root = encode(json);
  return { strings, root };
}

export function unpackRecovery(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const value = raw as { strings?: unknown; root?: unknown };
  if (
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.strings) ||
    !value.strings.every((s) => typeof s === "string")
  )
    return invalid();
  const strings = value.strings as string[];
  let chars = 0,
    nodes = 0;
  const text = (index: unknown) => {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= strings.length
    )
      return invalid();
    const result = strings[index];
    chars += result.length;
    if (chars > MAX_EXPANDED_CHARS) return invalid();
    return result;
  };
  const decode = (node: unknown, depth = 0): Json => {
    if (++nodes > MAX_NODES || depth > 128) return invalid();
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (!Array.isArray(node) || node.length !== 2) return invalid();
    if (node[0] === "s") return text(node[1]);
    if (!Array.isArray(node[1])) return invalid();
    if (node[0] === "a") return node[1].map((v) => decode(v, depth + 1));
    if (node[0] === "o") {
      const keys = new Set<string>();
      return Object.fromEntries(
        node[1].map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length !== 2) return invalid();
          const key = text(entry[0]);
          if (keys.has(key)) return invalid();
          keys.add(key);
          return [key, decode(entry[1], depth + 1)];
        }),
      );
    }
    return invalid();
  };
  return decode(value.root);
}
