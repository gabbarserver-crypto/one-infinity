// src/lib/fetchAll.js
//
// Supabase/PostgREST silently caps every response at the project's "Max
// Rows" setting (1000 by default) -- no error, the list just stops. Use
// fetchAllRows() for any query that can legitimately return more than that.
//
//   const { data, error, truncated } = await fetchAllRows(() =>
//     supabase.from("applications").select("...").eq(...).order("created_at").order("id")
//   );
//
// Rules:
//  - Pass a FUNCTION that builds a brand-new query each call (a Supabase
//    query builder is mutated by .range(), so one builder can't be reused
//    for several pages).
//  - The query must have a deterministic order that ends in a unique column
//    (e.g. .order("created_at").order("id")), otherwise rows can repeat or
//    go missing between pages.
//
// The first page is fetched alone (the common small result costs one
// request); if it's full, further pages are fetched in parallel waves.
// `truncated` is true only if `maxRows` was hit.
export async function fetchAllRows(buildQuery, { pageSize = 1000, maxRows = 200000, concurrency = 4 } = {}) {
  const first = await buildQuery().range(0, pageSize - 1);
  if (first.error) return { data: null, error: first.error, truncated: false };
  const all = [...(first.data || [])];
  if (all.length < pageSize) return { data: all, error: null, truncated: false };

  let next = pageSize;
  while (next < maxRows) {
    const wave = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => {
        const from = next + i * pageSize;
        return buildQuery().range(from, from + pageSize - 1);
      })
    );
    for (const { data, error } of wave) {
      if (error) return { data: null, error, truncated: false };
      all.push(...(data || []));
      if (!data || data.length < pageSize) return { data: all, error: null, truncated: false };
    }
    next += concurrency * pageSize;
  }
  return { data: all, error: null, truncated: true };
}
