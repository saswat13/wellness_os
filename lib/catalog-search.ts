/** Shared catalog and custom entries use the same accent/punctuation-insensitive search. */
export function matchesCatalogSearch(
  query: string,
  values: Array<string | null | undefined>,
) {
  const normalize = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const text = normalize(values.filter(Boolean).join(" "));
  return normalize(query)
    .split(/\s+/)
    .every((token) => text.includes(token));
}
