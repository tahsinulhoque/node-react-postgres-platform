const SEARCH_URL = process.env.SEARCH_URL || "http://localhost:9200";
const INDEX = "items";

export async function searchHealth() {
  const res = await fetch(`${SEARCH_URL}/_cluster/health`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  return res.json();
}

export async function indexItem(item) {
  const res = await fetch(`${SEARCH_URL}/${INDEX}/_doc/${item.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: item.id,
      name: item.name,
      created_at: item.created_at,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`indexing failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function searchItems(query) {
  const url = new URL(`${SEARCH_URL}/${INDEX}/_search`);
  url.searchParams.set("q", `name:${query}`);
  url.searchParams.set("size", "50");

  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return data.hits.hits.map((hit) => hit._source);
}
