import { JobPosting } from "./schema.js";

const forbiddenPatterns: { label: string; regex: RegExp }[] = [
  { label: "年齢", regex: /\d+\s*歳/g },
  { label: "性別", regex: /(性別|男性|女性|men|women|男性のみ|女性のみ)/gi },
  { label: "国籍", regex: /(国籍|外国籍|日本国籍|Japanese nationality)/gi },
  { label: "病歴", regex: /(病歴|疾患|障害|うつ|精神疾患|既往歴)/gi }
];

const scrubString = (value: string, detected: string[]): string => {
  let result = value;
  for (const pattern of forbiddenPatterns) {
    const matches = result.match(pattern.regex);
    if (matches) {
      detected.push(...matches.map((match) => `${pattern.label}:${match}`));
      result = result.replace(pattern.regex, "").replace(/\s{2,}/g, " ").trim();
    }
  }
  return result;
};

const walk = (value: unknown, detected: string[]): unknown => {
  if (typeof value === "string") {
    return scrubString(value, detected);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => walk(item, detected))
      .filter((item) => typeof item !== "string" || item.trim() !== "");
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = walk(item, detected);
    }
    return next;
  }
  return value;
};

const containsForbidden = (value: unknown): string[] => {
  const found: string[] = [];
  const check = (item: unknown) => {
    if (typeof item === "string") {
      for (const pattern of forbiddenPatterns) {
        const matches = item.match(pattern.regex);
        if (matches) {
          found.push(...matches.map((match) => `${pattern.label}:${match}`));
        }
      }
    } else if (Array.isArray(item)) {
      item.forEach(check);
    } else if (item && typeof item === "object") {
      Object.values(item).forEach(check);
    }
  };
  check(value);
  return found;
};

export const sanitizeJobPosting = (job: JobPosting): { sanitized: JobPosting; forbiddenDetected: string[] } => {
  const forbiddenDetected: string[] = [];
  const sanitized = walk(job, forbiddenDetected) as JobPosting;
  const remaining = containsForbidden(sanitized);
  if (remaining.length > 0) {
    forbiddenDetected.push(...remaining.map((item) => `remaining:${item}`));
  }
  return { sanitized, forbiddenDetected };
};
