export function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    map.set(name, value);
  }
  return map;
}

export function splitSetCookieHeader(setCookie: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let inExpires = false;

  const pushCurrent = () => {
    const value = current.trim();
    if (value) {
      chunks.push(value);
    }
    current = '';
    inExpires = false;
  };

  for (let i = 0; i < setCookie.length; i += 1) {
    const char = setCookie[i]!;
    current += char;

    if (!inExpires && current.toLowerCase().endsWith('expires=')) {
      inExpires = true;
      continue;
    }

    if (char !== ',') {
      continue;
    }

    if (inExpires) {
      const rest = setCookie.slice(i + 1);
      if (/^\s*[^=\s;,]+=\S+/.test(rest)) {
        current = current.slice(0, -1);
        pushCurrent();
      }
      continue;
    }

    const rest = setCookie.slice(i + 1);
    if (/^\s*[^=\s;,]+=\S+/.test(rest)) {
      current = current.slice(0, -1);
      pushCurrent();
    }
  }

  pushCurrent();
  return chunks;
}

export function mergeCookieJar(existingCookie: string, setCookieHeader: string): string {
  const merged = parseCookieHeader(existingCookie);
  for (const raw of splitSetCookieHeader(setCookieHeader)) {
    const first = raw.split(';')[0]?.trim();
    if (!first) {
      continue;
    }
    const eq = first.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    merged.set(name, value);
  }
  return Array.from(merged.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

export function readCookieValue(cookie: string, key: string): string | undefined {
  for (const part of cookie.split(';')) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    const eq = segment.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = segment.slice(0, eq).trim();
    if (name !== key) {
      continue;
    }
    return segment.slice(eq + 1).trim();
  }
  return undefined;
}
