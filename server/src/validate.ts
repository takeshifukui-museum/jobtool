/**
 * validate.ts — Ver 0.3.4 バリデーション
 *
 * 1) faithfulnessCheck — job.json の各 value が job_raw.md に部分一致で存在するか検証
 *    許可: 改行→スペース、連続空白→1個、全角スペース→半角スペース、前後トリム
 *    禁止: 言い換え・要約・再構成
 *
 * 2) requiredFieldsCheck — 真の必須項目の欠落チェック（停止条件）
 *    業務内容 / 勤務地 / 賃金
 *    欠落時は Word 生成停止
 *
 * 3) optionalFieldWarnings — 任意項目の欠落警告（停止しない）
 *    就業時間 / 休日休暇 / 福利厚生 / 社会保険 / 選考プロセス
 *    欠落でも出力自体は続行（空欄は非表示）
 */

import { JobPosting } from "./schema.js";

// ---------------------------------------------------------------------------
// 比較用正規化: 空白系を統一してトリム
// ---------------------------------------------------------------------------
const normalize = (s: string): string => {
  return s
    .replace(/[\r\n\t\u3000]/g, " ")  // 改行・タブ・全角スペース→半角スペース
    .replace(/\s+/g, " ")              // 連続空白→1個
    .trim();
};

// ---------------------------------------------------------------------------
// faithfulnessCheck
// ---------------------------------------------------------------------------

/** 検証除外パス（メタデータ系・evidence系は原文に存在しなくて当然） */
const EXCLUDED_PREFIXES = [
  "schemaVersion",
  "source.",
  "compliance.",
  "requirements.title",  // 固定値 "求める経験・スキル"
  "position.background",
  "company.summary",
  // evidence フィールドは検証用メタデータなので faithfulness チェック対象外
  "company.nameEvidence",
  "position.titleEvidence",
  "position.employmentTypeEvidence",
  "position.contractTermEvidence",
  "work.locationEvidence",
  "salary.summaryEvidence",
];

const isExcluded = (path: string): boolean => {
  return EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
};

export type FaithfulnessMissing = {
  path: string;
  value: string;
};

export type FaithfulnessResult = {
  ok: boolean;
  missing: FaithfulnessMissing[];
};

/**
 * job.json 内の各フィールド（文字列/配列）を再帰走査し、
 * 空でない value が rawMd に部分一致で存在するか検証する。
 * 見つからない value があれば ok=false。
 */
export const faithfulnessCheck = (
  job: JobPosting,
  rawMd: string
): FaithfulnessResult => {
  const missing: FaithfulnessMissing[] = [];
  const normalizedRaw = normalize(rawMd);

  const check = (fieldPath: string, value: string) => {
    if (isExcluded(fieldPath)) return;
    const v = normalize(value);
    if (!v) return; // 空値はスキップ
    if (normalizedRaw.includes(v)) return; // 部分一致OK
    missing.push({
      path: fieldPath,
      value: value.length > 80 ? value.slice(0, 80) + "…" : value,
    });
  };

  const walk = (obj: unknown, prefix: string) => {
    if (typeof obj === "string") {
      check(prefix, obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "string") {
          check(prefix + "[]", item);
        }
      }
      return;
    }
    if (obj && typeof obj === "object") {
      for (const [key, val] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof val === "boolean" || typeof val === "number") continue;
        walk(val, path);
      }
    }
  };

  walk(job, "");

  return { ok: missing.length === 0, missing };
};

// ---------------------------------------------------------------------------
// requiredFieldsCheck
// ---------------------------------------------------------------------------

export type RequiredFieldDetail = {
  key: string;         // canonical label (e.g., "業務内容")
  jsonPath: string;    // JSON path (e.g., "job.responsibilities[]")
  present: boolean;
  checkedValue: string; // 先頭80文字まで（debug用）
};

export type RequiredFieldsResult = {
  ok: boolean;
  missingKeys: string[];
  details: RequiredFieldDetail[];
};

/**
 * 真の必須項目（停止条件）の欠落チェック。
 * 欠落時は Word 生成を停止する。
 *
 * 真の必須: 業務内容 / 勤務地 / 賃金
 * （企業名・ポジション名は index.ts 側で別途チェック済み）
 *
 * 就業時間・休日休暇・福利厚生・社会保険・選考プロセスは
 * 停止条件にしない（optionalFieldWarnings で警告のみ）。
 */
export const requiredFieldsCheck = (job: JobPosting): RequiredFieldsResult => {
  const getPreview = (v: unknown): string => {
    const s = typeof v === "string" ? v.trim() : Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).join(" / ") : "";
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  };

  const responsibilities = (job.job.responsibilities ?? []).filter((x) => x.trim());
  const checks: Array<{ key: string; jsonPath: string; present: boolean; value: unknown }> = [
    { key: "業務内容",   jsonPath: "job.responsibilities[]", present: responsibilities.length > 0, value: responsibilities },
    { key: "勤務地",     jsonPath: "work.location",          present: Boolean(job.work.location?.trim()), value: job.work.location },
    { key: "賃金",       jsonPath: "salary.summary",         present: Boolean(job.salary.summary?.trim()), value: job.salary.summary },
  ];

  const details: RequiredFieldDetail[] = checks.map((c) => ({
    key: c.key,
    jsonPath: c.jsonPath,
    present: c.present,
    checkedValue: getPreview(c.value),
  }));

  const missingKeys = checks.filter((c) => !c.present).map((c) => c.key);
  return { ok: missingKeys.length === 0, missingKeys, details };
};

// ---------------------------------------------------------------------------
// optionalFieldWarnings — 任意項目の欠落警告（停止しない）
// ---------------------------------------------------------------------------

export type OptionalFieldWarning = {
  key: string;
  jsonPath: string;
  present: boolean;
};

export type OptionalFieldsResult = {
  warnings: string[];
  details: OptionalFieldWarning[];
};

/**
 * 任意項目の欠落を警告形式で返す。停止はしない。
 * 空欄項目は Word 側で非表示にする。
 */
export const optionalFieldWarnings = (job: JobPosting): OptionalFieldsResult => {
  const checks: Array<{ key: string; jsonPath: string; present: boolean }> = [
    { key: "就業時間",     jsonPath: "work.hours",             present: Boolean(job.work.hours?.trim()) },
    { key: "休日休暇",     jsonPath: "work.holidays",          present: Boolean(job.work.holidays?.trim()) },
    { key: "福利厚生",     jsonPath: "benefits.items[]",       present: (job.benefits.items ?? []).filter((x) => x.trim()).length > 0 },
    { key: "社会保険",     jsonPath: "insurance.socialInsurance", present: Boolean(job.insurance.socialInsurance?.trim()) },
    { key: "選考プロセス", jsonPath: "selection.process",       present: Boolean(job.selection.process?.trim()) },
  ];

  const details: OptionalFieldWarning[] = checks.map((c) => ({
    key: c.key,
    jsonPath: c.jsonPath,
    present: c.present,
  }));

  const warnings = checks
    .filter((c) => !c.present)
    .map((c) => `OPTIONAL_MISSING: ${c.key} (${c.jsonPath})`);

  return { warnings, details };
};

// ---------------------------------------------------------------------------
// 後方互換: 旧 checkFaithfulness 形式（popup.js の表示用に維持）
// ---------------------------------------------------------------------------
export type FaithfulnessError = {
  field: string;
  value: string;
  reason: string;
};

/** faithfulnessCheck の結果を旧形式に変換 */
export const toFaithfulnessErrors = (result: FaithfulnessResult): FaithfulnessError[] => {
  return result.missing.map((m) => ({
    field: m.path,
    value: m.value,
    reason: "原文に該当テキストが見つかりません（言い換え・要約の疑い）",
  }));
};
