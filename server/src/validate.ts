/**
 * validate.ts — 原文忠実性チェック（Museumルール: 言い換え禁止の機械縛り）
 *
 * 加工禁止フィールドの各valueが job_raw.md 内に部分一致で存在するか検証する。
 * 存在しないvalueがあればエラーを返し、Word生成を阻止する。
 *
 * 許可する正規化（理由: 改行・空白の整理はHTMLからテキスト抽出時に不可避）:
 *   - 前後の空白トリム
 *   - 連続空白→半角スペース1個
 *   - 全角スペース→半角スペース
 *   - 改行→半角スペース（複数行にまたがる原文の合流）
 * 上記以外の文字変換・言い換え・要約は一切許可しない。
 */

import { JobPosting } from "./schema.js";

/** 比較用に正規化: 空白系を統一してトリム */
const normalize = (s: string): string => {
  return s
    .replace(/[\r\n\t\u3000]/g, " ")  // 改行・タブ・全角スペース→半角スペース
    .replace(/\s+/g, " ")              // 連続空白→1個
    .trim();
};

export type FaithfulnessError = {
  field: string;
  value: string;
  reason: string;
};

/**
 * 加工禁止フィールドの各値が原文(rawMd)に含まれるか検証する。
 *
 * @returns violations - 原文に見つからなかった項目の配列。空配列なら合格。
 */
export const checkFaithfulness = (
  job: JobPosting,
  rawMd: string
): FaithfulnessError[] => {
  const violations: FaithfulnessError[] = [];
  const normalizedRaw = normalize(rawMd);

  const check = (field: string, value: string) => {
    const v = normalize(value);
    if (!v) return; // 空値はスキップ（抽出されなかったとみなす）
    if (normalizedRaw.includes(v)) return; // 部分一致OK

    // 短い値(10文字以下)は原文の表記揺れで一致しにくいことがあるため、
    // 単語単位でも検索する（例: "正社員" が原文の "雇用形態: 正社員" に含まれる）
    // → これは normalize 済みの includes で既にカバーされるため追加処理不要

    violations.push({
      field,
      value: value.length > 80 ? value.slice(0, 80) + "…" : value,
      reason: "原文に該当テキストが見つかりません（言い換え・要約の疑い）"
    });
  };

  // --- 加工禁止フィールド ---
  // 業務内容
  for (const item of job.job.responsibilities ?? []) {
    check("job.responsibilities[]", item);
  }

  // 求める経験・スキル（必須）
  for (const item of job.requirements.must ?? []) {
    check("requirements.must[]", item);
  }

  // 求める経験・スキル（歓迎）
  for (const item of job.requirements.want ?? []) {
    check("requirements.want[]", item);
  }

  // 賃金
  if (job.salary.summary) {
    check("salary.summary", job.salary.summary);
  }

  // 賃金詳細
  for (const item of job.salary.details ?? []) {
    check("salary.details[]", item);
  }

  // 休日休暇
  if (job.work.holidays) {
    check("work.holidays", job.work.holidays);
  }

  // 福利厚生
  for (const item of job.benefits.items ?? []) {
    check("benefits.items[]", item);
  }

  // 固定残業代
  if (job.salary.fixedOvertime) {
    if (job.salary.fixedOvertime.amount) {
      check("salary.fixedOvertime.amount", job.salary.fixedOvertime.amount);
    }
    if (job.salary.fixedOvertime.includedHours) {
      check("salary.fixedOvertime.includedHours", job.salary.fixedOvertime.includedHours);
    }
    if (job.salary.fixedOvertime.excessPayment) {
      check("salary.fixedOvertime.excessPayment", job.salary.fixedOvertime.excessPayment);
    }
  }

  return violations;
};
