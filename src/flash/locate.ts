import { MANIFEST_NAME } from './manifest';

/** What the Manifest field's text points at (SPEC §5.2, §7.1). */
export type Target =
  | { kind: 'github'; owner: string; repo: string; tag: string | null }
  | { kind: 'url'; url: string };

/** GitHub user names have no dots, so `example.com/fw` is a URL, not `owner/repo`. */
const SHORT_REPO = /^([A-Za-z0-9-]+)\/([\w.-]+)$/;

export function classify(text: string): Target | null {
  const t = text.trim();
  if (!t) return null;
  const short = SHORT_REPO.exec(t);
  if (short)
    return { kind: 'github', owner: short[1]!, repo: short[2]!.replace(/\.git$/, ''), tag: null };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const [owner, repo, section, kind, tag] = url.pathname.split('/').filter(Boolean);
    if (owner && repo && (!section || section === 'releases')) {
      const name = repo.replace(/\.git$/, '');
      if (section === 'releases' && kind === 'tag' && tag)
        return { kind: 'github', owner, repo: name, tag: decodeURIComponent(tag) };
      return { kind: 'github', owner, repo: name, tag: null };
    }
  }

  const href = url.href;
  if (/\.json$/i.test(url.pathname)) return { kind: 'url', url: href };
  // A folder: look for our manifest inside it.
  return { kind: 'url', url: `${href.endsWith('/') ? href : `${href}/`}${MANIFEST_NAME}` };
}
