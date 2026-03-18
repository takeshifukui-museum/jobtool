export const normalizeRawText = (rawText: string): string => {
  return rawText.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

export const listToText = (items?: string[]): string => {
  if (!items || items.length === 0) {
    return "";
  }
  return items.filter((item) => item && item.trim() !== "").map((item) => `・${item}`).join("\n");
};
