import { FetchError, type FileHost } from './host';
import { MANIFEST_NAME } from './manifest';

/** A release as listed by the GitHub API (only the fields we use). */
export interface Release {
  tag: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  date: string;
  /** Release notes (markdown), shown as plain text. */
  body: string;
  assets: { name: string; url: string; size: number }[];
}

/** Releases per page of the listing; a full page means there may be more. */
export const RELEASES_PER_PAGE = 30;

/**
 * One page of a repo's releases, newest first. The browser's HTTP cache revalidates repeats
 * with the ETag GitHub sends, and a 304 doesn't count against the 60/hour limit (SPEC §7.2).
 */
export async function listReleases(
  host: FileHost,
  owner: string,
  repo: string,
  page = 1,
): Promise<Release[]> {
  const raw = await host.fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
  );
  if (!Array.isArray(raw)) throw new FetchError('unexpected answer from GitHub');
  return raw.map((r: Record<string, unknown>) => ({
    tag: String(r.tag_name ?? ''),
    name: String(r.name || r.tag_name || ''),
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    date: String(r.published_at ?? '').slice(0, 10),
    body: String(r.body ?? ''),
    assets: (Array.isArray(r.assets) ? r.assets : []).map((a: Record<string, unknown>) => ({
      name: String(a.name ?? ''),
      url: String(a.browser_download_url ?? ''),
      size: Number(a.size ?? 0),
    })),
  }));
}

/** The requested tag, else the latest full release, else the newest of any kind. */
export function defaultRelease(releases: Release[], tag: string | null): number {
  if (tag) {
    const i = releases.findIndex((r) => r.tag === tag);
    if (i >= 0) return i;
  }
  const full = releases.findIndex((r) => !r.draft && !r.prerelease);
  return full >= 0 ? full : releases.length ? 0 : -1;
}

/** The release's manifest asset (`esp-web-tool.json`). */
export function manifestAsset(release: Release): Release['assets'][number] | null {
  return release.assets.find((x) => x.name === MANIFEST_NAME) ?? null;
}

/**
 * Release files can't be fetched by a page (GitHub sends no CORS header, SPEC §2), so they go
 * through the asset proxy when one is configured: `<proxy>/<owner>/<repo>/releases/download/…`.
 * Keeping the path means bins relative to a proxied manifest resolve to the same release.
 */
export function viaProxy(url: string, proxy: string | undefined): string | null {
  if (!proxy) return null;
  const u = new URL(url);
  if (u.hostname !== 'github.com') return url;
  return proxy.replace(/\/$/, '') + u.pathname;
}
