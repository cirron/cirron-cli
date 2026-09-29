/**
 * The web app origin paired with an API base URL.
 *
 * The CLI routes live on the API origin (`api.<host>`), while pages and the
 * trace-ingest route live on the web app (`app.<host>`). A host without the
 * `api.` prefix is returned as-is, for installs that serve both from one origin.
 *
 * @param apiUrl - The configured API base URL.
 * @returns The web app origin, or `apiUrl` unchanged when it does not parse.
 */
export function webOriginFor(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    url.hostname = url.hostname.replace(/^api\./, "app.");
    return url.origin;
  } catch {
    return apiUrl;
  }
}
