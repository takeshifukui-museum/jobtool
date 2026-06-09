import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JobPosting } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// A) 企業名の正規化（外部辞書なし → 原文トリムのみ）
//    ハードコード辞書は廃止。company_alias.json による company_key 解決に一本化。
// ---------------------------------------------------------------------------

/**
 * company.name をトリムする。
 * ハードコード辞書は廃止済み。原文の表記をそのまま維持する。
 */
export const normalizeCompanyName = (name: string): string => {
  return name.trim();
};

// ---------------------------------------------------------------------------
// B) company_alias.json → company_key 解決
//    server/data/company_alias.json を起動時に読み込み、逆引きマップを構築。
//    { "sega": ["セガ","株式会社セガ"], "sega_sapporo_studio": [...], ... }
//    → { "セガ": "sega", "株式会社セガ": "sega", ... }
//    完全一致で解決できない場合は company_profiles._resolveHints で
//    部分一致（contains）ルールを試行する。
// ---------------------------------------------------------------------------

const ALIAS_PATH = path.resolve(__dirname, "..", "data", "company_alias.json");

type AliasMap = Record<string, string>; // alias → company_key

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
    console.warn("[company] company_alias.json 読み込み失敗（パス:", ALIAS_PATH, "）", e instanceof Error ? e.message : e);
    return map;
  }
  aliasCache = map;
  return map;
};

/**
 * 企業名から company_key を解決する（完全一致のみ）。
 * company_alias.json に登録されていない企業名は null を返す。
 */
export const resolveCompanyKey = (companyName: string): string | null => {
  const map = loadAliasMap();
  return map[companyName.trim()] ?? null;
};

/**
 * alias キャッシュをクリア（テスト用 / 設定変更後の再読込用）。
 */
export const clearAliasCache = (): void => {
  aliasCache = null;
};

// ---------------------------------------------------------------------------
// C) 企業別定型ブロック差し込み（一般化・デフォルトOFF・上書き禁止）
//    server/data/company_static/<company_key>.json を読み込んで merge する。
//    enabled=false のときは絶対に何もしない（出力影響ゼロ）。
//    ※ company_profiles.json (D) が優先。static は下位互換として残す。
// ---------------------------------------------------------------------------

const COMPANY_STATIC_DIR = path.resolve(__dirname, "..", "data", "company_static");

/**
 * company_static で注入を許可するフィールド一覧（ホワイトリスト方式）。
 * 賃金・勤務地・雇用形態など致命項目は含めない（誤注入防止）。
 */
const ALLOWED_STATIC_FIELDS = [
  "socialInsurance",
  "benefits",
  // "selectionProcess" は定型差し込み禁止（求人本文に記載がある場合のみ出力）
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

/**
 * company_key から定型データを読み込む。
 * ファイルが無い場合は null を返す。
 */
export const loadCompanyStatic = (companyKey: string): CompanyStaticData | null => {
  const safeName = companyKey.replace(/[/\\:*?"<>|]/g, "_").trim();
  if (!safeName) return null;
  const filePath = path.join(COMPANY_STATIC_DIR, `${safeName}.json`);
  try {
    if (!filePath.startsWith(COMPANY_STATIC_DIR)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // ホワイトリストに無いフィールドは除外
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
// Provenance: フィールドごとの出典追跡
// ---------------------------------------------------------------------------

export type FieldSource = "raw" | "company_static";

export type Provenance = Record<string, FieldSource>;

export type MergeResult = {
  provenance: Provenance;
  staticApplied: boolean;
  staticAppliedKeys: string[];
};

/** 文字列が非空かどうか */
const UNKNOWN_VALUES = new Set(["UNKNOWN", "<UNKNOWN>", "unknown", "不明", "N/A", "n/a", "-"]);

const isNonEmpty = (s: string | undefined | null): boolean => {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0) return false;
  if (UNKNOWN_VALUES.has(t)) return false;
  return true;
};

/** 配列が非空かどうか（空文字のみの配列は空扱い） */
const isNonEmptyArray = (arr: string[] | undefined | null): boolean =>
  Array.isArray(arr) && arr.filter((x) => x.trim()).length > 0;

/**
 * 企業定型データを job にマージする（不足フィールドのみ注入、上書き禁止）。
 *
 * @param job        マージ対象の JobPosting
 * @param companyKey resolveCompanyKey で得た company_key（null なら何もしない）
 * @param enabled    true のときのみ注入する（ENABLE_COMPANY_STATIC 環境変数で制御）
 * @returns          MergeResult: provenance + staticApplied + staticAppliedKeys
 */
export const mergeCompanyStatic = (
  job: JobPosting,
  companyKey: string | null,
  enabled: boolean
): MergeResult => {
  const provenance: Provenance = {};
  const staticAppliedKeys: string[] = [];

  // デフォルトは全フィールド "raw"
  if (isNonEmpty(job.insurance.socialInsurance)) provenance["insurance.socialInsurance"] = "raw";
  if (isNonEmptyArray(job.benefits.items)) provenance["benefits.items"] = "raw";
  if (isNonEmpty(job.selection.process)) provenance["selection.process"] = "raw";
  if (isNonEmpty(job.work.holidays)) provenance["work.holidays"] = "raw";
  if (isNonEmpty(job.work.hours)) provenance["work.hours"] = "raw";

  // enabled=false → 絶対に何もマージしない
  if (!enabled) return { provenance, staticApplied: false, staticAppliedKeys: [] };

  // company_key が無い → マージ不可
  if (!companyKey) return { provenance, staticApplied: false, staticAppliedKeys: [] };

  const data = loadCompanyStatic(companyKey);
  if (!data) return { provenance, staticApplied: false, staticAppliedKeys: [] };

  // 上書き禁止: 値が空/未設定のフィールドだけ埋める
  // 注入元が空文字・空配列なら注入しない

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

  // selectionProcess は定型差し込み禁止（求人本文記載のみ出力）

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
// D-pre) field_aliases.json — 見出しラベル同義語マッピング
//   server/config/field_aliases.json を読み込み、見出し→canonical フィールドパスの
//   逆引きマップを構築する。
// ---------------------------------------------------------------------------

const FIELD_ALIASES_PATH = path.resolve(__dirname, "..", "config", "field_aliases.json");

type FieldAliasMap = Record<string, string>; // label → canonical field path

let fieldAliasCache: FieldAliasMap | null = null;

/**
 * field_aliases.json を読み込み、ラベル→フィールドパスの逆引きマップを返す。
 * 例: { "所在地": "work.location", "勤務地": "work.location", ... }
 */
export const loadFieldAliases = (): FieldAliasMap => {
  if (fieldAliasCache) return fieldAliasCache;
  const map: FieldAliasMap = {};
  try {
    const raw = fs.readFileSync(FIELD_ALIASES_PATH, "utf8");
    const data = JSON.parse(raw) as Record<string, string[]>;
    for (const [fieldPath, aliases] of Object.entries(data)) {
      if (fieldPath.startsWith("_")) continue; // _doc 等のメタ項目をスキップ
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

/**
 * 見出しラベルから canonical フィールドパスを解決する。
 * field_aliases.json に登録されていないラベルは null を返す。
 */
export const resolveFieldAlias = (label: string): string | null => {
  const map = loadFieldAliases();
  return map[label.trim()] ?? null;
};

// ---------------------------------------------------------------------------
// D) company_overrides.json — 企業定型差し込み（統合設定ファイル）
//    server/config/company_overrides.json を読み込み、
//    company_key に一致するエントリの fields を欠落項目にのみ注入する。
//    差し込み条件:
//      - enabled=true かつ source.url が存在する場合のみ適用
//      - allowed_fields（無ければ _config.default_allowed_fields）に含まれるもののみ
//      - _config.never_allow_fields_prefix に該当するものは絶対に差し込まない
//      - 既に値がある場合は絶対に上書きしない
//    根拠（source.url）を job.meta.injected に記録する。
// ---------------------------------------------------------------------------

const OVERRIDES_PATH = path.resolve(__dirname, "..", "config", "company_overrides.json");

type ResolveHint = { contains: string; key: string };

type OverrideSource = {
  url: string;
  title?: string;
  last_verified?: string;
};

export type CompanyOverrideEntry = {
  enabled: boolean;
  displayCompanyName?: string;
  source: OverrideSource;
  allowed_fields?: string[];
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
  } catch (e) {
    console.warn("[company] company_overrides.json 読み込み失敗（パス:", OVERRIDES_PATH, "）", e instanceof Error ? e.message : e);
    return {} as OverridesConfig;
  }
  return overridesCache;
};

export const clearOverridesCache = (): void => {
  overridesCache = null;
};

/**
 * company_alias.json の完全一致で解決できなかった場合のフォールバック。
 * _resolveHints の contains ルールで部分一致を試行する。
 * 先に定義されたルールが優先（より具体的なキーを先に並べる）。
 */
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

/**
 * overrides の displayCompanyName を job.company.displayName に設定する。
 * 原文の company.name は変更しない。
 *
 * 方針:
 *   - 原文に「株式会社」が含まれていればそのまま（既に正式名称）
 *   - 含まれていなければ overrides の displayCompanyName を使用
 */
export const resolveDisplayName = (
  job: JobPosting,
  companyKey: string | null
): string | undefined => {
  if (!companyKey) return undefined;
  const config = loadOverridesConfig();
  const entry = config[companyKey] as CompanyOverrideEntry | undefined;
  if (!entry?.displayCompanyName) return undefined;

  const originalName = job.company.name?.trim() ?? "";
  // 既に正式法人名を含んでいる場合はそのまま維持
  if (originalName.includes("株式会社") || originalName.includes("有限会社")) {
    job.company.displayName = originalName;
    return originalName;
  }
  job.company.displayName = entry.displayCompanyName;
  return entry.displayCompanyName;
};

/**
 * company_key から displayCompanyName を取得する（ファイル名用）。
 * job オブジェクトを変更しない読み取り専用版。
 */
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

/** フィールドが never_allow に該当するか */
const isNeverAllowed = (field: string, neverPrefixes: string[]): boolean =>
  neverPrefixes.some((prefix) => field === prefix || field.startsWith(prefix + "."));

/**
 * company_overrides.json の fields を job に差し込む。
 *
 * 【適用条件】
 *  - enabled=true かつ source.url がある場合のみ
 *  - allowed_fields（無ければ default_allowed_fields）に含まれるもののみ
 *  - never_allow_fields_prefix に該当するものは絶対に差し込まない
 *  - 既に値がある場合は絶対に上書きしない
 */
export const applyCompanyDefaults = (
  job: JobPosting,
  companyKey: string | null
): DefaultsResult => {
  const empty: DefaultsResult = { applied: false, appliedFields: [], sources: {}, companyKey, sourceUrl: null };
  if (!companyKey) return empty;

  const config = loadOverridesConfig();
  const entry = config[companyKey] as CompanyOverrideEntry | undefined;

  // enabled=false or 未定義 → 適用しない
  if (!entry?.enabled) return empty;
  // source.url 必須（根拠URL無しでは差し込み禁止）
  if (!entry.source?.url?.trim()) return empty;
  if (!entry.fields) return empty;

  const globalConfig = config._config;
  const allowedFields = entry.allowed_fields
    ?? globalConfig?.default_allowed_fields
    ?? ["work.hours", "work.holidays", "benefits.items", "insurance.socialInsurance"];
  const neverPrefixes = globalConfig?.never_allow_fields_prefix ?? [];

  const appliedFields: string[] = [];
  const appliedSources: Record<string, string[]> = {};
  const d = entry.fields;
  const sourceUrl = entry.source.url;

  // 差し込みヘルパー: allowed かつ never_allow でないフィールドだけ処理
  const canApply = (field: string): boolean =>
    allowedFields.includes(field) && !isNeverAllowed(field, neverPrefixes);

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

  // 3) benefits.items (配列) or benefits.text (文字列→配列化)
  if (canApply("benefits.items")) {
    const benefitsArr = Array.isArray(d["benefits.items"])
      ? d["benefits.items"].filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : typeof d["benefits.text"] === "string" && d["benefits.text"].trim()
        ? [d["benefits.text"]]
        : [];
    if (benefitsArr.length > 0 && !isNonEmptyArray(job.benefits.items)) {
      job.benefits.items = benefitsArr;
      appliedFields.push("benefits.items");
      appliedSources["benefits.items"] = [sourceUrl];
    }
  }

  // 4) insurance.socialInsurance
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
