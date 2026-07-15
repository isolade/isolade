// Local calendar day ("YYYY-MM-DD") for the usage time series. Local rather
// than UTC so a day's bucket matches the user's wall clock. This is a
// single-machine app, so server and client share a timezone. Lives in shared
// so the server (which buckets usage rows) and the web heatmap (which re-buckets
// them for display) derive the same key and can never drift apart.
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
