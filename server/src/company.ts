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

const COMPANY_STATIC_DIR = path.resolve(process.cwd(), "data", "company_static");

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
    return JSON.parse(raw) as CompanyStaticData;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Provenance: フィールドごとの出典追跡
// ---------------------------------------------------------------------------

export type FieldSource = "raw" | "company_static";

export type Provenance = Record<string, FieldSource>;

/**
 * 企業定型データを job にマージする（不足フィールドのみ注入、上書き禁止）。
 *
 * @param job        マージ対象の JobPosting
 * @param companyKey resolveCompanyKey で得た company_key（null なら何もしない）
 * @param enabled    true のときのみ注入する（ENABLE_COMPANY_STATIC 環境変数で制御）
 * @returns          provenance: 各フィールドの出典情報
 */
export const mergeCompanyStatic = (
  job: JobPosting,
  companyKey: string | null,
  enabled: boolean
): Provenance => {
  const provenance: Provenance = {};

  // デフォルトは全フィールド "raw"
  if (job.insurance.socialInsurance?.trim()) provenance["insurance.socialInsurance"] = "raw";
  if (job.benefits.items?.filter((x) => x.trim()).length > 0) provenance["benefits.items"] = "raw";
  if (job.selection.process?.trim()) provenance["selection.process"] = "raw";
  if (job.work.holidays?.trim()) provenance["work.holidays"] = "raw";
  if (job.work.hours?.trim()) provenance["work.hours"] = "raw";

  // enabled=false → 絶対に何もマージしない
  if (!enabled) return provenance;

  // company_key が無い → マージ不可
  if (!companyKey) return provenance;

  const data = loadCompanyStatic(companyKey);
  if (!data) return provenance;

  // 上書き禁止: 値が空/未設定のフィールドだけ埋める
  if (!job.insurance.socialInsurance?.trim() && data.socialInsurance) {
    job.insurance.socialInsurance = data.socialInsurance;
    provenance["insurance.socialInsurance"] = "company_static";
  }

  if ((!job.benefits.items || job.benefits.items.filter((x) => x.trim()).length === 0) && data.benefits) {
    job.benefits.items = data.benefits;
    provenance["benefits.items"] = "company_static";
  }

  if (!job.selection.process?.trim() && data.selectionProcess) {
    job.selection.process = data.selectionProcess;
    provenance["selection.process"] = "company_static";
  }

  if (!job.work.holidays?.trim() && data.holidays) {
    job.work.holidays = data.holidays;
    provenance["work.holidays"] = "company_static";
  }

  if (!job.work.hours?.trim() && data.hours) {
    job.work.hours = data.hours;
    provenance["work.hours"] = "company_static";
  }

  return provenance;
};
