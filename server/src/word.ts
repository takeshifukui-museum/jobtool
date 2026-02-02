import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  AlignmentType,
  WidthType,
  BorderStyle,
  VerticalAlign,
  HeadingLevel,
  PageBreak,
  ImageRun,
  Header,
  convertInchesToTwip,
} from "docx";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { JobPosting } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Font name for the document
const FONT_NAME = "BIZ UDPゴシック";

// Border style for table cells
const tableBorder = {
  style: BorderStyle.SINGLE,
  size: 8, // approximately 0.5pt
  color: "000000",
};

const cellBorders = {
  top: tableBorder,
  bottom: tableBorder,
  left: tableBorder,
  right: tableBorder,
};

interface TableRowData {
  label: string;
  value: string;
}

function createTableCell(
  text: string,
  isHeader: boolean = false,
  width?: number
): TableCell {
  return new TableCell({
    borders: cellBorders,
    width: width
      ? { size: width, type: WidthType.DXA }
      : { size: 0, type: WidthType.AUTO },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: isHeader ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [
          new TextRun({
            text: text,
            font: FONT_NAME,
            size: 22, // 11pt
            bold: isHeader,
          }),
        ],
      }),
    ],
  });
}

function createTableRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      createTableCell(label, true, 2500), // Fixed width for label column
      createTableCell(value, false),
    ],
  });
}

function sanitizeFilename(name: string): string {
  // Replace prohibited characters with underscore
  return name.replace(/[/\\:*?"<>|]/g, "_");
}

export function generateFilename(jobPosting: JobPosting): string {
  const companyName = sanitizeFilename(jobPosting.company.name || "企業名不明");
  const position = sanitizeFilename(jobPosting.position || "ポジション不明");
  return `求人票_${companyName}_${position}.docx`;
}

export async function generateWordDocument(
  jobPosting: JobPosting
): Promise<Buffer> {
  // Build table rows from job posting data
  const rows: TableRowData[] = [];

  // Company information
  if (jobPosting.company.name) {
    rows.push({ label: "企業名", value: jobPosting.company.name });
  }
  if (jobPosting.company.description) {
    rows.push({ label: "企業概要", value: jobPosting.company.description });
  }

  // Position
  if (jobPosting.position) {
    rows.push({ label: "採用ポジション", value: jobPosting.position });
  }

  // Job description (must not be summarized - original text)
  if (jobPosting.job) {
    rows.push({ label: "業務内容", value: jobPosting.job });
  }

  // Requirements (must not be summarized - original text)
  if (jobPosting.requirements.required && jobPosting.requirements.required.length > 0) {
    rows.push({
      label: "求める経験・スキル（必須）",
      value: jobPosting.requirements.required.join("\n"),
    });
  }
  if (jobPosting.requirements.preferred && jobPosting.requirements.preferred.length > 0) {
    rows.push({
      label: "求める経験・スキル（歓迎）",
      value: jobPosting.requirements.preferred.join("\n"),
    });
  }

  // Work conditions
  if (jobPosting.work.contract) {
    rows.push({ label: "契約期間", value: jobPosting.work.contract });
  }
  if (jobPosting.work.location) {
    rows.push({ label: "就業場所", value: jobPosting.work.location });
  }
  if (jobPosting.work.hours) {
    rows.push({ label: "就業時刻", value: jobPosting.work.hours });
  }
  if (jobPosting.work.break) {
    rows.push({ label: "休憩時間", value: jobPosting.work.break });
  }
  if (jobPosting.work.holidays) {
    rows.push({ label: "休日休暇", value: jobPosting.work.holidays });
  }
  // Only include overtime if it has a value (not empty string)
  if (jobPosting.work.overtime && jobPosting.work.overtime.trim() !== "") {
    rows.push({ label: "時間外労働", value: jobPosting.work.overtime });
  }

  // Salary (required - must always be included)
  rows.push({ label: "賃金", value: jobPosting.salary || "要確認" });

  // Insurance
  if (jobPosting.insurance) {
    rows.push({ label: "社会保険", value: jobPosting.insurance });
  }

  // Benefits (must not be summarized - original text)
  if (jobPosting.benefits) {
    rows.push({ label: "福利厚生", value: jobPosting.benefits });
  }

  // Selection process
  if (jobPosting.selection) {
    rows.push({ label: "選考プロセス", value: jobPosting.selection });
  }

  // Compliance notes
  if (jobPosting.compliance.notes) {
    rows.push({ label: "備考", value: jobPosting.compliance.notes });
  }

  // Try to load logo image
  let logoImage: ImageRun | undefined;
  const logoPath = path.resolve(__dirname, "../../templates/museum_logo.png");
  if (fs.existsSync(logoPath)) {
    const logoData = fs.readFileSync(logoPath);
    logoImage = new ImageRun({
      data: logoData,
      transformation: {
        width: 100,
        height: 40,
      },
      type: "png",
    });
  }

  // Create table rows
  const tableRows = rows.map((row) => createTableRow(row.label, row.value));

  // Create the table
  const table = new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    rows: tableRows,
  });

  // Create document sections
  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "求人票",
          font: FONT_NAME,
          size: 48, // 24pt
          bold: true,
        }),
      ],
    })
  );

  // Company name and position (centered below title)
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: jobPosting.company.name || "",
          font: FONT_NAME,
          size: 28, // 14pt
        }),
      ],
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [
        new TextRun({
          text: jobPosting.position || "",
          font: FONT_NAME,
          size: 28, // 14pt
        }),
      ],
    })
  );

  // Add the table
  children.push(table);

  // Create header with logo (right-aligned)
  const headerChildren: Paragraph[] = [];
  if (logoImage) {
    headerChildren.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [logoImage],
      })
    );
  }

  // Create document with narrow margins
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(0.5),
              right: convertInchesToTwip(0.5),
              bottom: convertInchesToTwip(0.5),
              left: convertInchesToTwip(0.5),
            },
          },
        },
        headers: headerChildren.length > 0 ? {
          default: new Header({
            children: headerChildren,
          }),
        } : undefined,
        children: children,
      },
    ],
    styles: {
      default: {
        document: {
          run: {
            font: FONT_NAME,
            size: 22, // 11pt default
          },
        },
      },
    },
  });

  // Generate buffer
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}
