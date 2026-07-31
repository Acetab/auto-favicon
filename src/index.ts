import { confirm, Dialog, Menu, Plugin, Setting, showMessage } from "siyuan";
import "./style.css";
import {
  discoverIconCandidates,
  isDecodableImage,
  parentDomainOf,
  resolveBestIcon,
  resolveIconUrl,
  type FallbackMode,
  type MonogramColorMode,
  type MonogramShape,
  type MonogramStyle,
  type ProviderPreset,
  type ResolverMode,
} from "./icon-resolver";
import { safePageDiscoveryUrl, scopeForUrl, scopeFromCacheKey, scopeMatchTarget, type LinkScope } from "./url-scope";

type CacheEntry = {
  url: string;
  fetchedAt: number;
  resolverVersion?: number;
  source?: string;
  targetUrl?: string;
  domain?: string;
  routeKey?: string;
  pathPrefix?: string;
  pinned?: boolean;
  includeSubdomains?: boolean;
};

type LinkIconMode = "smart" | "auto";
type FetchTrigger = "automatic" | "manual";
type MonogramOverride = Omit<MonogramStyle, "colorMode"> & { letter: string };

type Settings = {
  enabled: boolean;
  pauseAutomaticFetch: boolean;
  allowFullPageDiscovery: boolean;
  linkIconMode: LinkIconMode;
  provider: string;
  providerPreset: ProviderPreset;
  resolverMode: ResolverMode;
  fallbackMode: FallbackMode;
  monogramColorMode: MonogramColorMode;
  monogramPrimary: string;
  monogramSecondary: string;
  monogramText: string;
  monogramShape: MonogramShape;
  monogramOverrides: Record<string, MonogramOverride>;
  iconSize: number;
  cacheDays: number;
};

const SETTINGS_FILE = "settings.json";
const CACHE_FILE = "favicon-cache.json";
const PUBLIC_DIR = "/data/public/auto-favicon";
const PUBLIC_URL = "/public/auto-favicon";
const RUNTIME_STYLE_ID = "auto-favicon-runtime-style";
const FEEDBACK_URL = "https://ld246.com/article/1785052610863";
const RESOLVER_VERSION = 5;
const FAILURE_COOLDOWN = 10 * 60 * 1000;
const MAX_CONCURRENT_FETCHES = 4;

const defaultSettings: Settings = {
  enabled: true,
  pauseAutomaticFetch: false,
  allowFullPageDiscovery: false,
  linkIconMode: "smart",
  provider: "https://example.com/favicon/{domain}",
  providerPreset: "auto",
  resolverMode: "mainland",
  fallbackMode: "monogram",
  monogramColorMode: "domain",
  monogramPrimary: "#4F7CFF",
  monogramSecondary: "#745CFF",
  monogramText: "#FFFFFF",
  monogramShape: "rounded",
  monogramOverrides: {},
  iconSize: 1,
  cacheDays: 30,
};

export default class AutoFaviconPlugin extends Plugin {
  private settings: Settings = { ...defaultSettings };
  private cache: Record<string, CacheEntry> = {};
  private pendingDomains = new Set<string>();
  private pendingFetches = new Map<string, {
    promise: Promise<boolean>;
    trigger: FetchTrigger;
    automaticGeneration: number;
  }>();
  private failedDomains = new Map<string, number>();
  private iconRules = new Map<string, string>();
  private forceDomains = new Set<string>();
  private observer?: MutationObserver;
  private styleObserver?: MutationObserver;
  private scanTimer?: number;
  private topBarElement?: HTMLElement;
  private enabledInput?: HTMLInputElement;
  private linkIconModeSelect?: HTMLSelectElement;
  private cacheCountElement?: HTMLElement;
  private activeFetches = 0;
  private fetchWaiters: Array<() => void> = [];
  private cacheSaveQueue: Promise<void> = Promise.resolve();
  private failureReasons = new Map<string, string>();
  private automaticFetchGeneration = 0;
  private cacheGeneration = 0;
  private readonly inputListener = () => this.scheduleScan();

  async onload() {
    this.addToolbar();
    const loadedSettings = await this.loadData(SETTINGS_FILE);
    const saved = (loadedSettings && typeof loadedSettings === "object" && !Array.isArray(loadedSettings)
      ? loadedSettings
      : {}) as Partial<Settings> & { preferDynamic?: boolean };
    this.settings = {
      ...defaultSettings,
      ...saved,
      linkIconMode: saved.linkIconMode ?? (saved.preferDynamic ? "auto" : "smart"),
      monogramOverrides: { ...defaultSettings.monogramOverrides, ...(saved.monogramOverrides ?? {}) },
    };
    const loadedCache = await this.loadData(CACHE_FILE);
    this.cache = loadedCache && typeof loadedCache === "object" && !Array.isArray(loadedCache)
      ? loadedCache as Record<string, CacheEntry>
      : {};
    await this.sanitizeCachedTargets();
    await this.migrateCacheEntries();
    this.addSetting();
    await this.rebuildRules();
    this.startObserver();
    this.scheduleScan();
  }

  onunload() {
    this.observer?.disconnect();
    this.styleObserver?.disconnect();
    document.removeEventListener("input", this.inputListener, true);
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.topBarElement?.remove();
    document.getElementById(RUNTIME_STYLE_ID)?.remove();
  }

  private t(key: string) {
    return String(this.i18n[key] ?? key);
  }

  private saveCache() {
    const snapshot = structuredClone(this.cache);
    const save = this.cacheSaveQueue
      .catch(() => undefined)
      .then(() => this.saveData(CACHE_FILE, snapshot));
    this.cacheSaveQueue = save;
    return save;
  }

  private sanitizeTargetUrl(targetUrl: string, domain: string) {
    try {
      const url = new URL(targetUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}/`;
    } catch {
      // Fall through to a safe domain-only URL.
    }
    return `https://${domain}/`;
  }

  private async sanitizeCachedTargets() {
    let changed = false;
    for (const [key, entry] of Object.entries(this.cache)) {
      const domain = entry.domain ?? key.split("::")[0];
      if (entry.domain !== domain) {
        entry.domain = domain;
        changed = true;
      }
      if (!entry.targetUrl) continue;
      const sanitized = this.sanitizeTargetUrl(entry.targetUrl, domain);
      if (entry.targetUrl !== sanitized) {
        entry.targetUrl = sanitized;
        changed = true;
      }
    }
    if (changed) await this.saveCache();
  }

  private async migrateCacheEntries() {
    let changed = false;
    for (const entry of Object.values(this.cache)) {
      if (entry.pinned || entry.resolverVersion === RESOLVER_VERSION) continue;
      if (entry.source !== "generated monogram") {
        entry.resolverVersion = RESOLVER_VERSION;
        changed = true;
      }
    }
    if (changed) await this.saveCache();
  }

  private async acquireFetchSlot() {
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches += 1;
      return;
    }
    await new Promise<void>((resolve) => this.fetchWaiters.push(resolve));
  }

  private releaseFetchSlot() {
    const next = this.fetchWaiters.shift();
    if (next) next();
    else this.activeFetches -= 1;
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
    this.enabledInput = enabled;

    const pauseAutomaticFetch = document.createElement("input");
    pauseAutomaticFetch.type = "checkbox";
    pauseAutomaticFetch.className = "b3-switch fn__flex-center";
    pauseAutomaticFetch.checked = this.settings.pauseAutomaticFetch;

    const allowFullPageDiscovery = document.createElement("input");
    allowFullPageDiscovery.type = "checkbox";
    allowFullPageDiscovery.className = "b3-switch fn__flex-center";
    allowFullPageDiscovery.checked = this.settings.allowFullPageDiscovery;

    const linkIconMode = document.createElement("select");
    linkIconMode.className = "b3-select fn__size200";
    addOptions(linkIconMode, [
      ["smart", t("linkIconSmart")],
      ["auto", t("linkIconAuto")],
    ]);
    linkIconMode.value = this.settings.linkIconMode;
    this.linkIconModeSelect = linkIconMode;

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
    const updateProviderAvailability = () => {
      provider.disabled = providerPreset.value !== "custom";
    };
    providerPreset.addEventListener("change", updateProviderAvailability);
    updateProviderAvailability();

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

    const monogramColorMode = document.createElement("select");
    monogramColorMode.className = "b3-select fn__size200";
    addOptions(monogramColorMode, [
      ["domain", t("monogramColorDomain")],
      ["custom", t("monogramColorCustom")],
    ]);
    monogramColorMode.value = this.settings.monogramColorMode;

    const monogramShape = document.createElement("select");
    monogramShape.className = "b3-select fn__size200";
    addOptions(monogramShape, [
      ["rounded", t("monogramShapeRounded")],
      ["circle", t("monogramShapeCircle")],
      ["square", t("monogramShapeSquare")],
    ]);
    monogramShape.value = this.settings.monogramShape;

    const colorInput = (value: string, title?: string) => {
      const input = document.createElement("input");
      input.type = "color";
      input.className = "b3-text-field";
      input.style.width = "64px";
      input.style.height = "32px";
      input.value = value;
      if (title) input.title = title;
      return input;
    };
    const monogramPrimary = colorInput(this.settings.monogramPrimary);
    const monogramSecondary = colorInput(this.settings.monogramSecondary);
    const monogramText = colorInput(this.settings.monogramText);

    const draftOverrides: Record<string, MonogramOverride> = JSON.parse(JSON.stringify(this.settings.monogramOverrides));
    const overrideEditor = document.createElement("div");
    overrideEditor.style.display = "grid";
    overrideEditor.style.gap = "8px";
    overrideEditor.style.width = "min(520px, 70vw)";
    const overrideFields = document.createElement("div");
    overrideFields.className = "fn__flex";
    overrideFields.style.gap = "6px";
    overrideFields.style.flexWrap = "wrap";
    const overrideDomain = document.createElement("input");
    overrideDomain.className = "b3-text-field";
    overrideDomain.style.width = "150px";
    overrideDomain.placeholder = t("monogramDomainPlaceholder");
    overrideDomain.title = t("monogramDomainPlaceholder");
    const overrideLetter = document.createElement("input");
    overrideLetter.className = "b3-text-field";
    overrideLetter.style.width = "48px";
    overrideLetter.maxLength = 2;
    overrideLetter.placeholder = t("monogramLetterPlaceholder");
    overrideLetter.title = t("monogramLetterPlaceholder");
    const overridePrimary = colorInput(this.settings.monogramPrimary, t("monogramPrimaryTitle"));
    const overrideSecondary = colorInput(this.settings.monogramSecondary, t("monogramSecondaryTitle"));
    const overrideText = colorInput(this.settings.monogramText, t("monogramTextTitle"));
    const overrideShape = document.createElement("select");
    overrideShape.className = "b3-select";
    overrideShape.title = t("monogramShapeTitle");
    addOptions(overrideShape, [
      ["rounded", t("monogramShapeRounded")],
      ["circle", t("monogramShapeCircle")],
      ["square", t("monogramShapeSquare")],
    ]);
    const saveOverride = document.createElement("button");
    saveOverride.type = "button";
    saveOverride.className = "b3-button b3-button--outline";
    saveOverride.textContent = t("monogramOverrideSave");
    const overrideList = document.createElement("div");
    overrideList.style.display = "grid";
    overrideList.style.gap = "4px";
    const renderOverrideList = () => {
      overrideList.replaceChildren();
      for (const [domain, item] of Object.entries(draftOverrides).sort(([a], [b]) => a.localeCompare(b))) {
        const row = document.createElement("div");
        row.className = "fn__flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        const label = document.createElement("span");
        label.className = "fn__flex-1";
        label.textContent = `${domain} · ${item.letter || domain[0]?.toUpperCase() || "?"}`;
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "b3-button b3-button--text";
        edit.textContent = t("monogramOverrideEdit");
        edit.addEventListener("click", () => {
          overrideDomain.value = domain;
          overrideLetter.value = item.letter;
          overridePrimary.value = item.primary;
          overrideSecondary.value = item.secondary;
          overrideText.value = item.text;
          overrideShape.value = item.shape;
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "b3-button b3-button--text";
        remove.textContent = t("monogramOverrideRemove");
        remove.addEventListener("click", () => {
          delete draftOverrides[domain];
          renderOverrideList();
        });
        row.append(label, edit, remove);
        overrideList.append(row);
      }
    };
    saveOverride.addEventListener("click", () => {
      const domain = this.normalizeDomainInput(overrideDomain.value);
      if (!domain) {
        showMessage(t("monogramDomainInvalid"));
        return;
      }
      draftOverrides[domain] = {
        letter: Array.from(overrideLetter.value.trim())[0] ?? "",
        primary: overridePrimary.value,
        secondary: overrideSecondary.value,
        text: overrideText.value,
        shape: overrideShape.value as MonogramShape,
      };
      overrideDomain.value = "";
      overrideLetter.value = "";
      renderOverrideList();
    });
    overrideFields.append(
      overrideDomain,
      overrideLetter,
      overridePrimary,
      overrideSecondary,
      overrideText,
      overrideShape,
      saveOverride,
    );
    overrideEditor.append(overrideFields, overrideList);
    renderOverrideList();

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

    const cacheActions = document.createElement("div");
    cacheActions.className = "fn__flex auto-favicon-cache-actions";
    const cacheCount = document.createElement("span");
    cacheCount.className = "b3-label__text";
    this.cacheCountElement = cacheCount;
    this.updateCacheCount();
    const refreshCurrent = this.actionButton(t("refreshCurrent"), "b3-button b3-button--outline", () => {
      void this.refreshCurrentDocument();
    });
    const refreshAll = this.actionButton(t("refreshAll"), "b3-button b3-button--outline", () => {
      this.confirmRefreshAll();
    });
    const manage = this.actionButton(t("manageCache"), "b3-button b3-button--text", () => {
      this.openCacheManager();
    });
    cacheActions.append(cacheCount, refreshCurrent, refreshAll, manage);

    this.setting = new Setting({
      confirmCallback: async () => {
        const previousMonogramSignature = this.monogramSignature(this.settings);
        const wasPaused = this.settings.pauseAutomaticFetch;
        this.settings.enabled = enabled.checked;
        this.settings.pauseAutomaticFetch = pauseAutomaticFetch.checked;
        this.settings.allowFullPageDiscovery = allowFullPageDiscovery.checked;
        this.settings.linkIconMode = linkIconMode.value as LinkIconMode;
        this.settings.provider = provider.value.trim() || defaultSettings.provider;
        this.settings.providerPreset = providerPreset.value as ProviderPreset;
        this.settings.resolverMode = resolverMode.value as ResolverMode;
        this.settings.fallbackMode = fallbackMode.value as FallbackMode;
        this.settings.monogramColorMode = monogramColorMode.value as MonogramColorMode;
        this.settings.monogramPrimary = monogramPrimary.value;
        this.settings.monogramSecondary = monogramSecondary.value;
        this.settings.monogramText = monogramText.value;
        this.settings.monogramShape = monogramShape.value as MonogramShape;
        this.settings.monogramOverrides = { ...draftOverrides };
        this.settings.iconSize = this.clamp(Number(iconSize.value), 0.7, 1.8, 1);
        this.settings.cacheDays = this.clamp(Number(cacheDays.value), 0, 365, 30);
        if (previousMonogramSignature !== this.monogramSignature(this.settings)) {
          await this.invalidateGeneratedMonograms();
        }
        if (!wasPaused && this.settings.pauseAutomaticFetch) this.automaticFetchGeneration += 1;
        await this.saveData(SETTINGS_FILE, this.settings);
        await this.rebuildRules();
        if (this.settings.enabled && !this.settings.pauseAutomaticFetch) this.scheduleScan();
      },
    });
    this.setting.addItem({
      title: t("enableTitle"),
      description: t("enableDescription"),
      createActionElement: () => enabled,
    });
    this.setting.addItem({
      title: t("pauseAutomaticFetchTitle"),
      description: t("pauseAutomaticFetchDescription"),
      createActionElement: () => pauseAutomaticFetch,
    });
    this.setting.addItem({
      title: t("allowFullPageDiscoveryTitle"),
      description: t("allowFullPageDiscoveryDescription"),
      createActionElement: () => allowFullPageDiscovery,
    });
    this.setting.addItem({
      title: t("strategyTitle"),
      description: t("strategyDescription"),
      createActionElement: () => resolverMode,
    });
    this.setting.addItem({
      title: t("linkIconTitle"),
      description: t("linkIconDescription"),
      createActionElement: () => linkIconMode,
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
      title: t("monogramColorTitle"),
      description: t("monogramColorDescription"),
      createActionElement: () => monogramColorMode,
    });
    this.setting.addItem({
      title: t("monogramPrimaryTitle"),
      description: t("monogramPrimaryDescription"),
      createActionElement: () => monogramPrimary,
    });
    this.setting.addItem({
      title: t("monogramSecondaryTitle"),
      description: t("monogramSecondaryDescription"),
      createActionElement: () => monogramSecondary,
    });
    this.setting.addItem({
      title: t("monogramTextTitle"),
      description: t("monogramTextDescription"),
      createActionElement: () => monogramText,
    });
    this.setting.addItem({
      title: t("monogramShapeTitle"),
      description: t("monogramShapeDescription"),
      createActionElement: () => monogramShape,
    });
    this.setting.addItem({
      title: t("monogramOverridesTitle"),
      description: t("monogramOverridesDescription"),
      createActionElement: () => overrideEditor,
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
      description: t("cacheDescription"),
      createActionElement: () => cacheActions,
    });
  }

  private addToolbar() {
    const icon = `<svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="15" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="3.2"/>
      <path d="M19 18.5h11M19 25h8" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>
      <path d="m25 .5 2 4 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2 2-4Z" fill="currentColor"/>
    </svg>`;
    this.topBarElement = this.addTopBar({
      icon,
      title: this.t("toolbarTitle"),
      position: "right",
      callback: (event) => this.openToolbarMenu(event),
    });
  }

  private openToolbarMenu(event: MouseEvent) {
    const menu = new Menu("auto-favicon-toolbar-menu");
    menu.addItem({
      type: "readonly",
      label: `${this.t("toolbarStatus")
        .replace("{mode}", this.t(this.settings.linkIconMode === "smart" ? "linkIconSmart" : "linkIconAuto"))
        .replace("{count}", String(Object.keys(this.cache).length))}${
        this.settings.pauseAutomaticFetch ? ` · ${this.t("automaticFetchPausedStatus")}` : ""
      }${
        this.settings.allowFullPageDiscovery ? ` · ${this.t("fullPageDiscoveryEnabledStatus")}` : ""
      }`,
    });
    menu.addItem({
      label: this.t("toolbarEnabled"),
      checked: this.settings.enabled,
      click: () => void this.setEnabled(!this.settings.enabled),
    });
    menu.addItem({
      label: this.t("toolbarMode"),
      type: "submenu",
      submenu: [
        {
          label: this.t("linkIconSmart"),
          checked: this.settings.linkIconMode === "smart",
          click: () => void this.setLinkIconMode("smart"),
        },
        {
          label: this.t("linkIconAuto"),
          checked: this.settings.linkIconMode === "auto",
          click: () => void this.setLinkIconMode("auto"),
        },
      ],
    });
    menu.addSeparator();
    menu.addItem({
      label: this.t("refreshCurrent"),
      click: () => void this.refreshCurrentDocument(),
    });
    menu.addItem({
      label: this.t("manageCache"),
      click: () => this.openCacheManager(),
    });
    menu.addItem({
      label: this.t("openSettings"),
      click: () => this.openSetting(),
    });
    menu.addItem({
      label: this.t("feedback"),
      click: () => {
        window.open(FEEDBACK_URL, "_blank", "noopener,noreferrer");
      },
    });
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    menu.open({
      x: rect?.right ?? event.clientX,
      y: rect?.bottom ?? event.clientY,
      isLeft: true,
    });
  }

  private actionButton(label: string, className: string, callback: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  private updateCacheCount() {
    if (this.cacheCountElement) {
      this.cacheCountElement.textContent = this.t("cacheCount").replace("{count}", String(Object.keys(this.cache).length));
    }
  }

  private async setEnabled(enabled: boolean) {
    this.settings.enabled = enabled;
    if (this.enabledInput) this.enabledInput.checked = enabled;
    await this.saveData(SETTINGS_FILE, this.settings);
    await this.rebuildRules();
    if (enabled && !this.settings.pauseAutomaticFetch) this.scheduleScan();
    showMessage(this.t(enabled ? "pluginEnabled" : "pluginDisabled"));
  }

  private async setLinkIconMode(mode: LinkIconMode) {
    if (this.settings.linkIconMode === mode) return;
    this.settings.linkIconMode = mode;
    if (this.linkIconModeSelect) this.linkIconModeSelect.value = mode;
    await this.saveData(SETTINGS_FILE, this.settings);
    await this.rebuildRules();
    this.scheduleScan();
    showMessage(this.t("modeChanged").replace("{mode}", this.t(mode === "smart" ? "linkIconSmart" : "linkIconAuto")));
  }

  private confirmRefreshAll() {
    confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (dialog) => {
      dialog.destroy();
      void this.refreshAllCachedDomains();
    });
  }

  private confirmClearAll(afterClear?: () => void) {
    confirm(this.t("clearCache"), this.t("clearCacheConfirm"), (dialog) => {
      dialog.destroy();
      void this.clearCache().then(() => {
        showMessage(this.t("cacheCleared"));
        afterClear?.();
      });
    });
  }

  private currentDocumentRoot() {
    const active = document.querySelector<HTMLElement>(".layout__wnd--active .protyle-wysiwyg");
    if (active) return active;
    return [...document.querySelectorAll<HTMLElement>(".protyle-wysiwyg")]
      .find((element) => element.offsetParent !== null) ?? null;
  }

  private collectDocumentDomains(root?: Element | null) {
    const selector = [
      ".protyle-wysiwyg span[data-type~='a'][data-href]",
      ".protyle-wysiwyg span[data-type~='url'][data-href]",
      ".protyle-wysiwyg a[href]",
      ".b3-typography a[href]",
    ].join(",");
    const domains = new Map<string, { scope: LinkScope; targetUrl: string; elements: HTMLElement[] }>();
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      if (root && element !== root && !root.contains(element)) return;
      const href = element.dataset.href ?? element.getAttribute("href") ?? "";
      const scope = scopeForUrl(href);
      if (!scope) return;
      const existing = domains.get(scope.key);
      if (existing) existing.elements.push(element);
      else domains.set(scope.key, { scope, targetUrl: href, elements: [element] });
    });
    return domains;
  }

  private async refreshCurrentDocument() {
    const domains = this.collectDocumentDomains(this.currentDocumentRoot());
    if (domains.size === 0) {
      showMessage(this.t("noCurrentDomains"));
      return;
    }
    const targets = new Map([...domains].map(([key, item]) => [key, { scope: item.scope, targetUrl: item.targetUrl }]));
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    this.showRefreshResult(await this.refreshDomains(targets));
  }

  private async refreshAllCachedDomains() {
    const targets = new Map(Object.entries(this.cache)
      .filter(([, entry]) => !entry.pinned)
      .map(([key, entry]) => {
        const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
        const targetUrl = entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
        return [key, { scope, targetUrl }] as const;
      }));
    if (targets.size === 0) {
      showMessage(this.t(Object.keys(this.cache).length === 0 ? "cacheEmpty" : "noRefreshableDomains"));
      return;
    }
    showMessage(this.t("refreshStarted").replace("{count}", String(targets.size)));
    this.showRefreshResult(await this.refreshDomains(targets));
  }

  private async refreshDomains(
    targets: Map<string, { scope: LinkScope; targetUrl: string }>,
    onProgress?: (completed: number, total: number) => void,
  ) {
    const items = [...targets];
    let completed = 0;
    let success = 0;
    let skipped = 0;
    const failures: string[] = [];
    await Promise.all(items.map(async ([key, { scope, targetUrl }]) => {
      if (this.cachedIconForScope(scope)?.entry.pinned) skipped += 1;
      else if (await this.fetchAndCache(scope, targetUrl, true, "manual")) success += 1;
      else {
        const reason = this.failureReasons.get(key);
        if (reason && failures.length < 3) failures.push(reason);
      }
      completed += 1;
      onProgress?.(completed, items.length);
    }));
    return { success, failed: items.length - success - skipped, skipped, failures };
  }

  private showRefreshResult(result: { success: number; failed: number; skipped: number; failures?: string[] }) {
    const summary = this.t("refreshFinished")
      .replace("{success}", String(result.success))
      .replace("{failed}", String(result.failed))
      .replace("{skipped}", String(result.skipped));
    const details = result.failures?.length ? `\n${result.failures.join("\n")}` : "";
    showMessage(`${summary}${details}`);
  }

  private async removeCachedDomain(key: string, save = true) {
    const entry = this.cache[key];
    if (entry) await this.removeCachedFile(entry.url);
    delete this.cache[key];
    this.failedDomains.delete(key);
    this.iconRules.delete(key);
    this.forceDomains.delete(key);
    if (save) await this.saveCache();
    this.renderRules();
    this.updateCacheCount();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
  }

  private openCacheManager() {
    const dialog = new Dialog({
      title: this.t("manageCache"),
      content: '<div class="auto-favicon-cache-manager"></div>',
      width: "min(760px, 92vw)",
      height: "min(640px, 82vh)",
    });
    const root = dialog.element.querySelector<HTMLElement>(".auto-favicon-cache-manager");
    if (!root) return;

    const render = () => {
      root.replaceChildren();
      const summary = document.createElement("div");
      summary.className = "auto-favicon-cache-summary";
      const count = document.createElement("strong");
      count.textContent = this.t("cacheCount").replace("{count}", String(Object.keys(this.cache).length));
      const path = document.createElement("code");
      path.textContent = "workspace/data/public/auto-favicon/";
      summary.append(count, path);

      const actions = document.createElement("div");
      actions.className = "fn__flex auto-favicon-cache-actions";
      actions.append(
        this.actionButton(this.t("refreshCurrent"), "b3-button b3-button--outline", () => {
          void this.refreshCurrentDocument().then(render);
        }),
        this.actionButton(this.t("refreshAll"), "b3-button b3-button--outline", () => {
          confirm(this.t("refreshAll"), this.t("refreshAllConfirm"), (confirmDialog) => {
            confirmDialog.destroy();
            void this.refreshAllCachedDomains().then(render);
          });
        }),
        this.actionButton(this.t("clearCache"), "b3-button b3-button--remove", () => this.confirmClearAll(render)),
      );

      const search = document.createElement("input");
      search.className = "b3-text-field fn__block";
      search.placeholder = this.t("cacheSearch");
      const list = document.createElement("div");
      list.className = "auto-favicon-cache-list";
      const renderList = () => {
        list.replaceChildren();
        const query = search.value.trim().toLowerCase();
        const entries = Object.entries(this.cache)
          .filter(([key, entry]) => !query || key.includes(query) || entry.domain?.includes(query))
          .sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) {
          const empty = document.createElement("div");
          empty.className = "b3-label__text auto-favicon-cache-empty";
          empty.textContent = this.t(Object.keys(this.cache).length === 0 ? "cacheEmpty" : "cacheNoMatches");
          list.append(empty);
          return;
        }
        let previousDomain = "";
        for (const [key, entry] of entries) {
          const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
          if (scope.domain !== previousDomain) {
            const heading = document.createElement("strong");
            heading.className = "auto-favicon-cache-domain-heading";
            heading.textContent = scope.domain;
            list.append(heading);
            previousDomain = scope.domain;
          }
          const row = document.createElement("div");
          row.className = "auto-favicon-cache-row";
          const info = document.createElement("div");
          info.className = "auto-favicon-cache-info";
          const name = document.createElement("strong");
          name.textContent = scope.routeKey
            ? this.t("cacheRouteName").replace("{type}", this.scopeTypeLabel(scope))
            : this.t("cacheDomainDefault");
          const meta = document.createElement("span");
          const source = this.cacheSourceLabel(entry.source);
          const status = entry.pinned
            ? this.t(entry.includeSubdomains ? "cachePinnedSubdomains" : "cachePinned")
            : this.isCacheEntryFresh(entry) ? this.t("cacheFresh") : this.t("cacheExpired");
          meta.textContent = `${source} · ${new Date(entry.fetchedAt).toLocaleString()} · ${status}`;
          info.append(name, meta);
          const rowActions = document.createElement("div");
          rowActions.className = "fn__flex auto-favicon-cache-row-actions";
          rowActions.append(this.actionButton(this.t("chooseIcon"), "b3-button b3-button--text", () => {
            const current = this.collectDocumentDomains(this.currentDocumentRoot()).get(scope.key);
            this.openIconPicker(scope, current?.targetUrl ?? entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`, render);
          }));
          if (entry.pinned) {
            rowActions.append(this.actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
              void this.restoreAutomaticIcon(key).then(render);
            }));
          } else {
            rowActions.append(
              this.actionButton(this.t("refreshOne"), "b3-button b3-button--text", () => {
              const current = this.collectDocumentDomains(this.currentDocumentRoot()).get(scope.key);
              const targetUrl = current?.targetUrl ?? entry.targetUrl ?? `https://${scope.domain}${scope.pathPrefix ?? "/"}`;
              void this.refreshDomains(new Map([[scope.key, { scope, targetUrl }]])).then((result) => {
                this.showRefreshResult(result);
                render();
              });
              }),
              this.actionButton(this.t("deleteOne"), "b3-button b3-button--text", () => {
                void this.removeCachedDomain(key).then(render);
              }),
            );
          }
          row.append(info, rowActions);
          list.append(row);
        }
      };
      search.addEventListener("input", renderList);
      renderList();
      root.append(summary, actions, search, list);
    };
    render();
  }

  private cacheSourceLabel(source?: string) {
    if (!source) return this.t("cacheUnknownSource");
    if (source === "generated monogram") return this.t("cacheGenerated");
    if (source === "custom upload") return this.t("customUploadSource");
    if (source === "custom URL") return this.t("customUrlSource");
    if (source.startsWith("selected candidate:")) {
      return `${this.t("selectedCandidateSource")} · ${this.resolverSourceLabel(source.slice("selected candidate:".length))}`;
    }
    return this.resolverSourceLabel(source);
  }

  private resolverSourceLabel(source: string) {
    const parent = source.match(/^parent domain ([^·]+) · (.+)$/);
    if (parent) return `${this.t("parentDomainSource").replace("{domain}", parent[1].trim())} · ${parent[2]}`;
    const platform = source.match(/^platform type ([^:]+):(.+)$/);
    if (platform) return this.t("platformTypeSource").replace("{type}", this.scopeTypeLabel({ routeKey: platform[2] }));
    return source;
  }

  private scopeTypeLabel(scope: Pick<LinkScope, "routeKey">) {
    const key = `scopeType_${scope.routeKey ?? "domain"}`;
    const translated = this.t(key);
    return translated === key ? (scope.routeKey ?? this.t("cacheDomainDefault")) : translated;
  }

  private async pinScopedIcon(
    scope: LinkScope,
    selectedScope: LinkScope,
    targetUrl: string,
    blob: Blob,
    source: string,
    includeSubdomains = false,
  ) {
    if (!await isDecodableImage(blob)) {
      showMessage(this.t("customIconInvalid"));
      return false;
    }
    const pending = this.pendingFetches.get(selectedScope.key);
    if (pending) await pending.promise;
    const previous = this.cache[scope.key];
    const replaced = selectedScope.key === scope.key ? undefined : this.cache[selectedScope.key];
    let storedUrl: string | undefined;
    try {
      storedUrl = await this.storeIcon(scope.key, blob, `-custom-${Date.now()}`);
      if (!await this.isStoredIconUsable(storedUrl)) throw new Error("custom icon could not be loaded back from SiYuan");
      this.cache[scope.key] = {
        url: storedUrl,
        fetchedAt: Date.now(),
        resolverVersion: RESOLVER_VERSION,
        source,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
        domain: scope.domain,
        routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix,
        pinned: true,
        includeSubdomains,
      };
      if (selectedScope.key !== scope.key) delete this.cache[selectedScope.key];
      try {
        await this.saveCache();
      } catch (error) {
        if (previous) this.cache[scope.key] = previous;
        else delete this.cache[scope.key];
        if (replaced) this.cache[selectedScope.key] = replaced;
        throw error;
      }
      if (previous && previous.url !== storedUrl) await this.removeCachedFile(previous.url);
      if (replaced && replaced.url !== storedUrl && replaced.url !== previous?.url) await this.removeCachedFile(replaced.url);
      this.failedDomains.delete(scope.key);
      this.failedDomains.delete(selectedScope.key);
      await this.rebuildRules();
      if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
      this.updateCacheCount();
      showMessage(this.t("customIconSaved").replace("{domain}", scope.domain));
      return true;
    } catch (error) {
      if (storedUrl && storedUrl !== previous?.url) {
        try {
          await this.removeCachedFile(storedUrl);
        } catch {
          // Keep the original error as the useful diagnostic.
        }
      }
      if (previous) this.cache[scope.key] = previous;
      else delete this.cache[scope.key];
      if (replaced) this.cache[selectedScope.key] = replaced;
      console.warn(`[auto-favicon] Unable to save custom icon for ${scope.key}`, error);
      showMessage(this.t("customIconSaveFailed"));
      return false;
    }
  }

  private async restoreAutomaticIcon(key: string) {
    const entry = this.cache[key];
    if (!entry?.pinned) return;
    await this.removeCachedFile(entry.url);
    delete this.cache[key];
    this.failedDomains.delete(key);
    await this.saveCache();
    await this.rebuildRules();
    this.updateCacheCount();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
    showMessage(this.t("automaticRestored").replace("{domain}", entry.domain ?? key.split("::")[0]));
  }

  private openIconPicker(selectedScope: LinkScope, targetUrl: string, afterChange: () => void) {
    const domain = selectedScope.domain;
    const objectUrls: string[] = [];
    const dialog = new Dialog({
      title: this.t("chooseIconFor").replace("{domain}", domain),
      content: '<div class="auto-favicon-picker"></div>',
      width: "min(720px, 92vw)",
      height: "min(620px, 82vh)",
      destroyCallback: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
    });
    const root = dialog.element.querySelector<HTMLElement>(".auto-favicon-picker");
    if (!root) return;

    const sharedDomain = this.shareDomainFor(domain);

    const controls = document.createElement("div");
    controls.className = "auto-favicon-picker-controls";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico";
    fileInput.className = "b3-text-field";
    fileInput.title = this.t("uploadCustomIcon");
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "b3-text-field fn__flex-1";
    urlInput.placeholder = this.t("customIconUrlPlaceholder");
    const urlButton = this.actionButton(this.t("useCustomUrl"), "b3-button b3-button--outline", () => {
      void useUrl();
    });
    controls.append(fileInput, urlInput, urlButton);
    if (this.cache[selectedScope.key]?.pinned) {
      controls.append(this.actionButton(this.t("restoreAutomatic"), "b3-button b3-button--text", () => {
        void this.restoreAutomaticIcon(selectedScope.key).then(() => {
          dialog.destroy();
          afterChange();
        });
      }));
    }

    const scopeSelect = document.createElement("select");
    scopeSelect.className = "b3-select";
    if (selectedScope.routeKey) {
      scopeSelect.add(new Option(this.t("pinCurrentType").replace("{type}", this.scopeTypeLabel(selectedScope)), "type"));
    }
    scopeSelect.add(new Option(this.t("pinCurrentDomain").replace("{domain}", domain), "domain"));
    if (sharedDomain && sharedDomain !== domain) {
      scopeSelect.add(new Option(this.t("applyToSubdomains").replace("{domain}", sharedDomain), "subdomains"));
    }
    const shareRow = document.createElement("label");
    shareRow.className = "auto-favicon-picker-scope";
    const shareText = document.createElement("span");
    shareText.textContent = this.t("pinScopeTitle");
    shareRow.append(shareText, scopeSelect);

    const status = document.createElement("div");
    status.className = "b3-label__text auto-favicon-picker-status";
    status.textContent = this.t("loadingCandidates");
    const hint = document.createElement("div");
    hint.className = "b3-label__text auto-favicon-picker-hint";
    hint.textContent = this.t("candidateHint");
    const grid = document.createElement("div");
    grid.className = "auto-favicon-candidate-grid";
    const loadPageCandidates = this.actionButton(
      this.t("loadPageCandidates"),
      "b3-button b3-button--outline",
      () => void loadCandidates(true),
    );
    root.append(controls);
    root.append(shareRow);
    if (!this.settings.allowFullPageDiscovery) root.append(loadPageCandidates);
    root.append(hint, status, grid);

    let saving = false;
    const saveAndClose = async (blob: Blob, source: string) => {
      if (saving) return;
      saving = true;
      const selection = scopeSelect.value;
      const targetScope = selection === "type"
        ? selectedScope
        : selection === "subdomains" && sharedDomain
          ? { key: sharedDomain, domain: sharedDomain }
          : { key: domain, domain };
      const includeSubdomains = selection === "subdomains";
      if (!await this.pinScopedIcon(targetScope, selectedScope, targetUrl, blob, source, includeSubdomains)) {
        saving = false;
        return;
      }
      dialog.destroy();
      afterChange();
    };

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void saveAndClose(file, "custom upload");
    });

    const useUrl = async () => {
      const value = urlInput.value.trim();
      if (!value) return;
      urlButton.setAttribute("disabled", "true");
      status.textContent = this.t("loadingCustomUrl");
      await this.acquireFetchSlot();
      try {
        const resolved = await resolveIconUrl(value);
        if (!resolved) {
          status.textContent = this.t("customIconInvalid");
          return;
        }
        if (!root.isConnected) return;
        await saveAndClose(resolved.blob, "custom URL");
      } catch {
        status.textContent = this.t("customIconInvalid");
      } finally {
        this.releaseFetchSlot();
        urlButton.removeAttribute("disabled");
      }
    };

    const loadCandidates = async (allowFullPageDiscovery: boolean) => {
      loadPageCandidates.setAttribute("disabled", "true");
      status.textContent = this.t("loadingCandidates");
      grid.replaceChildren();
      await this.acquireFetchSlot();
      try {
        const discoveryTarget = allowFullPageDiscovery
          ? safePageDiscoveryUrl(targetUrl)
          : `https://${selectedScope.domain}/`;
        const candidates = await discoverIconCandidates(discoveryTarget, {
          provider: this.settings.provider,
          providerPreset: this.settings.providerPreset,
          mode: this.settings.resolverMode,
          fallback: this.settings.fallbackMode,
          monogramStyle: this.monogramStyleFor(domain),
          scope: selectedScope,
          allowFullPageDiscovery,
        });
        if (!root.isConnected) return;
        if (!urlButton.hasAttribute("disabled")) {
          status.textContent = candidates.length === 0 ? this.t("noCandidates") : this.t("candidateCount").replace("{count}", String(candidates.length));
        }
        for (const candidate of candidates) {
          const card = document.createElement("button");
          card.type = "button";
          card.className = "auto-favicon-candidate-card";
          const preview = document.createElement("img");
          const objectUrl = URL.createObjectURL(candidate.blob);
          objectUrls.push(objectUrl);
          preview.src = objectUrl;
          preview.alt = candidate.source;
          const label = document.createElement("span");
          label.className = "auto-favicon-candidate-source";
          label.textContent = this.resolverSourceLabel(candidate.source);
          const details = document.createElement("small");
          details.className = "auto-favicon-candidate-details";
          const format = this.iconFormat(candidate.blob);
          const size = this.formatFileSize(candidate.blob.size);
          details.textContent = format === "SVG"
            ? `${format} · ${this.t("vectorIcon")} · ${size}`
            : `${format} · ${size}`;
          preview.addEventListener("load", () => {
            if (format !== "SVG" && preview.naturalWidth > 0 && preview.naturalHeight > 0) {
              details.textContent = `${preview.naturalWidth}×${preview.naturalHeight} · ${format} · ${size}`;
            }
          }, { once: true });
          card.append(preview, label, details);
          card.addEventListener("click", () => {
            void saveAndClose(candidate.blob, `selected candidate:${candidate.source}`);
          });
          grid.append(card);
        }
      } catch (error) {
        console.warn(`[auto-favicon] Unable to discover candidates for ${selectedScope.key}`, error);
        if (root.isConnected && !urlButton.hasAttribute("disabled")) status.textContent = this.t("candidateLoadFailed");
      } finally {
        this.releaseFetchSlot();
        loadPageCandidates.removeAttribute("disabled");
      }
    };
    void loadCandidates(this.settings.allowFullPageDiscovery);
  }

  private iconFormat(blob: Blob) {
    const formats: Record<string, string> = {
      "image/gif": "GIF",
      "image/jpeg": "JPEG",
      "image/png": "PNG",
      "image/svg+xml": "SVG",
      "image/vnd.microsoft.icon": "ICO",
      "image/x-icon": "ICO",
      "image/webp": "WEBP",
    };
    return formats[blob.type.toLowerCase()]
      ?? (blob.type.replace(/^image\//, "").toUpperCase() || this.t("unknownIconFormat"));
  }

  private formatFileSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const kilobytes = bytes / 1024;
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
  }

  private clamp(value: number, min: number, max: number, fallback: number) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  private normalizeDomainInput(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
      return url.hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  private shareDomainFor(domain: string) {
    if (domain.includes(":") || /^\d+(?:\.\d+){3}$/.test(domain)) return null;
    const labels = domain.split(".");
    if (labels.length < 2 || labels.some((label) => !label)) return null;
    return parentDomainOf(domain) ?? domain;
  }

  private monogramSignature(settings: Settings) {
    return JSON.stringify({
      colorMode: settings.monogramColorMode,
      primary: settings.monogramPrimary,
      secondary: settings.monogramSecondary,
      text: settings.monogramText,
      shape: settings.monogramShape,
      overrides: settings.monogramOverrides,
    });
  }

  private async invalidateGeneratedMonograms() {
    const generated = Object.entries(this.cache).filter(([, entry]) => entry.source === "generated monogram");
    await Promise.all(generated.map(([, entry]) => this.removeCachedFile(entry.url)));
    for (const [domain] of generated) {
      delete this.cache[domain];
      this.failedDomains.delete(domain);
      this.iconRules.delete(domain);
    }
    this.renderRules();
    await this.saveCache();
    this.updateCacheCount();
  }

  private async clearCache() {
    this.cacheGeneration += 1;
    const pinned = Object.fromEntries(Object.entries(this.cache).filter(([, entry]) => entry.pinned));
    const removable = Object.values(this.cache).filter((entry) => !entry.pinned);
    await Promise.all(removable.map(({ url }) => this.removeCachedFile(url)));
    this.cache = pinned;
    this.failedDomains.clear();
    this.iconRules.clear();
    this.forceDomains.clear();
    await this.saveCache();
    await this.rebuildRules();
    if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
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
    this.styleObserver = new MutationObserver((mutations) => {
      const externalStyleChanged = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target?.closest(`#${RUNTIME_STYLE_ID}`)) return false;
        if (target?.matches("style, link[rel='stylesheet']")) return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
          node instanceof Element && (node.matches("style, link[rel='stylesheet']") || Boolean(node.querySelector("style, link[rel='stylesheet']"))),
        );
      });
      if (externalStyleChanged) this.scheduleScan();
    });
    this.styleObserver.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    document.addEventListener("input", this.inputListener, true);
  }

  private scheduleScan() {
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.scanLinks(), 250);
  }

  private scanLinks() {
    if (!this.settings.enabled) return;
    const domains = this.collectDocumentDomains();

    const runtimeStyle = document.getElementById(RUNTIME_STYLE_ID) as HTMLStyleElement | null;
    const previousRules = runtimeStyle?.textContent ?? "";
    if (runtimeStyle) runtimeStyle.textContent = "";
    try {
      domains.forEach(({ elements }, key) => {
        if (this.externalIconState(elements) === "meaningful") this.forceDomains.delete(key);
        else this.forceDomains.add(key);
      });
    } finally {
      if (runtimeStyle) runtimeStyle.textContent = previousRules;
    }

    let rulesChanged = false;
    domains.forEach(({ scope, targetUrl }, key) => {
      const cachedMatch = this.cachedIconForScope(scope);
      if (cachedMatch) {
        const { cacheKey, entry: cached } = cachedMatch;
        if (!this.settings.pauseAutomaticFetch && !this.isCacheEntryFresh(cached)) {
          void this.expireCachedDomain(cacheKey, cached);
          return;
        }
        const rule = this.createRule(scope, cached.url, cached.source);
        if (this.iconRules.get(key) !== rule) {
          this.iconRules.set(key, rule);
          rulesChanged = true;
        }
        if (cacheKey === key || cached.pinned || this.settings.pauseAutomaticFetch) return;
      }
      if (this.settings.pauseAutomaticFetch) return;
      const failedAt = this.failedDomains.get(key);
      if (failedAt && Date.now() - failedAt < FAILURE_COOLDOWN) return;
      void this.fetchAndCache(scope, targetUrl);
    });
    if (rulesChanged) this.renderRules();
  }

  private externalIconState(elements: HTMLElement[]): "meaningful" | "placeholder" | "none" {
    let placeholder = false;
    for (const element of elements) {
      const background = getComputedStyle(element, "::before").backgroundImage;
      if (!background || background === "none" || background === 'url("")') continue;
      if (background.includes("plugins/link-icon/icon/net2.svg")) placeholder = true;
      else return "meaningful";
    }
    return placeholder ? "placeholder" : "none";
  }

  private cachedIconForScope(scope: LinkScope) {
    const exact = this.cache[scope.key];
    if (exact?.pinned) return { cacheKey: scope.key, entry: exact };
    const domainPinned = scope.routeKey ? this.cache[scope.domain] : undefined;
    if (domainPinned?.pinned) return { cacheKey: scope.domain, entry: domainPinned };
    let parent = this.shareDomainFor(scope.domain);
    while (parent && parent !== scope.domain) {
      const shared = this.cache[parent];
      if (shared?.pinned && shared.includeSubdomains) return { cacheKey: parent, entry: shared };
      const next = this.shareDomainFor(parent);
      if (next === parent) break;
      parent = next;
    }
    if (exact) return { cacheKey: scope.key, entry: exact };
    const domainFallback = scope.routeKey ? this.cache[scope.domain] : undefined;
    return domainFallback ? { cacheKey: scope.domain, entry: domainFallback } : null;
  }

  private fetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting = false,
    trigger: FetchTrigger = "automatic",
  ): Promise<boolean> {
    if (trigger === "automatic" && this.settings.pauseAutomaticFetch) return Promise.resolve(false);
    const pending = this.pendingFetches.get(scope.key);
    if (pending) {
      const supersedesInvalidatedAutomatic = pending.trigger === "automatic"
        && pending.automaticGeneration !== this.automaticFetchGeneration;
      return (trigger === "manual" && pending.trigger === "automatic") || supersedesInvalidatedAutomatic
        ? pending.promise.then(() => this.fetchAndCache(scope, targetUrl, preserveExisting, trigger))
        : pending.promise;
    }
    const request = this.runFetchAndCache(
      scope,
      targetUrl,
      preserveExisting,
      trigger,
      this.automaticFetchGeneration,
      this.cacheGeneration,
    );
    this.pendingFetches.set(scope.key, {
      promise: request,
      trigger,
      automaticGeneration: this.automaticFetchGeneration,
    });
    void request.finally(() => {
      if (this.pendingFetches.get(scope.key)?.promise === request) this.pendingFetches.delete(scope.key);
    });
    return request;
  }

  private async runFetchAndCache(
    scope: LinkScope,
    targetUrl: string,
    preserveExisting: boolean,
    trigger: FetchTrigger,
    automaticGeneration: number,
    cacheGeneration: number,
  ) {
    const previous = this.cache[scope.key];
    let storedUrl: string | undefined;
    let stage = "resolve";
    let cacheUpdated = false;
    let previousRemoved = false;
    let discarded = false;
    const invalidated = () => cacheGeneration !== this.cacheGeneration
      || (trigger === "automatic" && (
        automaticGeneration !== this.automaticFetchGeneration
        || this.settings.pauseAutomaticFetch
      ));
    const ensureActive = () => {
      if (!invalidated()) return;
      discarded = true;
      throw new Error("fetch result discarded because automatic retrieval or cache state changed");
    };
    this.pendingDomains.add(scope.key);
    await this.acquireFetchSlot();
    try {
      ensureActive();
      const discoveryTarget = this.settings.allowFullPageDiscovery
        ? safePageDiscoveryUrl(targetUrl)
        : `https://${scope.domain}/`;
      const resolved = await resolveBestIcon(discoveryTarget, {
        provider: this.settings.provider,
        providerPreset: this.settings.providerPreset,
        mode: this.settings.resolverMode,
        fallback: this.settings.fallbackMode,
        monogramStyle: this.monogramStyleFor(scope.domain),
        scope,
        allowFullPageDiscovery: this.settings.allowFullPageDiscovery,
      });
      ensureActive();
      if (!resolved) throw new Error("no usable icon source returned an image");
      const suffix = preserveExisting && previous ? `-refresh-${Date.now()}` : "";
      stage = "write";
      const url = await this.storeIcon(scope.key, resolved.blob, suffix);
      storedUrl = url;
      ensureActive();
      stage = "verify-write";
      if (!await this.isStoredIconUsable(url)) {
        throw new Error("cached icon could not be loaded back from SiYuan");
      }
      ensureActive();
      stage = "update-cache";
      this.cache[scope.key] = {
        url,
        fetchedAt: Date.now(),
        resolverVersion: RESOLVER_VERSION,
        source: resolved.source,
        targetUrl: this.sanitizeTargetUrl(targetUrl, scope.domain),
        domain: scope.domain,
        routeKey: scope.routeKey,
        pathPrefix: scope.pathPrefix,
      };
      cacheUpdated = true;
      stage = "save-cache";
      try {
        await this.saveCache();
      } catch (error) {
        if (previous) this.cache[scope.key] = previous;
        else delete this.cache[scope.key];
        throw error;
      }
      ensureActive();
      if (previous && previous.url !== url) {
        try {
          await this.removeCachedFile(previous.url);
          previousRemoved = true;
        } catch (error) {
          console.warn(`[auto-favicon] Unable to remove old cache for ${scope.key}`, error);
        }
      }
      stage = "apply";
      this.updateCacheCount();
      this.failedDomains.delete(scope.key);
      this.failureReasons.delete(scope.key);
      this.setRule(scope, url, resolved.source);
      return true;
    } catch (error) {
      if (storedUrl && storedUrl !== previous?.url) {
        try {
          await this.removeCachedFile(storedUrl);
        } catch {
          // Keep the original error as the useful diagnostic.
        }
      }
      if (cacheGeneration === this.cacheGeneration) {
        if (previous && !previousRemoved) this.cache[scope.key] = previous;
        else delete this.cache[scope.key];
        if (cacheUpdated) {
          try {
            await this.saveCache();
          } catch {
            // A later explicit cache operation remains authoritative.
          }
        }
      }
      this.updateCacheCount();
      if (discarded || invalidated()) return false;
      console.warn(`[auto-favicon] Unable to cache ${scope.key}`, error);
      this.failureReasons.set(scope.key, `${scope.key} · ${stage} · ${this.errorText(error)}`);
      this.failedDomains.set(scope.key, Date.now());
      // Do not create a pseudo-element when no verified image exists. This
      // prevents an empty gap and lets link-icon keep its own valid icon.
      return false;
    } finally {
      this.releaseFetchSlot();
      this.pendingDomains.delete(scope.key);
    }
  }

  private errorText(error: unknown) {
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private async storeIcon(domain: string, blob: Blob, suffix = ""): Promise<string> {
    const extension = this.extensionFor(blob.type);
    const safeName = domain.replace(/[^a-z0-9.-]/gi, "_");
    const filename = `${safeName}${suffix}.${extension}`;
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

  private monogramStyleFor(domain: string): MonogramStyle {
    const rootDomain = domain.startsWith("www.") ? domain.slice(4) : domain;
    const override = this.settings.monogramOverrides[domain] ?? this.settings.monogramOverrides[rootDomain];
    if (override) return { colorMode: "custom", ...override };
    return {
      colorMode: this.settings.monogramColorMode,
      primary: this.settings.monogramPrimary,
      secondary: this.settings.monogramSecondary,
      text: this.settings.monogramText,
      shape: this.settings.monogramShape,
    };
  }

  private isCacheEntryFresh(entry: CacheEntry) {
    if (entry.pinned) return true;
    const maxAge = this.settings.cacheDays > 0 ? this.settings.cacheDays * 86400000 : Infinity;
    return Date.now() - entry.fetchedAt <= maxAge;
  }

  private async expireCachedDomain(key: string, expected: CacheEntry) {
    if (this.settings.pauseAutomaticFetch) return;
    if (this.pendingDomains.has(key)) return;
    this.pendingDomains.add(key);
    try {
      if (this.cache[key] !== expected) return;
      await this.removeCachedFile(expected.url);
      delete this.cache[key];
      this.iconRules.delete(key);
      this.renderRules();
      await this.saveCache();
      this.updateCacheCount();
    } finally {
      this.pendingDomains.delete(key);
      if (!this.settings.pauseAutomaticFetch) this.scheduleScan();
    }
  }

  private async rebuildRules() {
    this.iconRules.clear();
    let cacheChanged = false;
    if (this.settings.enabled) {
      const entries = Object.entries(this.cache).sort(([a], [b]) => Number(a.includes("::")) - Number(b.includes("::")));
      for (const [key, entry] of entries) {
        if (entry.routeKey && this.cache[entry.domain ?? key.split("::")[0]]?.pinned) {
          continue;
        }
        const pausedLegacyMonogram = this.settings.pauseAutomaticFetch
          && entry.source === "generated monogram"
          && entry.resolverVersion !== RESOLVER_VERSION;
        const current = entry.pinned || entry.resolverVersion === RESOLVER_VERSION || pausedLegacyMonogram;
        const fresh = this.settings.pauseAutomaticFetch || this.isCacheEntryFresh(entry);
        if (current && fresh && await this.isStoredIconUsable(entry.url)) {
          const scope = scopeFromCacheKey(key, entry.domain, entry.pathPrefix);
          this.iconRules.set(key, this.createRule(scope, entry.url, entry.source));
        } else {
          await this.removeCachedFile(entry.url);
          delete this.cache[key];
          cacheChanged = true;
        }
      }
    }
    if (cacheChanged) await this.saveCache();
    this.updateCacheCount();
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

  private setRule(scope: LinkScope, url: string, source?: string) {
    if (!this.settings.enabled) return;
    this.iconRules.set(scope.key, this.createRule(scope, url, source));
    this.renderRules();
  }

  private createRule(scope: LinkScope, iconUrl: string, source?: string) {
    const selectors: string[] = [];
    const elements = [
      [".protyle-wysiwyg span[data-type~='a']", "data-href"],
      [".protyle-wysiwyg span[data-type~='url']", "data-href"],
      [".protyle-wysiwyg a", "href"],
      [".b3-typography a", "href"],
    ] as const;
    for (const protocol of ["https", "http"] as const) {
      const match = scopeMatchTarget(scope, protocol);
      for (const [element, attribute] of elements) {
        selectors.push(`${element}[${attribute}=${this.cssString(match.exact)}]::before`);
        for (const boundary of match.boundaries) {
          selectors.push(`${element}[${attribute}^=${this.cssString(match.exact + boundary)}]::before`);
        }
      }
    }
    // Smart mode keeps meaningful link-icon/theme icons, but replaces
    // link-icon's generic net2.svg placeholder. Auto mode gives a retrieved
    // favicon priority while still letting curated icons beat a monogram.
    const smartFill = this.forceDomains.has(scope.key);
    const autoPriority = this.settings.linkIconMode === "auto" && source !== "generated monogram";
    const important = smartFill || autoPriority ? " !important" : "";
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
    // Domain selectors intentionally come first. Route selectors are more
    // specific semantically but use the same CSS specificity, so they must be
    // rendered later to let /doc/ and /sheet/ coexist predictably.
    style.textContent = [...this.iconRules.entries()]
      .sort(([left], [right]) => Number(left.includes("::")) - Number(right.includes("::")))
      .map(([, rule]) => rule)
      .join("\n");
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
