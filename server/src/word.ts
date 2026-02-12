import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import expressionParser from "docxtemplater/js/expressions.js";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Header,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from "docx";
import { JobPosting } from "./schema.js";
import { listToText } from "./extract.js";

const keepLabels = ["賃金", "給与", "業務内容", "求める経験・スキル"];

const removeEmptyRows = (docxBuffer: Buffer): Buffer => {
  const zip = new PizZip(docxBuffer);
  const documentXml = zip.file("word/document.xml")?.asText();
  if (!documentXml) {
    return docxBuffer;
  }

  const rows = documentXml.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? [];
  const cleanedRows = rows.filter((row) => {
    const cells = row.match(/<w:tc[\s\S]*?<\/w:tc>/g) ?? [];
    if (cells.length < 2) {
      return true;
    }
    const getText = (cell: string) => {
      const texts = cell.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [];
      return texts
        .map((text) => text.replace(/<w:t[^>]*>/g, "").replace(/<\/w:t>/g, ""))
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    };
    const leftText = getText(cells[0] ?? "");
    const rightText = getText(cells[1] ?? "");
    const shouldKeep = keepLabels.some((label) => leftText.includes(label));
    if (shouldKeep) {
      return true;
    }
    return rightText !== "";
  });

  const updatedXml = documentXml.replace(/<w:tr[\s\S]*?<\/w:tr>/g, () => cleanedRows.shift() ?? "");
  zip.file("word/document.xml", updatedXml);
  return zip.generate({ type: "nodebuffer" });
};

const isTemplateLikelyBlank = (template: Buffer): boolean => {
  try {
    const zip = new PizZip(template);
    const xml = zip.file("word/document.xml")?.asText() ?? "";
    const hasTextNode = xml.includes("<w:t");
    const hasTemplateTag = xml.includes("{") && xml.includes("}");
    return !hasTextNode && !hasTemplateTag;
  } catch {
    // 破損zipは別の箇所で弾くので、ここでは「空扱い」にはしない
    return false;
  }
};

const BIZ_UDP_GOTHIC = "BIZ UDPゴシック";
const LOGO_NAME = "museum_logo.png";

const resolveLogoPath = (): string | null => {
  const dirFromThisFile = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(dirFromThisFile, "..", "..", "assets", LOGO_NAME),
    path.resolve(process.cwd(), "..", "assets", LOGO_NAME),
    path.resolve(process.cwd(), "assets", LOGO_NAME)
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0) return p;
    } catch {
      continue;
    }
  }
  return null;
};

const loadLogo = (): { data: Buffer; path: string } | null => {
  const p = resolveLogoPath();
  if (!p) return null;
  try {
    const buf = fs.readFileSync(p);
    if (buf.length === 0) return null;
    return { data: buf, path: p };
  } catch {
    return null;
  }
};

const makeRun = (text: string, opts?: { bold?: boolean; size?: number }) => {
  return new TextRun({
    text,
    bold: opts?.bold ?? false,
    size: opts?.size,
    font: BIZ_UDP_GOTHIC
  });
};

type AlignmentValue = (typeof AlignmentType)[keyof typeof AlignmentType];

const makeCell = (text: string, opts?: { bold?: boolean; align?: AlignmentValue; widthDxa?: number }) => {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    width: opts?.widthDxa ? { size: opts.widthDxa, type: WidthType.DXA } : undefined,
    children: [
      new Paragraph({
        alignment: opts?.align ?? AlignmentType.LEFT,
        children: [makeRun(text, { bold: opts?.bold })]
      })
    ]
  });
};

const buildAtsOrder = (rawText?: string): string[] => {
  const text = String(rawText ?? "");
  if (!text) return [];
  const keys: Array<{ key: string; patterns: RegExp[] }> = [
    { key: "job", patterns: [/業務内容/g, /仕事内容/g] },
    { key: "skills", patterns: [/求める経験・スキル/g, /求めるスキル/g, /必須スキル/g, /歓迎スキル/g, /応募資格/g] },
    { key: "work", patterns: [/勤務地/g, /勤務時間/g, /就業時間/g, /休憩/g, /勤務条件/g] },
    { key: "holidays", patterns: [/休日休暇/g, /休日/g] },
    { key: "salary", patterns: [/給与/g, /賃金/g, /年収/g, /月給/g] },
    { key: "benefits", patterns: [/福利厚生/g, /待遇/g] },
    { key: "insurance", patterns: [/社会保険/g, /保険/g] },
    { key: "selection", patterns: [/選考/g, /選考プロセス/g] }
  ];
  const found: Array<{ key: string; idx: number }> = [];
  for (const k of keys) {
    let min = Number.POSITIVE_INFINITY;
    for (const p of k.patterns) {
      const m = p.exec(text);
      if (m && typeof m.index === "number") {
        min = Math.min(min, m.index);
      }
      p.lastIndex = 0;
    }
    if (min !== Number.POSITIVE_INFINITY) found.push({ key: k.key, idx: min });
  }
  return found.sort((a, b) => a.idx - b.idx).map((x) => x.key);
};

const joinSkillBlock = (must: string[], want: string[]): string => {
  const mustText = listToText(must);
  const wantText = listToText(want);
  const parts: string[] = [];
  if (mustText) parts.push("【必須】\n" + mustText);
  if (wantText) parts.push("【歓迎】\n" + wantText);
  return parts.join("\n\n");
};

const buildJobBlock = (job: JobPosting["job"]): string => {
  const lines: string[] = [];
  const desc = (job.description ?? "").trim();
  if (desc) lines.push(desc);
  const bullets = (job.responsibilities ?? []).filter((x) => x && x.trim() !== "");
  if (bullets.length > 0) lines.push(listToText(bullets));
  const notes = (job.notes ?? "").trim();
  if (notes) lines.push(notes);
  return lines.join("\n\n").trim();
};

const renderJobDocxFromScratch = async (job: JobPosting, opts?: { rawText?: string; jobTitle?: string }): Promise<Buffer> => {
  const borders = {
    top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "000000" }
  };

  const fixedOvertimeText = job.salary.fixedOvertime
    ? [
        `固定残業代: ${job.salary.fixedOvertime.includedHours}`,
        `超過分: ${job.salary.fixedOvertime.excessPayment}`,
        job.salary.fixedOvertime.notes
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? `時間外労働: ${job.work.overtime.details}`
      : job.work.overtime.exists
        ? "時間外労働あり"
        : "時間外労働なし"
    : "";

  // 必須: 賃金は空にしない（空の場合はサーバ側でエラーにする想定）
  const baseRows: Record<string, Array<[string, string]>> = {
    job: [["業務内容", buildJobBlock(job.job)]],
    skills: [["求める経験・スキル", joinSkillBlock(job.requirements.must, job.requirements.want)]],
    work: [
      ["勤務地", job.work.location ?? ""],
      ["勤務時間", job.work.hours ?? ""],
      ["休憩時間", job.work.breakTime ?? ""],
      ["契約期間", job.position.contractTerm ?? ""],
      ["試用期間", job.position.probation ?? ""]
    ],
    holidays: [["休日休暇", job.work.holidays ?? ""]],
    salary: [
      ["賃金", job.salary.summary],
      ["年収・待遇", listToText(job.salary.details)]
    ],
    benefits: [["福利厚生", listToText(job.benefits.items)]],
    insurance: [["社会保険", job.insurance.socialInsurance ?? ""]],
    selection: [["選考プロセス", job.selection.process ?? ""]]
  };

  // 条項順（ATS順）を rawText から推定して適用。見つからない場合は固定順。
  const order = buildAtsOrder(opts?.rawText);
  const defaultOrder = ["job", "skills", "work", "holidays", "salary", "benefits", "insurance", "selection"];
  const keys = order.length > 0 ? order : defaultOrder;

  const rows: Array<[string, string]> = [];
  for (const k of keys) {
    const group = baseRows[k];
    if (!group) continue;
    for (const [label, value] of group) {
      const v = String(value ?? "").trim();
      // 「存在しない項目は生成しない」: 空は出さない（賃金は例外として必須）
      if (!v && label !== "賃金") continue;
      rows.push([label, v]);
    }

    // overtime は work/holidays 付近に来ることが多いので work グループの直後で差し込む
    if (k === "work") {
      if (overtimeText && overtimeText.trim() !== "") rows.push(["時間外労働", overtimeText]);
      if (fixedOvertimeText && fixedOvertimeText.trim() !== "") rows.push(["固定残業代", fixedOvertimeText]);
    }
  }

  // 時間外労働は情報が無い場合は項目自体を削除（ルール遵守）
  if (overtimeText && overtimeText.trim() !== "") {
    rows.push(["時間外労働", overtimeText]);
  }

  rows.push(["賃金", job.salary.summary]);
  rows.push(["賃金詳細", listToText(job.salary.details)]);

  if (fixedOvertimeText && fixedOvertimeText.trim() !== "") {
    rows.push(["固定残業代", fixedOvertimeText]);
  }

  rows.push(["社会保険", job.insurance.socialInsurance ?? ""]);
  rows.push(["福利厚生", listToText(job.benefits.items)]);
  rows.push(["選考プロセス", job.selection.process ?? ""]);

  const LEFT_DXA = 2000; // 1
  const RIGHT_DXA = 10000; // 5
  const tableRows = rows.map(([label, value]) => {
    return new TableRow({
      children: [
        makeCell(label, { bold: true, align: AlignmentType.CENTER, widthDxa: LEFT_DXA }),
        makeCell(value || "", { bold: false, align: AlignmentType.LEFT, widthDxa: RIGHT_DXA })
      ]
    });
  });

  const logo = loadLogo();
  if (!logo) {
    console.warn(`[word] logo not found: assets/${LOGO_NAME} (optional)`);
  } else {
    console.log(`[word] logo loaded`, { path: logo.path, size: logo.data.length });
  }

  const headerChildren = logo
    ? [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new ImageRun({
              type: "png",
              data: logo.data,
              transformation: { width: 220, height: 56 }
            })
          ]
        })
      ]
    : [];

  // タイトル（24pt/太字/中央）＋企業名・ポジション名（中央）
  const titleLines: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [makeRun("求人票", { bold: true, size: 48 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [makeRun(job.company.name, { size: 28 })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [makeRun(job.position.title || (opts?.jobTitle ?? ""), { size: 28 })]
    }),
    new Paragraph({ text: "" })
  ];

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 }
          }
        },
        headers: headerChildren.length > 0 ? { default: new Header({ children: headerChildren }) } : undefined,
        children: [
          ...titleLines,
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders,
            alignment: AlignmentType.CENTER,
            columnWidths: [LEFT_DXA, RIGHT_DXA],
            rows: tableRows
          })
        ]
      }
    ]
  });

  return await Packer.toBuffer(doc);
};

export const renderJobDocx = async (
  job: JobPosting,
  templatePath: string,
  opts?: { rawText?: string; jobTitle?: string }
): Promise<Buffer> => {
  const template = fs.readFileSync(templatePath);
  if (template.length === 0) {
    throw new Error(`テンプレートが空です: ${templatePath}. 有効な .docx ファイルを配置してください。`);
  }
  const useTemplate = process.env.USE_TEMPLATE === "1" && !isTemplateLikelyBlank(template);
  if (!useTemplate) {
    console.log(`[word] using code-generated docx (USE_TEMPLATE!=1 or blank template)`);
    return await renderJobDocxFromScratch(job, opts);
  }
  const zip = new PizZip(template);
  const parser = (expressionParser as any).configure({}) as any;
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, parser } as any);

  const fixedOvertimeText = job.salary.fixedOvertime
    ? [
        `固定残業代: ${job.salary.fixedOvertime.includedHours}`,
        `超過分: ${job.salary.fixedOvertime.excessPayment}`,
        job.salary.fixedOvertime.notes
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? `時間外労働: ${job.work.overtime.details}`
      : job.work.overtime.exists
        ? "時間外労働あり"
        : "時間外労働なし"
    : "";

  const data = {
    company: { name: job.company.name },
    position: { title: job.position.title, contractTerm: job.position.contractTerm ?? "" },
    job: {
      responsibilities_text: listToText(job.job.responsibilities),
      notes: job.job.notes ?? ""
    },
    requirements: {
      must_text: listToText(job.requirements.must),
      want_text: listToText(job.requirements.want)
    },
    work: {
      location: job.work.location ?? "",
      hours: job.work.hours ?? "",
      breakTime: job.work.breakTime ?? "",
      holidays: job.work.holidays ?? "",
      overtime_text: overtimeText
    },
    salary: {
      summary: job.salary.summary,
      details_text: listToText(job.salary.details),
      fixedOvertime_text: fixedOvertimeText
    },
    insurance: { socialInsurance: job.insurance.socialInsurance ?? "" },
    benefits: { items_text: listToText(job.benefits.items) },
    selection: { process: job.selection.process ?? "" }
  };

  try {
    doc.render(data);
  } catch (renderError) {
    const msg = renderError instanceof Error ? renderError.message : String(renderError);
    throw new Error(`Word差し込みに失敗しました: ${msg}`);
  }
  const rendered = doc.getZip().generate({ type: "nodebuffer" });
  return removeEmptyRows(rendered);
};

const TEMPLATE_NAME = "museum_template.docx";

export const resolveTemplatePath = (): string => {
  const dirFromThisFile = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(dirFromThisFile, "..", "templates", TEMPLATE_NAME),
    path.resolve(dirFromThisFile, "..", "..", "templates", TEMPLATE_NAME),
    path.resolve(process.cwd(), "templates", TEMPLATE_NAME),
    path.resolve(process.cwd(), "..", "templates", TEMPLATE_NAME)
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size > 0) return p;
    } catch {
      continue;
    }
  }
  throw new Error(
    `テンプレートが見つかりません。以下のいずれかに ${TEMPLATE_NAME} を配置してください（空のファイルは不可）: ${candidates.join(", ")}`
  );
};

export const getTemplateStat = (templatePath: string): { exists: boolean; size: number } => {
  try {
    const stat = fs.statSync(templatePath);
    return { exists: stat.isFile(), size: stat.size };
  } catch {
    return { exists: false, size: 0 };
  }
};
