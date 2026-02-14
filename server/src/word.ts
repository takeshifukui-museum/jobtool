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
import { listToText, formatPostalCode, formatReadability } from "./extract.js";

const keepLabels = ["賃金", "業務内容", "求める経験・スキル"];

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
    return false;
  }
};

// ---------------------------------------------------------------------------
// レイアウト固定値（Museumルール: AIにレイアウト判断させない）
// ---------------------------------------------------------------------------
const BIZ_UDP_GOTHIC = "BIZ UDPゴシック";
const LOGO_NAME = "museum_logo.png";
const LEFT_DXA = 2000;   // ラベル列幅 (1)
const RIGHT_DXA = 10000; // 値列幅 (5) → 比率 1:5
const BORDER_SIZE = 4;   // 0.5pt (OOXML: 1/8pt 単位 → 4 = 0.5pt)
const BORDER_COLOR = "000000"; // 黒
const MARGIN_TWIPS = 720; // 余白「狭い」(0.5inch = 720twips)

const BORDERS = {
  top:              { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR },
  bottom:           { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR },
  left:             { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR },
  right:            { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR },
  insideHorizontal: { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR },
  insideVertical:   { style: BorderStyle.SINGLE, size: BORDER_SIZE, color: BORDER_COLOR }
};

// ---------------------------------------------------------------------------
// 固定の行順序（Canonical Key 使用 — Ver 0.3）
//   賃金 ← 給与 / 年収 / 月給 / 年収・待遇 / 報酬
//   就業時間 ← 勤務時間 / 就業時間
//   就業場所 ← 勤務地 / 配属先
//   同一keyは1回のみ出力。
// ---------------------------------------------------------------------------
const FIXED_ROW_ORDER = [
  "業務内容",
  "求める経験・スキル",
  "雇用形態",
  "契約期間",
  "試用期間",
  "就業場所",
  "就業時間",
  "休憩時間",
  "休日休暇",
  "時間外労働",
  "賃金",
  "固定残業代（金額）",
  "固定残業代（時間数）",
  "超過分の扱い",
  "社会保険",
  "福利厚生",
  "選考プロセス"
] as const;

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

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
  // 改行を含むテキストは複数 Paragraph に分割
  const lines = text.split("\n");
  const children = lines.map(
    (line) =>
      new Paragraph({
        alignment: opts?.align ?? AlignmentType.LEFT,
        children: [makeRun(line, { bold: opts?.bold })]
      })
  );
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    width: opts?.widthDxa ? { size: opts.widthDxa, type: WidthType.DXA } : undefined,
    children
  });
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

// ---------------------------------------------------------------------------
// render直前の可読性整形 + 郵便番号整形
// ---------------------------------------------------------------------------
const applyRenderFormatting = (text: string): string => {
  return formatReadability(formatPostalCode(text));
};

// ---------------------------------------------------------------------------
// コード生成パス（テンプレートが無い/空の場合）
// 重要: 固定順序。ATS順推定は行わない。
// ---------------------------------------------------------------------------

const renderJobDocxFromScratch = async (
  job: JobPosting,
  opts?: { jobTitle?: string; showFixedOvertime?: boolean }
): Promise<Buffer> => {

  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? job.work.overtime.details
      : job.work.overtime.exists
        ? "あり"
        : ""
    : "";

  // -----------------------------------------------------------------------
  // 固定残業代: 原文に固定残業代関連語が存在する場合のみ表示
  // 分割表示: 金額 / 時間数 / 超過分
  // 未取得項目は出さない ただし表示可能部分は表示する
  // -----------------------------------------------------------------------
  const fo = job.salary.fixedOvertime;
  const showFO = opts?.showFixedOvertime === true && fo;
  const foAmount = showFO ? (fo.amount ?? "").trim() : "";
  const foHours = showFO ? (fo.includedHours ?? "").trim() : "";
  const foExcess = showFO ? (fo.excessPayment ?? "").trim() : "";

  // -----------------------------------------------------------------------
  // 行データ構築（Canonical Key使用、空欄非表示）
  // -----------------------------------------------------------------------
  const rowData: Record<string, string> = {
    "業務内容": applyRenderFormatting(buildJobBlock(job.job)),
    "求める経験・スキル": applyRenderFormatting(joinSkillBlock(job.requirements.must, job.requirements.want)),
    "雇用形態": job.position.employmentType ?? "",
    "契約期間": job.position.contractTerm ?? "",
    "試用期間": job.position.probation ?? "",
    "就業場所": applyRenderFormatting(job.work.location ?? ""),
    "就業時間": job.work.hours ?? "",
    "休憩時間": job.work.breakTime ?? "",
    "休日休暇": applyRenderFormatting(job.work.holidays ?? ""),
    "時間外労働": overtimeText,
    "賃金": [applyRenderFormatting(job.salary.summary), applyRenderFormatting(listToText(job.salary.details))].filter(Boolean).join("\n"),
    "固定残業代（金額）": foAmount,
    "固定残業代（時間数）": foHours,
    "超過分の扱い": foExcess,
    "社会保険": job.insurance.socialInsurance ?? "",
    "福利厚生": applyRenderFormatting(listToText(job.benefits.items)),
    "選考プロセス": job.selection.process ?? ""
  };

  // 固定順序で行を構築。空の行は出さない（valueが空 → 行を出さない）
  // ただし「賃金」は必須項目のため常に表示
  const REQUIRED_LABELS = ["賃金"];
  const rows: Array<[string, string]> = [];
  for (const label of FIXED_ROW_ORDER) {
    const value = (rowData[label] ?? "").trim();
    if (!value && !REQUIRED_LABELS.includes(label)) continue;
    rows.push([label, value]);
  }

  if (rows.length === 0) {
    throw new Error("Word生成に失敗: 差し込み可能な行が0件です。");
  }

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

  // ロゴ右上（ヘッダー）
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
            margin: {
              top: MARGIN_TWIPS,
              bottom: MARGIN_TWIPS,
              left: MARGIN_TWIPS,
              right: MARGIN_TWIPS
            }
          }
        },
        headers: headerChildren.length > 0 ? { default: new Header({ children: headerChildren }) } : undefined,
        children: [
          ...titleLines,
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: BORDERS,
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

// ---------------------------------------------------------------------------
// メインエントリ: テンプレ有無で分岐
// ---------------------------------------------------------------------------

export const renderJobDocx = async (
  job: JobPosting,
  templatePath: string,
  opts?: { jobTitle?: string; showFixedOvertime?: boolean }
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

  const fo = job.salary.fixedOvertime;
  const showFO = opts?.showFixedOvertime !== false && fo;
  const fixedOvertimeText = showFO
    ? [
        fo.amount ? `金額: ${fo.amount}` : "",
        fo.includedHours ? `時間数: ${fo.includedHours}` : "",
        fo.excessPayment ? `超過分: ${fo.excessPayment}` : "",
        fo.notes
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const overtimeText = job.work.overtime
    ? job.work.overtime.details
      ? job.work.overtime.details
      : job.work.overtime.exists
        ? "あり"
        : ""
    : "";

  const data = {
    company: { name: job.company.name },
    position: { title: job.position.title, contractTerm: job.position.contractTerm ?? "" },
    job: {
      responsibilities_text: applyRenderFormatting(listToText(job.job.responsibilities)),
      notes: job.job.notes ?? ""
    },
    requirements: {
      must_text: applyRenderFormatting(listToText(job.requirements.must)),
      want_text: applyRenderFormatting(listToText(job.requirements.want))
    },
    work: {
      location: applyRenderFormatting(job.work.location ?? ""),
      hours: job.work.hours ?? "",
      breakTime: job.work.breakTime ?? "",
      holidays: applyRenderFormatting(job.work.holidays ?? ""),
      overtime_text: overtimeText
    },
    salary: {
      summary: applyRenderFormatting(job.salary.summary),
      details_text: applyRenderFormatting(listToText(job.salary.details)),
      fixedOvertime_text: fixedOvertimeText
    },
    insurance: { socialInsurance: job.insurance.socialInsurance ?? "" },
    benefits: { items_text: applyRenderFormatting(listToText(job.benefits.items)) },
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
