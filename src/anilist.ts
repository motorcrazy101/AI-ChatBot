import axios from "axios";

/**
 * Small helper for AniList's free GraphQL API (no key needed).
 * Used as the backup when MyAnimeList's Jikan service is down or busy.
 */

export async function anilist<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { data } = await axios.post(
    "https://graphql.anilist.co",
    { query, variables },
    { headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 12_000 }
  );
  if (data?.errors?.length) throw new Error(data.errors[0].message ?? "AniList error");
  return data.data as T;
}

/** AniList descriptions contain bits of HTML; turn them into plain text. */
export function plainText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Short description of why a request failed, for the Railway logs. */
export function describeError(err: unknown): string {
  const e = err as { response?: { status?: number }; code?: string; message?: string };
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  return e?.code ?? e?.message ?? String(err);
}
