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
//    { "sega_group": ["セガ","株式会社セガ",...] }
//    → { "セガ": "sega_group", "株式会社セガ": "sega_group", ... }
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
// ---------------------------------------------------------------------------
// D) company_overrides.json — 例外定義（定型差し込み）
//    server/config/company_overrides.json を読み込み、
//    company_key に一致するエントリの fields を欠落項目にのみ注入する。
//    根拠（source URL）を明記することで「原文忠実」の例外を許可する。
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
// D) company_overrides.json — 例外定義（定型差し込み）
// ---------------------------------------------------------------------------

const OVERRIDES_PATH = path.resolve(process.cwd(), "config", "company_overrides.json");

export type CompanyOverrideSource = {
  name: string;
  url: string;
};

export type CompanyOverrideEntry = {
  source: CompanyOverrideSource;
  fields: Record<string, string | string[]>;
};

type OverridesConfig = Record<string, CompanyOverrideEntry>;

let overridesCache: OverridesConfig | null = null;

const loadOverridesConfig = (): OverridesConfig => {
  if (overridesCache) return overridesCache;
  try {
    const raw = fs.readFileSync(OVERRIDES_PATH, "utf8");
    overridesCache = JSON.parse(raw) as OverridesConfig;
  } catch {
    overridesCache = {};
  }
  return overridesCache;
};

export const clearOverridesCache = (): void => {
  overridesCache = null;
};

export type OverrideResult = {
  applied: boolean;
  appliedFields: string[];
  source: CompanyOverrideSource | null;
};

/**
 * company_overrides.json から定型データを読み込み、
 * 欠落しているフィールドのみ job に差し込む（上書き禁止）。
 *
 * 差し込み対象: work.hours / work.holidays / benefits.items /
 *              insurance.socialInsurance / selection.process
 *
 * @returns OverrideResult: applied flag + appliedFields（faithfulness 除外リスト用）
 */
export const applyCompanyOverrides = (
  job: JobPosting,
  companyKey: string | null
): OverrideResult => {
  if (!companyKey) return { applied: false, appliedFields: [], source: null };

  const config = loadOverridesConfig();
  const entry = config[companyKey];
  if (!entry?.fields) return { applied: false, appliedFields: [], source: null };

  const appliedFields: string[] = [];
  const f = entry.fields;

  // work.hours
  if (typeof f["work.hours"] === "string" && f["work.hours"].trim()) {
    if (!isNonEmpty(job.work.hours)) {
      job.work.hours = f["work.hours"];
      appliedFields.push("work.hours");
    }
  }

  // work.holidays
  if (typeof f["work.holidays"] === "string" && f["work.holidays"].trim()) {
    if (!isNonEmpty(job.work.holidays)) {
      job.work.holidays = f["work.holidays"];
      appliedFields.push("work.holidays");
    }
  }

  // benefits.items
  if (Array.isArray(f["benefits.items"])) {
    const overrideItems = f["benefits.items"].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (overrideItems.length > 0 && !isNonEmptyArray(job.benefits.items)) {
      job.benefits.items = overrideItems;
      appliedFields.push("benefits.items");
    }
  }

  // insurance.socialInsurance
  if (typeof f["insurance.socialInsurance"] === "string" && f["insurance.socialInsurance"].trim()) {
    if (!isNonEmpty(job.insurance.socialInsurance)) {
      job.insurance.socialInsurance = f["insurance.socialInsurance"];
      appliedFields.push("insurance.socialInsurance");
    }
  }

  // selection.process
  if (typeof f["selection.process"] === "string" && f["selection.process"].trim()) {
    if (!isNonEmpty(job.selection.process)) {
      job.selection.process = f["selection.process"];
      appliedFields.push("selection.process");
    }
  }

  return {
    applied: appliedFields.length > 0,
    appliedFields,
    source: entry.source ?? null,
  };
};
