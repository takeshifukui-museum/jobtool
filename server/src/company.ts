import fs from "node:fs";
import path from "node:path";
import { JobPosting } from "./schema.js";

// ---------------------------------------------------------------------------
// A) 企業名の正規化辞書（完全一致のみ。company.name フィールド限定）
//    推測補完は禁止。辞書に無い会社名は原文維持。
// ---------------------------------------------------------------------------
const COMPANY_NAME_DICT: Record<string, string> = {
  "セガ": "株式会社セガ",
  "SEGA": "株式会社セガ",
  // 必要に応じてここに追加
};

/**
 * company.name を辞書で正規化する（完全一致のみ）。
 * 辞書に無い場合は原文維持。
 */
export const normalizeCompanyName = (name: string): string => {
  const trimmed = name.trim();
  return COMPANY_NAME_DICT[trimmed] ?? trimmed;
};

// ---------------------------------------------------------------------------
// G) 企業定型ブロック差し込み口（今回はデフォルトOFF）
//    company_static/<company_key>.json を読み込んで merge する関数。
//    今回の出力には影響させない。
// ---------------------------------------------------------------------------
const COMPANY_STATIC_DIR = path.resolve(process.cwd(), "company_static");
const ENABLE_COMPANY_STATIC = process.env.ENABLE_COMPANY_STATIC === "1";

type CompanyStaticData = {
  socialInsurance?: string;
  benefits?: string[];
  selectionProcess?: string;
};

/**
 * 企業キーから定型データを読み込む。
 * ファイルが無い / ENABLE_COMPANY_STATIC=1 でない場合は null を返す。
 */
export const loadCompanyStatic = (companyKey: string): CompanyStaticData | null => {
  if (!ENABLE_COMPANY_STATIC) return null;
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

/**
 * 企業定型データを job にマージする（空の項目のみ上書き）。
 * ENABLE_COMPANY_STATIC=1 でなければ何もしない。
 */
export const mergeCompanyStatic = (job: JobPosting): void => {
  const data = loadCompanyStatic(job.company.name);
  if (!data) return;
  if (!job.insurance.socialInsurance?.trim() && data.socialInsurance) {
    job.insurance.socialInsurance = data.socialInsurance;
  }
  if ((!job.benefits.items || job.benefits.items.filter((x) => x.trim()).length === 0) && data.benefits) {
    job.benefits.items = data.benefits;
  }
  if (!job.selection.process?.trim() && data.selectionProcess) {
    job.selection.process = data.selectionProcess;
  }
};
