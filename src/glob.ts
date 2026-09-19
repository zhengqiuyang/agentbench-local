/**
 * Minimal glob -> RegExp matcher (no dependencies).
 *
 * Supported syntax: `*` (any chars except /), `?` (one char except /),
 * `**` (any chars including /). Character classes are not supported.
 * A pattern containing no `/` is matched against the basename only
 * (gitignore-style convenience); otherwise it is matched against the full
 * `/`-separated path. Paths are normalized to `/` before matching.
 */

function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch;
}

function compileInner(pat: string): string {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === '*') {
      if (pat[i + 1] === '*') {
        while (pat[i + 1] === '*') i++;
        if (pat[i + 1] === '/') {
          i++; // consume the '/': `**/` also matches zero directories
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

/** Compile a glob into a regex over the full `/`-separated path. */
export function globToRegExp(pattern: string): RegExp {
  const p = normalizePattern(pattern);
  return new RegExp(`^${compileInner(p)}$`);
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True if the glob pattern contains a `/` (i.e. is path-anchored). */
export function isAnchored(pattern: string): boolean {
  return normalizePattern(pattern).includes('/');
}

export function matchGlob(pattern: string, filePath: string): boolean {
  const p = normalizePattern(filePath);
  if (isAnchored(pattern)) {
    return new RegExp(`^${compileInner(normalizePattern(pattern))}$`).test(p);
  }
  // basename match, gitignore-style
  const base = p.slice(p.lastIndexOf('/') + 1);
  return new RegExp(`^${compileInner(normalizePattern(pattern))}$`).test(base);
}

export function matchAny(patterns: string[], filePath: string): boolean {
  return patterns.some((pat) => matchGlob(pat, filePath));
}
