import axios from "axios";
import * as cheerio from "cheerio";

export interface ScrapedContent {
  html: string;
  text: string;
  title: string;
}

/**
 * Fetch and extract content from a job posting URL
 */
export async function scrapeJobPosting(url: string): Promise<ScrapedContent> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Fetch the page
  const response = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
    timeout: 30000, // 30 second timeout
  });

  const html = response.data;
  const $ = cheerio.load(html);

  // Remove script and style tags
  $("script, style, noscript, iframe").remove();

  // Get the page title
  const title = $("title").text().trim();

  // Extract main content - try common job posting containers first
  let mainContent = "";

  // HRMOS specific selectors
  const hrmosSelectors = [
    ".job-detail",
    ".job-content",
    ".job-description",
    "[data-job-detail]",
    ".recruit-detail",
  ];

  // Generic job posting selectors
  const genericSelectors = [
    "main",
    "article",
    ".content",
    "#content",
    ".main-content",
    "#main-content",
    ".job-posting",
    ".vacancy-detail",
  ];

  const allSelectors = [...hrmosSelectors, ...genericSelectors];

  for (const selector of allSelectors) {
    const element = $(selector);
    if (element.length > 0) {
      mainContent = element.text();
      if (mainContent.trim().length > 100) {
        break;
      }
    }
  }

  // Fallback to body if no specific container found
  if (!mainContent || mainContent.trim().length < 100) {
    mainContent = $("body").text();
  }

  // Clean up the text
  const cleanedText = mainContent
    .replace(/\s+/g, " ") // Normalize whitespace
    .replace(/\n\s*\n/g, "\n") // Remove multiple newlines
    .trim();

  // Also get the full HTML for more detailed extraction
  const bodyHtml = $("body").html() || "";

  return {
    html: bodyHtml,
    text: cleanedText,
    title: title,
  };
}

/**
 * Extract job posting content with HRMOS-specific handling
 */
export async function extractJobContent(url: string): Promise<string> {
  const scraped = await scrapeJobPosting(url);

  // For HRMOS URLs, we may need special handling
  if (url.includes("hrmos.co")) {
    // HRMOS pages often use JavaScript to load content
    // If the text is too short, the content might not have loaded
    if (scraped.text.length < 200) {
      console.warn(
        "Warning: HRMOS page content may be JavaScript-rendered. Content might be incomplete."
      );
    }
  }

  // Combine title and text for context
  const content = `
ページタイトル: ${scraped.title}

--- ページコンテンツ ---
${scraped.text}
  `.trim();

  return content;
}
