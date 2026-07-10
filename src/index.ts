import { Plugin, Setting, showMessage } from "siyuan";
import "./style.css";
import {
  isDecodableImage,
  resolveBestIcon,
  type FallbackMode,
  type ProviderPreset,
  type ResolverMode,
} from "./icon-resolver";

type CacheEntry = {
  url: string;
  fetchedAt: number;
  resolverVersion?: number;
  source?: string;
};

type Settings = {
  enabled: boolean;
  preferDynamic: boolean;
  provider: string;
  providerPreset: ProviderPreset;
  resolverMode: ResolverMode;
  fallbackMode: FallbackMode;
  iconSize: number;
  cacheDays: number;
};

const SETTINGS_FILE = "settings.json";
const CACHE_FILE = "favicon-cache.json";
const PUBLIC_DIR = "/data/public/auto-favicon";
const PUBLIC_URL = "/public/auto-favicon";
const RUNTIME_STYLE_ID = "auto-favicon-runtime-style";
const RESOLVER_VERSION = 3;
const FAILURE_COOLDOWN = 10 * 60 * 1000;

const defaultSettings: Settings = {
  enabled: true,
  preferDynamic: false,
  provider: "https://example.com/favicon/{domain}",
  providerPreset: "auto",
  resolverMode: "mainland",
  fallbackMode: "monogram",
  iconSize: 1,
  cacheDays: 30,
};

export default class AutoFaviconPlugin extends Plugin {
  private settings: Settings = { ...defaultSettings };
  private cache: Record<string, CacheEntry> = {};
  private pendingDomains = new Set<string>();
  private failedDomains = new Map<string, number>();
  private iconRules = new Map<string, string>();
  private observer?: MutationObserver;
  private scanTimer?: number;
  private readonly inputListener = () => this.scheduleScan();

  async onload() {
    this.settings = { ...defaultSettings, ...(await this.loadData(SETTINGS_FILE)) };
    this.cache = (await this.loadData(CACHE_FILE)) ?? {};
    this.addSetting();
    await this.rebuildRules();
    this.startObserver();
    this.scheduleScan();
  }

  onunload() {
    this.observer?.disconnect();
    document.removeEventListener("input", this.inputListener, true);
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    document.getElementById(RUNTIME_STYLE_ID)?.remove();
  }

  private addSetting() {
    const t = (key: string) => String(this.i18n[key] ?? key);
    const addOptions = (select: HTMLSelectElement, options: Array<[string, string]>) => {
      for (const [value, label] of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
    };
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "b3-switch fn__flex-center";
    enabled.checked = this.settings.enabled;

    const preferDynamic = document.createElement("input");
    preferDynamic.type = "checkbox";
    preferDynamic.className = "b3-switch fn__flex-center";
    preferDynamic.checked = this.settings.preferDynamic;

    const provider = document.createElement("input");
    provider.className = "b3-text-field fn__block";
    provider.value = this.settings.provider;
    provider.placeholder = "https://example.com/favicon/{domain}";

    const providerPreset = document.createElement("select");
    providerPreset.className = "b3-select fn__size200";
    addOptions(providerPreset, [
      ["auto", t("providerAuto")],
      ["faviconkit", t("providerFaviconKit")],
      ["faviconim", t("providerFaviconIm")],
      ["iconhorse", t("providerIconHorse")],
      ["custom", t("providerCustom")],
    ]);
    providerPreset.value = this.settings.providerPreset;

    const resolverMode = document.createElement("select");
    resolverMode.className = "b3-select fn__size200";
    addOptions(resolverMode, [
      ["mainland", t("strategyStandard")],
      ["global", t("strategyProxy")],
      ["direct", t("strategyDirect")],
    ]);
    resolverMode.value = this.settings.resolverMode;

    const fallbackMode = document.createElement("select");
    fallbackMode.className = "b3-select fn__size200";
    addOptions(fallbackMode, [
      ["monogram", t("fallbackMonogram")],
      ["none", t("fallbackNone")],
    ]);
    fallbackMode.value = this.settings.fallbackMode;

    const iconSize = document.createElement("input");
    iconSize.type = "number";
    iconSize.min = "0.7";
    iconSize.max = "1.8";
    iconSize.step = "0.1";
    iconSize.className = "b3-text-field fn__size100";
    iconSize.value = String(this.settings.iconSize);

    const cacheDays = document.createElement("input");
    cacheDays.type = "number";
    cacheDays.min = "0";
    cacheDays.max = "365";
    cacheDays.step = "1";
    cacheDays.className = "b3-text-field fn__size100";
    cacheDays.value = String(this.settings.cacheDays);

    const clear = document.createElement("button");
    clear.className = "b3-button b3-button--outline";
    clear.textContent = t("clearCache");
    clear.addEventListener("click", async () => {
      await this.clearCache();
      showMessage(t("cacheCleared"));
    });

    const rebuild = document.createElement("button");
    rebuild.className = "b3-button b3-button--text";
    rebuild.textContent = t("refreshAll");
    rebuild.addEventListener("click", async () => {
      await this.clearCache();
      this.scheduleScan();
      showMessage(t("cacheReset"));
    });

    const cacheActions = document.createElement("div");
    cacheActions.className = "fn__flex";
    cacheActions.style.gap = "8px";
    cacheActions.append(clear, rebuild);

    this.setting = new Setting({
      confirmCallback: async () => {
        this.settings.enabled = enabled.checked;
        this.settings.preferDynamic = preferDynamic.checked;
        this.settings.provider = provider.value.trim() || defaultSettings.provider;
        this.settings.providerPreset = providerPreset.value as ProviderPreset;
        this.settings.resolverMode = resolverMode.value as ResolverMode;
        this.settings.fallbackMode = fallbackMode.value as FallbackMode;
        this.settings.iconSize = this.clamp(Number(iconSize.value), 0.7, 1.8, 1);
        this.settings.cacheDays = this.clamp(Number(cacheDays.value), 0, 365, 30);
        await this.saveData(SETTINGS_FILE, this.settings);
        await this.rebuildRules();
        this.scheduleScan();
      },
    });
    this.setting.addItem({
      title: t("enableTitle"),
      description: t("enableDescription"),
      createActionElement: () => enabled,
    });
    this.setting.addItem({
      title: t("strategyTitle"),
      description: t("strategyDescription"),
      createActionElement: () => resolverMode,
    });
    this.setting.addItem({
      title: t("overrideTitle"),
      description: t("overrideDescription"),
      createActionElement: () => preferDynamic,
    });
    this.setting.addItem({
      title: t("providerTitle"),
      description: t("providerDescription"),
      createActionElement: () => providerPreset,
    });
    this.setting.addItem({
      title: t("customProviderTitle"),
      description: t("customProviderDescription"),
      createActionElement: () => provider,
    });
    this.setting.addItem({
      title: t("fallbackTitle"),
      description: t("fallbackDescription"),
      createActionElement: () => fallbackMode,
    });
    this.setting.addItem({
      title: t("sizeTitle"),
      description: t("sizeDescription"),
      createActionElement: () => iconSize,
    });
    this.setting.addItem({
      title: t("cacheDaysTitle"),
      description: t("cacheDaysDescription"),
      createActionElement: () => cacheDays,
    });
    this.setting.addItem({
      title: t("cacheTitle"),
      description: t("cacheDescription").replace("{count}", String(Object.keys(this.cache).length)),
      createActionElement: () => cacheActions,
    });
  }

  private clamp(value: number, min: number, max: number, fallback: number) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  private async clearCache() {
    await Promise.all(Object.values(this.cache).map(({ url }) => this.removeCachedFile(url)));
    this.cache = {};
    this.failedDomains.clear();
    this.iconRules.clear();
    this.renderRules();
    await this.saveData(CACHE_FILE, this.cache);
  }

  private startObserver() {
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-href", "href", "data-type"],
    });
    document.addEventListener("input", this.inputListener, true);
  }

  private scheduleScan() {
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.scanLinks(), 250);
  }

  private scanLinks() {
    if (!this.settings.enabled) return;
    const selector = [
      ".protyle-wysiwyg span[data-type~='a'][data-href]",
      ".protyle-wysiwyg span[data-type~='url'][data-href]",
      ".protyle-wysiwyg a[href]",
      ".b3-typography a[href]",
    ].join(",");

    const domains = new Map<string, string>();
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const href = element.dataset.href ?? element.getAttribute("href") ?? "";
      const domain = this.domainOf(href);
      if (domain && !domains.has(domain)) domains.set(domain, href);
    });

    domains.forEach((targetUrl, domain) => {
      if (this.cache[domain]) return;
      const failedAt = this.failedDomains.get(domain);
      if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN) return;
      void this.fetchAndCache(domain, targetUrl);
    });
  }

  private domainOf(href: string): string | null {
    try {
      const url = new URL(href);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  private async fetchAndCache(domain: string, targetUrl: string) {
    if (this.pendingDomains.has(domain)) return;
    this.pendingDomains.add(domain);
    try {
      const resolved = await resolveBestIcon(targetUrl, {
        provider: this.settings.provider,
        providerPreset: this.settings.providerPreset,
        mode: this.settings.resolverMode,
        fallback: this.settings.fallbackMode,
      });
      if (!resolved) throw new Error("no usable icon source returned an image");
      const url = await this.storeIcon(domain, resolved.blob);
      if (!await this.isStoredIconUsable(url)) {
        await this.removeCachedFile(url);
        throw new Error("cached icon could not be loaded back from SiYuan");
      }
      this.cache[domain] = {
        url,
        fetchedAt: Date.now(),
        resolverVersion: RESOLVER_VERSION,
        source: resolved.source,
      };
      await this.saveData(CACHE_FILE, this.cache);
      this.failedDomains.delete(domain);
      this.setRule(domain, url, resolved.source);
    } catch (error) {
      console.warn(`[auto-favicon] Unable to cache ${domain}`, error);
      this.failedDomains.set(domain, Date.now());
      // Do not create a pseudo-element when no verified image exists. This
      // prevents an empty gap and lets link-icon keep its own valid icon.
    } finally {
      this.pendingDomains.delete(domain);
    }
  }

  private async storeIcon(domain: string, blob: Blob): Promise<string> {
    const extension = this.extensionFor(blob.type);
    const safeName = domain.replace(/[^a-z0-9.-]/gi, "_");
    const filename = `${safeName}.${extension}`;
    const form = new FormData();
    form.append("path", `${PUBLIC_DIR}/${filename}`);
    form.append("isDir", "false");
    form.append("modTime", String(Math.floor(Date.now() / 1000)));
    form.append("file", new File([blob], filename, { type: blob.type }));
    const response = await fetch("/api/file/putFile", { method: "POST", body: form });
    const result = await response.json() as { code?: number; msg?: string };
    if (!response.ok || result.code !== 0) {
      throw new Error(result.msg ?? "could not write favicon cache");
    }
    return `${PUBLIC_URL}/${filename}`;
  }

  private extensionFor(mime: string) {
    if (mime.includes("svg")) return "svg";
    if (mime.includes("icon") || mime.includes("ico")) return "ico";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("jpeg")) return "jpg";
    if (mime.includes("gif")) return "gif";
    return "png";
  }

  private async rebuildRules() {
    this.iconRules.clear();
    let cacheChanged = false;
    if (this.settings.enabled) {
      for (const [domain, entry] of Object.entries(this.cache)) {
        const current = entry.resolverVersion === RESOLVER_VERSION;
        const maxAge = this.settings.cacheDays > 0 ? this.settings.cacheDays * 86400000 : Infinity;
        const fresh = Date.now() - entry.fetchedAt <= maxAge;
        if (current && fresh && await this.isStoredIconUsable(entry.url)) {
          this.iconRules.set(domain, this.createRule(domain, entry.url, entry.source));
        } else {
          await this.removeCachedFile(entry.url);
          delete this.cache[domain];
          cacheChanged = true;
        }
      }
    }
    if (cacheChanged) await this.saveData(CACHE_FILE, this.cache);
    this.renderRules();
  }

  private async isStoredIconUsable(url: string) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return false;
      return await isDecodableImage(await response.blob());
    } catch {
      return false;
    }
  }

  private setRule(domain: string, url: string, source?: string) {
    if (!this.settings.enabled) return;
    this.iconRules.set(domain, this.createRule(domain, url, source));
    this.renderRules();
  }

  private createRule(domain: string, iconUrl: string, source?: string) {
    const selectors: string[] = [];
    const elements = [
      [".protyle-wysiwyg span[data-type~='a']", "data-href"],
      [".protyle-wysiwyg span[data-type~='url']", "data-href"],
      [".protyle-wysiwyg a", "href"],
      [".b3-typography a", "href"],
    ] as const;
    for (const protocol of ["https", "http"]) {
      const origin = `${protocol}://${domain}`;
      for (const [element, attribute] of elements) {
        selectors.push(`${element}[${attribute}=${this.cssString(origin)}]::before`);
        for (const boundary of ["/", "?", "#", ":"]) {
          selectors.push(`${element}[${attribute}^=${this.cssString(origin + boundary)}]::before`);
        }
      }
    }
    // A generated fallback should fill gaps, not replace a real icon supplied
    // by link-icon. Verified website/provider icons may override when enabled.
    const important = this.settings.preferDynamic && source !== "generated monogram" ? " !important" : "";
    const size = this.settings.iconSize;
    return `${selectors.join(",\n")} {
      content: "";
      display: inline-block;
      width: ${size}em;
      height: ${size}em;
      margin-right: 0.22em;
      vertical-align: -0.12em;
      background-image: url(${this.cssString(iconUrl)})${important};
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
    }`;
  }

  private cssString(value: string) {
    return JSON.stringify(value).replace(/</g, "\\3c ");
  }

  private renderRules() {
    let style = document.getElementById(RUNTIME_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = RUNTIME_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = [...this.iconRules.values()].join("\n");
  }

  private async removeCachedFile(publicUrl: string) {
    if (!publicUrl.startsWith(PUBLIC_URL)) return;
    await fetch("/api/file/removeFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `/data${publicUrl}` }),
    });
  }
}
