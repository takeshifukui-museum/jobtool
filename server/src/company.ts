import fs from "node:fs";
import path from "node:path";
import { JobPosting } from "./schema.js";

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

const ALIAS_PATH = path.resolve(process.cwd(), "data", "company_alias.json");

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
  } catch {
    // ファイルが無い場合は空マップ（エラーにしない）
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

const COMPANY_STATIC_DIR = path.resolve(process.cwd(), "data", "company_static");

/**
 * company_static で注入を許可するフィールド一覧（ホワイトリスト方式）。
 * 賃金・勤務地・雇用形態など致命項目は含めない（誤注入防止）。
 */
const ALLOWED_STATIC_FIELDS = [
  "socialInsurance",
  "benefits",
  "selectionProcess",
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
const isNonEmpty = (s: string | undefined | null): boolean =>
  typeof s === "string" && s.trim().length > 0;

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

  if (!isNonEmpty(job.selection.process) && isNonEmpty(data.selectionProcess)) {
    job.selection.process = data.selectionProcess!;
    provenance["selection.process"] = "company_static";
    staticAppliedKeys.push("selection.process");
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
// D) company_profiles.json — 企業プロファイル（定型差し込み + 表示名）
//    server/config/company_profiles.json を読み込み、
//    company_key に一致するプロファイルの defaults を欠落項目にのみ注入する。
//    差し込み対象は 4項目のみ:
//      work.hours / work.holidays / benefits.items / insurance.socialInsurance
//    賃金・固定残業代・雇用形態は絶対に差し込まない。
//    根拠（sources）を明記し、job.meta.injected に記録する。
// ---------------------------------------------------------------------------

const PROFILES_PATH = path.resolve(process.cwd(), "config", "company_profiles.json");

type ResolveHint = { contains: string; key: string };

export type CompanyProfile = {
  displayCompanyName?: string;
  defaults: Record<string, string | string[]>;
  sources: Record<string, string[]>;
};

type ProfilesConfig = {
  _resolveHints?: ResolveHint[];
} & Record<string, CompanyProfile>;

let profilesCache: ProfilesConfig | null = null;

const loadProfilesConfig = (): ProfilesConfig => {
  if (profilesCache) return profilesCache;
  try {
    const raw = fs.readFileSync(PROFILES_PATH, "utf8");
    profilesCache = JSON.parse(raw) as ProfilesConfig;
  } catch {
    profilesCache = {} as ProfilesConfig;
  }
  return profilesCache;
};

export const clearProfilesCache = (): void => {
  profilesCache = null;
};

/**
 * company_alias.json の完全一致で解決できなかった場合のフォールバック。
 * _resolveHints の contains ルールで部分一致を試行する。
 * 先に定義されたルールが優先（より具体的なキーを先に並べる）。
 */
export const resolveCompanyKeyWithHints = (companyName: string): string | null => {
  const config = loadProfilesConfig();
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
 * プロファイルの displayCompanyName を job.company.displayName に設定する。
 * 原文の company.name は変更しない。
 *
 * 方針:
 *   - 原文に「株式会社」が含まれていればそのまま（既に正式名称）
 *   - 含まれていなければプロファイルの displayCompanyName を使用
 */
export const resolveDisplayName = (
  job: JobPosting,
  companyKey: string | null
): string | undefined => {
  if (!companyKey) return undefined;
  const config = loadProfilesConfig();
  const profile = config[companyKey] as CompanyProfile | undefined;
  if (!profile?.displayCompanyName) return undefined;

  const originalName = job.company.name?.trim() ?? "";
  // 既に正式法人名を含んでいる場合はそのまま維持
  if (originalName.includes("株式会社") || originalName.includes("有限会社")) {
    job.company.displayName = originalName;
    return originalName;
  }
  job.company.displayName = profile.displayCompanyName;
  return profile.displayCompanyName;
};

// ---------------------------------------------------------------------------
// E) applyCompanyDefaults — プロファイルからの定型差し込み（4項目限定）
// ---------------------------------------------------------------------------

export type DefaultsResult = {
  applied: boolean;
  appliedFields: string[];
  sources: Record<string, string[]>;
};

/**
 * company_profiles.json の defaults を job に差し込む。
 *
 * 【絶対原則】
 *  - 対象は 4項目のみ: work.hours / work.holidays / benefits.items / insurance.socialInsurance
 *  - 賃金・固定残業代・雇用形態は絶対に差し込まない
 *  - 既に値がある場合は絶対に上書きしない
 *  - 差し込み根拠（sources）を返す
 */
export const applyCompanyDefaults = (
  job: JobPosting,
  companyKey: string | null
): DefaultsResult => {
  const empty: DefaultsResult = { applied: false, appliedFields: [], sources: {} };
  if (!companyKey) return empty;

  const config = loadProfilesConfig();
  const profile = config[companyKey] as CompanyProfile | undefined;
  if (!profile?.defaults) return empty;

  const appliedFields: string[] = [];
  const appliedSources: Record<string, string[]> = {};
  const d = profile.defaults;
  const s = profile.sources ?? {};

  // 1) work.hours
  if (typeof d["work.hours"] === "string" && d["work.hours"].trim()) {
    if (!isNonEmpty(job.work.hours)) {
      job.work.hours = d["work.hours"];
      appliedFields.push("work.hours");
      if (s["work.hours"]) appliedSources["work.hours"] = s["work.hours"];
    }
  }

  // 2) work.holidays
  if (typeof d["work.holidays"] === "string" && d["work.holidays"].trim()) {
    if (!isNonEmpty(job.work.holidays)) {
      job.work.holidays = d["work.holidays"];
      appliedFields.push("work.holidays");
      if (s["work.holidays"]) appliedSources["work.holidays"] = s["work.holidays"];
    }
  }

  // 3) benefits.items (配列) or benefits.text (文字列→配列化)
  const benefitsArr = Array.isArray(d["benefits.items"])
    ? d["benefits.items"].filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : typeof d["benefits.text"] === "string" && d["benefits.text"].trim()
      ? [d["benefits.text"]]
      : [];
  if (benefitsArr.length > 0 && !isNonEmptyArray(job.benefits.items)) {
    job.benefits.items = benefitsArr;
    appliedFields.push("benefits.items");
    const bSrc = s["benefits.items"] ?? s["benefits.text"];
    if (bSrc) appliedSources["benefits.items"] = bSrc;
  }

  // 4) insurance.socialInsurance
  if (typeof d["insurance.socialInsurance"] === "string" && d["insurance.socialInsurance"].trim()) {
    if (!isNonEmpty(job.insurance.socialInsurance)) {
      job.insurance.socialInsurance = d["insurance.socialInsurance"];
      appliedFields.push("insurance.socialInsurance");
      if (s["insurance.socialInsurance"]) appliedSources["insurance.socialInsurance"] = s["insurance.socialInsurance"];
    }
  }

  return {
    applied: appliedFields.length > 0,
    appliedFields,
    sources: appliedSources,
  };
};
