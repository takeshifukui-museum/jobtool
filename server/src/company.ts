import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { JobPosting } from "./schema.js";

// ---------------------------------------------------------------------------
// A) 企業名の正規化
// ---------------------------------------------------------------------------

export const normalizeCompanyName = (name: string): string => {
  return name.trim();
};

// ---------------------------------------------------------------------------
// B) company_alias.json → company_key 解決
// ---------------------------------------------------------------------------

const ALIAS_PATH = path.resolve(__dirname, "..", "data", "company_alias.json");

type AliasMap = Record<string, string>;

let aliasCache: AliasMap | null = null;

const loadAliasMap = (): AliasMap => {
  if (aliasCache) return aliasCache;
  const map: AliasMap = {};
  try {
    const raw = fs.readFileSync(ALIAS_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, string[]>;
    for (const [companyKey, aliases] of Object.entries(data)) {
      if (!Array.isArray(aliases)) continue;
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.trim()) {
          map[alias.trim()] = companyKey;
        }
      }
    }
  } catch (e) {
    console.warn("[company] company_alias.json 読み込み失敗:", ALIAS_PATH, e);
  }
  aliasCache = map;
  return map;
};

export const resolveCompanyKey = (companyName: string): string | null => {
  const map = loadAliasMap();
  return map[companyName.trim()] ?? null;
};

export const clearAliasCache = (): void => {
  aliasCache = null;
};

// ---------------------------------------------------------------------------
// C) 企業別定型ブロック差し込み（下位互換）
// ---------------------------------------------------------------------------

const COMPANY_STATIC_DIR = path.resolve(__dirname, "..", "data", "company_static");

const ALLOWED_STATIC_FIELDS = [
  "socialInsurance",
  "benefits",
  "holidays",
  "hours",
] as const;

export type CompanyStaticData = {
  socialInsurance?: string;
  benefits?: string[];
  selectionProcess?: string;
  holidays?: string;
  hours?: string;
};

export const loadCompanyStatic = (companyKey: string): CompanyStaticData | null => {
  const safeName = companyKey.replace(/[/\\:*?"<>|]/g, "_").trim();
  if (!safeName) return null;
  const filePath = path.join(COMPANY_STATIC_DIR, `${safeName}.json`);
  try {
    if (!filePath.startsWith(COMPANY_STATIC_DIR)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of ALLOWED_STATIC_FIELDS) {
      if (key in parsed) filtered[key] = parsed[key];
    }
    return filtered as CompanyStaticData;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type FieldSource = "raw" | "company_static";
export type Provenance = Record<string, FieldSource>;
export type MergeResult = {
  provenance: Provenance;
  staticApplied: boolean;
  staticAppliedKeys: string[];
};

const UNKNOWN_VALUES = new Set(["UNKNOWN", "<UNKNOWN>", "unknown", "不明", "N/A", "n/a", "-"]);

const isNonEmpty = (s: string | undefined | null): boolean => {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0) return false;
  if (UNKNOWN_VALUES.has(t)) return false;
  return true;
};

const isNonEmptyArray = (arr: string[] | undefined | null): boolean =>
  Array.isArray(arr) && arr.filter((x) => x.trim()).length > 0;

export const mergeCompanyStatic = (
  job: JobPosting,
  companyKey: string | null,
  enabled: boolean
): MergeResult => {
  const provenance: Provenance = {};
  const staticAppliedKeys: string[] = [];

  if (isNonEmpty(job.insurance.socialInsurance)) provenance["insurance.socialInsurance"] = "raw";
  if (isNonEmptyArray(job.benefits.items)) provenance["benefits.items"] = "raw";
  if (isNonEmpty(job.selection.process)) provenance["selection.process"] = "raw";
  if (isNonEmpty(job.work.holidays)) provenance["work.holidays"] = "raw";
  if (isNonEmpty(job.work.hours)) provenance["work.hours"] = "raw";

  if (!enabled) return { provenance, staticApplied: false, staticAppliedKeys: [] };
  if (!companyKey) return { provenance, staticApplied: false, staticAppliedKeys: [] };

  const data = loadCompanyStatic(companyKey);
  if (!data) return { provenance, staticApplied: false, staticAppliedKeys: [] };

  if (!isNonEmpty(job.insurance.socialInsurance) && isNonEmpty(data.socialInsurance)) {
    job.insurance.socialInsurance = data.socialInsurance!;
    provenance["insurance.socialInsurance"] = "company_static";
    staticAppliedKeys.push("insurance.socialInsurance");
  }

  if (!isNonEmptyArray(job.benefits.items) && isNonEmptyArray(data.benefits)) {
    job.benefits.items = data.benefits!;
    provenance["benefits.items"] = "company_static";
    staticAppliedKeys.push("benefits.items");
  }

  if (!isNonEmpty(job.work.holidays) && isNonEmpty(data.holidays)) {
    job.work.holidays = data.holidays!;
    provenance["work.holidays"] = "company_static";
    staticAppliedKeys.push("work.holidays");
  }

  if (!isNonEmpty(job.work.hours) && isNonEmpty(data.hours)) {
    job.work.hours = data.hours!;
    provenance["work.hours"] = "company_static";
    staticAppliedKeys.push("work.hours");
  }

  return {
    provenance,
    staticApplied: staticAppliedKeys.length > 0,
    staticAppliedKeys,
  };
};

// ---------------------------------------------------------------------------
// D-pre) field_aliases.json
// ---------------------------------------------------------------------------

const FIELD_ALIASES_PATH = path.resolve(__dirname, "..", "config", "field_aliases.json");

type FieldAliasMap = Record<string, string>;
let fieldAliasCache: FieldAliasMap | null = null;

export const loadFieldAliases = (): FieldAliasMap => {
  if (fieldAliasCache) return fieldAliasCache;
  const map: FieldAliasMap = {};
  try {
    const raw = fs.readFileSync(FIELD_ALIASES_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, string[]>;
    for (const [fieldPath, aliases] of Object.entries(data)) {
      if (fieldPath.startsWith("_")) continue;
      if (!Array.isArray(aliases)) continue;
      for (const alias of aliases) {
        if (typeof alias === "string" && alias.trim()) {
          map[alias.trim()] = fieldPath;
        }
      }
    }
  } catch {
    // ファイルが無い場合は空マップ
  }
  fieldAliasCache = map;
  return map;
};

export const clearFieldAliasCache = (): void => {
  fieldAliasCache = null;
};

export const resolveFieldAlias = (label: string): string | null => {
  const map = loadFieldAliases();
  return map[label.trim()] ?? null;
};

// ---------------------------------------------------------------------------
// D) company_overrides.json — 企業定型差し込み
// ---------------------------------------------------------------------------

const OVERRIDES_PATH = path.resolve(__dirname, "..", "config", "company_overrides.json");

type ResolveHint = { contains: string; key: string };
type OverrideSource = { url: string; title?: string; last_verified?: string };

export type CompanyOverrideEntry = {
  enabled: boolean;
  displayCompanyName?: string;
  source: OverrideSource;
  allowed_fields?: string[];
  force_fields?: string[];
  fields: Record<string, string | string[]>;
};

type OverridesGlobalConfig = {
  default_allowed_fields: string[];
  never_allow_fields_prefix: string[];
};

type OverridesConfig = {
  _config?: OverridesGlobalConfig;
  _resolveHints?: ResolveHint[];
} & Record<string, CompanyOverrideEntry>;

let overridesCache: OverridesConfig | null = null;

const loadOverridesConfig = (): OverridesConfig => {
  if (overridesCache) return overridesCache;
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, "utf8");
    overridesCache = JSON.parse(raw) as OverridesConfig;
    console.log("[company] company_overrides.json 読み込み成功, keys:", Object.keys(overridesCache).filter(k => !k.startsWith("_")));
  } catch (e) {
    console.warn("[company] company_overrides.json 読み込み失敗:", OVERRIDES_PATH, e);
  }
  return overridesCache ?? ({} as OverridesConfig);
};

export const clearOverridesCache = (): void => {
  overridesCache = null;
};

export const resolveCompanyKeyWithHints = (companyName: string): string | null => {
  const config = loadOverridesConfig();
  const hints = config._resolveHints;
  if (!hints || !Array.isArray(hints)) return null;
  const name = companyName.trim();
  for (const hint of hints) {
    if (name.includes(hint.contains)) {
      return hint.key;
    }
  }
  return null;
};

export const resolveDisplayName = (
  job: JobPosting,
  companyKey: string | null
): string | undefined => {
  if (!companyKey) return undefined;
  const config = loadOverridesConfig();
  const entry = config[companyKey] as CompanyOverrideEntry | undefined;
  if (!entry?.displayCompanyName) return undefined;

  const originalName = job.company.name?.trim() ?? "";
  if (originalName.includes("株式会社") || originalName.includes("有限会社")) {
    job.company.displayName = originalName;
    return originalName;
  }
  job.company.displayName = entry.displayCompanyName;
  return entry.displayCompanyName;
};

export const getDisplayCompanyName = (companyKey: string | null): string | undefined => {
  if (!companyKey) return undefined;
  const config = loadOverridesConfig();
  const entry = config[companyKey] as CompanyOverrideEntry | undefined;
  return entry?.displayCompanyName;
};

// ---------------------------------------------------------------------------
// E) applyCompanyDefaults — overrides からの定型差し込み
// ---------------------------------------------------------------------------

export type DefaultsResult = {
  applied: boolean;
  appliedFields: string[];
  sources: Record<string, string[]>;
  companyKey: string | null;
  sourceUrl: string | null;
};

const isNeverAllowed = (field: string, neverPrefixes: string[]): boolean =>
  neverPrefixes.some((prefix) => field === prefix || field.startsWith(prefix + "."));

export const applyCompanyDefaults = (
  job: JobPosting,
  companyKey: string | null
): DefaultsResult => {
  const empty: DefaultsResult = { applied: false, appliedFields: [], sources: {}, companyKey, sourceUrl: null };

  if (!companyKey) return empty;

  const config = loadOverridesConfig();
  const entry = config[companyKey] as CompanyOverrideEntry | undefined;

  if (!entry?.enabled) return empty;
  if (!entry.source?.url?.trim()) return empty;
  if (!entry.fields) return empty;

  const globalConfig = config._config;
  const allowedFields = entry.allowed_fields
    ?? globalConfig?.default_allowed_fields
    ?? ["work.hours", "work.holidays", "work.break", "work.probation", "benefits.items", "insurance.socialInsurance"];
  const forceFields = entry.force_fields ?? [];
  const neverPrefixes = globalConfig?.never_allow_fields_prefix ?? [];

  const appliedFields: string[] = [];
  const appliedSources: Record<string, string[]> = {};
  const d = entry.fields;
  const sourceUrl = entry.source.url;

  const canApply = (field: string): boolean =>
    allowedFields.includes(field) && !isNeverAllowed(field, neverPrefixes);

  const shouldForce = (field: string): boolean =>
    forceFields.includes(field) && !isNeverAllowed(field, neverPrefixes);

  // 1) work.hours
  if (canApply("work.hours") && typeof d["work.hours"] === "string" && d["work.hours"].trim()) {
    if (!isNonEmpty(job.work.hours)) {
      job.work.hours = d["work.hours"];
      appliedFields.push("work.hours");
      appliedSources["work.hours"] = [sourceUrl];
    }
  }

  // 2) work.holidays
  if (canApply("work.holidays") && typeof d["work.holidays"] === "string" && d["work.holidays"].trim()) {
    if (!isNonEmpty(job.work.holidays)) {
      job.work.holidays = d["work.holidays"];
      appliedFields.push("work.holidays");
      appliedSources["work.holidays"] = [sourceUrl];
    }
  }

// 3) work.break（休憩時間）
  if (canApply("work.break") && typeof d["work.break"] === "string" && d["work.break"].trim()) {
    if (!isNonEmpty(job.work.breakTime)) {
      job.work.breakTime = d["work.break"];
      appliedFields.push("work.break");
      appliedSources["work.break"] = [sourceUrl];
    }
  }

  // 4) work.probation（試用期間）
  if (canApply("work.probation") && typeof d["work.probation"] === "string" && d["work.probation"].trim()) {
    if (!isNonEmpty((job.position as any).probation)) {
      (job.position as any).probation = d["work.probation"];
      appliedFields.push("work.probation");
      appliedSources["work.probation"] = [sourceUrl];
    }
  }

  // 5) benefits.items（force_fields に含まれていれば強制上書き）
  if (canApply("benefits.items") || shouldForce("benefits.items")) {
    const benefitsArr = Array.isArray(d["benefits.items"])
      ? d["benefits.items"].filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : typeof d["benefits.text"] === "string" && d["benefits.text"].trim()
        ? [d["benefits.text"]]
        : [];
    if (benefitsArr.length > 0 && (!isNonEmptyArray(job.benefits.items) || shouldForce("benefits.items"))) {
      job.benefits.items = benefitsArr;
      appliedFields.push("benefits.items");
      appliedSources["benefits.items"] = [sourceUrl];
    }
  }

  // 6) insurance.socialInsurance
  if (canApply("insurance.socialInsurance") && typeof d["insurance.socialInsurance"] === "string" && d["insurance.socialInsurance"].trim()) {
    if (!isNonEmpty(job.insurance.socialInsurance)) {
      job.insurance.socialInsurance = d["insurance.socialInsurance"];
      appliedFields.push("insurance.socialInsurance");
      appliedSources["insurance.socialInsurance"] = [sourceUrl];
    }
  }

  return {
    applied: appliedFields.length > 0,
    appliedFields,
    sources: appliedSources,
    companyKey,
    sourceUrl,
  };
};