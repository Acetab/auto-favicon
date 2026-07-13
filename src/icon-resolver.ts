type ForwardData = {
  body: string;
  contentType?: string;
  status: number;
  url?: string;
};

type ForwardEnvelope = {
  code: number;
  msg?: string;
  data?: ForwardData;
};

type Candidate = {
  url: string;
  score: number;
  source: string;
};

export type ResolvedIcon = {
  blob: Blob;
  source: string;
};

export type ResolvedIconCandidate = ResolvedIcon & {
  url: string;
};

export type ResolverMode = "mainland" | "global" | "direct";
export type FallbackMode = "monogram" | "none";
export type ProviderPreset = "auto" | "faviconkit" | "faviconim" | "iconhorse" | "custom";
export type MonogramColorMode = "domain" | "custom";
export type MonogramShape = "rounded" | "circle" | "square";

export type MonogramStyle = {
  colorMode: MonogramColorMode;
  primary: string;
  secondary: string;
  text: string;
  shape: MonogramShape;
  letter?: string;
};

export type ResolverOptions = {
  provider: string;
  providerPreset: ProviderPreset;
  mode: ResolverMode;
  fallback: FallbackMode;
  monogramStyle?: MonogramStyle;
};

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATE_ATTEMPTS = 16;
const MAX_CANDIDATE_RESULTS = 8;

export async function resolveBestIcon(targetUrl: string, options: ResolverOptions): Promise<ResolvedIcon | null> {
  const target = new URL(targetUrl);
  const domain = target.hostname.toLowerCase();
  if (!isSafePublicTarget(target)) return null;
  const candidates = await collectCandidates(target, domain, options);
  const seen = new Set<string>();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const blob = await downloadAndValidate(candidate.url);
    if (blob) return { blob, source: candidate.source };
  }
  return options.fallback === "monogram"
    ? { blob: createMonogram(domain, options.monogramStyle), source: "generated monogram" }
    : null;
}

export async function discoverIconCandidates(targetUrl: string, options: ResolverOptions): Promise<ResolvedIconCandidate[]> {
  const target = new URL(targetUrl);
  const domain = target.hostname.toLowerCase();
  if (!isSafePublicTarget(target)) return [];
  const candidates = await collectCandidates(target, domain, options);
  const seenUrls = new Set<string>();
  const seenContent = new Set<string>();
  const results: ResolvedIconCandidate[] = [];
  let attempts = 0;
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (seenUrls.has(candidate.url)) continue;
    seenUrls.add(candidate.url);
    if (attempts++ >= MAX_CANDIDATE_ATTEMPTS) break;
    const blob = await downloadAndValidate(candidate.url);
    if (!blob) continue;
    const fingerprint = await blobFingerprint(blob);
    if (seenContent.has(fingerprint)) continue;
    seenContent.add(fingerprint);
    results.push({ blob, source: candidate.source, url: candidate.url });
    if (results.length >= MAX_CANDIDATE_RESULTS) break;
  }
  return results;
}

export async function resolveIconUrl(iconUrl: string): Promise<ResolvedIcon | null> {
  const url = new URL(iconUrl);
  if (!isSafePublicTarget(url)) return null;
  const blob = await downloadAndValidate(url.href);
  return blob ? { blob, source: "custom URL" } : null;
}

async function collectCandidates(target: URL, domain: string, options: ResolverOptions) {
  const candidates = await discoverPageIcons(target);
  candidates.push({ url: new URL("/favicon.ico", target.origin).href, score: 10, source: "root favicon.ico" });
  candidates.push(...providerCandidates(domain, options));
  return candidates;
}

async function blobFingerprint(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${blob.type}:${blob.size}:${hash >>> 0}`;
}

async function discoverPageIcons(target: URL): Promise<Candidate[]> {
  const page = await forward(target.href, "text", "text/html");
  if (!page || page.status < 200 || page.status >= 300 || !page.body) return [];

  const baseUrl = page.url || target.href;
  const doc = new DOMParser().parseFromString(page.body, "text/html");
  const candidates: Candidate[] = [];

  doc.querySelectorAll<HTMLLinkElement>("link[href]").forEach((link, index) => {
    const rel = link.rel.toLowerCase();
    const isIcon = rel.split(/\s+/).includes("icon") || rel.includes("apple-touch-icon") || rel.includes("mask-icon");
    if (!isIcon) return;
    const media = link.media.trim();
    if (media && typeof matchMedia === "function" && !matchMedia(media).matches) return;
    try {
      const url = new URL(link.getAttribute("href")!, baseUrl).href;
      candidates.push({
        url,
        score: scoreLinkIcon(link, index),
        source: rel.includes("apple-touch-icon") ? "apple-touch-icon" : "page rel=icon",
      });
    } catch {
      // Ignore malformed icon URLs.
    }
  });

  const manifestLink = doc.querySelector<HTMLLinkElement>('link[rel~="manifest"][href]');
  if (manifestLink) {
    try {
      const manifestUrl = new URL(manifestLink.getAttribute("href")!, baseUrl).href;
      candidates.push(...await discoverManifestIcons(manifestUrl));
    } catch {
      // Ignore malformed manifest URLs.
    }
  }
  return candidates;
}

async function discoverManifestIcons(manifestUrl: string): Promise<Candidate[]> {
  const response = await forward(manifestUrl, "text", "application/manifest+json");
  if (!response || response.status < 200 || response.status >= 300) return [];
  try {
    const manifest = JSON.parse(response.body) as { icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }> };
    return (manifest.icons ?? []).flatMap((icon, index) => {
      if (!icon.src || (icon.purpose && icon.purpose.includes("monochrome"))) return [];
      try {
        return [{
          url: new URL(icon.src, response.url || manifestUrl).href,
          score: 80 + scoreSize(icon.sizes ?? "") + scoreType(icon.type ?? "") + index / 100,
          source: "web app manifest",
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function scoreLinkIcon(link: HTMLLinkElement, index: number) {
  const relBonus = link.rel.toLowerCase().includes("apple-touch-icon") ? 60 : 100;
  return relBonus + scoreSize(link.sizes?.value ?? link.getAttribute("sizes") ?? "") +
    scoreType(link.type) + index / 100;
}

function scoreSize(sizes: string) {
  if (sizes.toLowerCase().includes("any")) return 100;
  const values = [...sizes.matchAll(/(\d+)x(\d+)/gi)].map((match) => Math.min(Number(match[1]), Number(match[2])));
  if (!values.length) return 0;
  const largest = Math.max(...values);
  return Math.min(largest, 256) / 4;
}

function scoreType(type: string) {
  if (type.includes("svg")) return 90;
  if (type.includes("png") || type.includes("webp")) return 50;
  if (type.includes("icon") || type.includes("ico")) return 30;
  return 0;
}

function providerCandidates(domain: string, options: ResolverOptions): Candidate[] {
  if (options.mode === "direct") return [];
  const rootDomain = domain.startsWith("www.") ? domain.slice(4) : domain;
  const candidates: Candidate[] = [];
  const addPreset = (preset: Exclude<ProviderPreset, "auto">, score: number) => {
    candidates.push({ url: providerUrl(preset, domain, options.provider), score, source: providerName(preset) });
    if (rootDomain !== domain) {
      candidates.push({
        url: providerUrl(preset, rootDomain, options.provider),
        score: score - 0.25,
        source: `${providerName(preset)} (root domain)`,
      });
    }
  };

  if (options.providerPreset === "auto") {
    addPreset("faviconkit", 8.5);
    addPreset("faviconim", 8);
  } else {
    addPreset(options.providerPreset, 8.5);
  }
  if (options.mode === "global") {
    candidates.push({
      url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`,
      score: 9,
      source: "Google domain favicon",
    });
    candidates.push({
      url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
      score: 7,
      source: "DuckDuckGo favicon",
    });
  }
  return candidates;
}

function providerUrl(preset: Exclude<ProviderPreset, "auto">, domain: string, customTemplate: string) {
  const encoded = encodeURIComponent(domain);
  if (preset === "faviconkit") return `https://ico.faviconkit.net/favicon/${encoded}?sz=64`;
  if (preset === "faviconim") return `https://favicon.im/${encoded}?larger=true&throw-error-on-404=true`;
  if (preset === "iconhorse") return `https://icon.horse/icon/${encoded}`;
  const template = customTemplate.trim();
  if (template.includes("{domain}")) return template.replaceAll("{domain}", encoded);
  return `${template.replace(/\/$/, "")}/${encoded}`;
}

function providerName(preset: Exclude<ProviderPreset, "auto">) {
  if (preset === "faviconkit") return "FaviconKit";
  if (preset === "faviconim") return "favicon.im";
  if (preset === "iconhorse") return "Icon Horse";
  return "custom favicon service";
}

function createMonogram(domain: string, style?: MonogramStyle) {
  const requestedLetter = style?.letter?.trim();
  const letter = escapeXml((requestedLetter
    ? Array.from(requestedLetter)[0]
    : domain.replace(/^www\./, "").match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase());
  let hash = 0;
  for (const char of domain) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  const customColors = style?.colorMode === "custom";
  const primary = customColors ? safeColor(style?.primary, "#4F7CFF") : `hsl(${hue} 72% 58%)`;
  const secondary = customColors ? safeColor(style?.secondary, "#745CFF") : `hsl(${(hue + 28) % 360} 68% 42%)`;
  const text = safeColor(style?.text, "#FFFFFF");
  const shape = style?.shape ?? "rounded";
  const background = shape === "circle"
    ? '<circle cx="32" cy="32" r="32" fill="url(#g)"/>'
    : `<rect width="64" height="64" rx="${shape === "square" ? 4 : 14}" fill="url(#g)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/>
    </linearGradient></defs>
    ${background}
    <text x="32" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="${text}">${letter}</text>
  </svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
}

function safeColor(value: string | undefined, fallback: string) {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]!);
}

async function downloadAndValidate(url: string): Promise<Blob | null> {
  if (url.startsWith("data:image/")) {
    const blob = dataUrlToBlob(url);
    return blob && await isDecodableImage(blob) ? blob : null;
  }
  const response = await forward(url, "base64", "application/octet-stream", 5000);
  if (!response || response.status < 200 || response.status >= 300 || !response.body) return null;
  try {
    const bytes = base64ToBytes(response.body);
    if (!bytes.length || bytes.length > MAX_ICON_BYTES) return null;
    const blob = new Blob([bytes], { type: response.contentType?.split(";")[0] || "application/octet-stream" });
    return await isDecodableImage(blob) ? blob : null;
  } catch {
    return null;
  }
}

export async function isDecodableImage(blob: Blob): Promise<boolean> {
  if (!blob.size || blob.size > MAX_ICON_BYTES) return false;
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<boolean>((resolve) => {
      const image = new Image();
      const timer = window.setTimeout(() => resolve(false), 5000);
      image.onload = () => {
        window.clearTimeout(timer);
        resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      };
      image.onerror = () => {
        window.clearTimeout(timer);
        resolve(false);
      };
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function forward(
  url: string,
  responseEncoding: "text" | "base64",
  contentType: string,
  timeout = 8000,
): Promise<ForwardData | null> {
  try {
    const response = await fetch("/api/network/forwardProxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: "GET",
        timeout,
        contentType,
        headers: [
          { "User-Agent": "Mozilla/5.0 (compatible; SiYuan Auto Favicon/0.3)" },
          { Accept: responseEncoding === "text" ? "text/html,application/xhtml+xml,application/json" : "image/avif,image/webp,image/*,*/*" },
        ],
        payload: {},
        payloadEncoding: "text",
        responseEncoding,
      }),
    });
    const envelope = await response.json() as ForwardEnvelope;
    return response.ok && envelope.code === 0 && envelope.data ? envelope.data : null;
  } catch {
    return null;
  }
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function dataUrlToBlob(url: string): Blob | null {
  const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  try {
    const bytes = match[2]
      ? base64ToBytes(match[3])
      : new TextEncoder().encode(decodeURIComponent(match[3]));
    return new Blob([bytes], { type: match[1] || "image/png" });
  } catch {
    return null;
  }
}

function isSafePublicTarget(url: URL) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}
