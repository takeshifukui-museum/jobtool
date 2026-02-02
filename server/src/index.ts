// IMPORTANT: dotenv must be loaded first
import "dotenv/config";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { extractJobContent } from "./scraper.js";
import { extractJobPosting } from "./openai.js";
import { generateWordDocument, generateFilename } from "./word.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get("/api/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main endpoint: Generate job posting document
app.post("/api/generate", async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const { url } = req.body;

    // Validate request
    if (!url) {
      console.error("Error: URL is required");
      res.status(400).send("URLを入力してください");
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      console.error(`Error: Invalid URL format: ${url}`);
      res.status(400).send("無効なURL形式です");
      return;
    }

    console.log(`Processing URL: ${url}`);

    // Step 1: Scrape the job posting page
    console.log("Step 1: Scraping job posting...");
    let content: string;
    try {
      content = await extractJobContent(url);
      console.log(`Scraped content length: ${content.length} characters`);
    } catch (err) {
      const error = err as Error;
      console.error(`Scraping error: ${error.message}`);
      res.status(500).send(`ページの取得に失敗しました: ${error.message}`);
      return;
    }

    // Step 2: Extract structured data using OpenAI
    console.log("Step 2: Extracting job posting data with OpenAI...");
    let jobPosting;
    try {
      jobPosting = await extractJobPosting(content, url);
      console.log(`Extracted job posting for: ${jobPosting.company.name} - ${jobPosting.position}`);
    } catch (err) {
      const error = err as Error;
      console.error(`OpenAI extraction error: ${error.message}`);
      console.error(error.stack);
      res.status(500).send(`求人情報の抽出に失敗しました: ${error.message}`);
      return;
    }

    // Step 3: Generate Word document
    console.log("Step 3: Generating Word document...");
    let docBuffer: Buffer;
    try {
      docBuffer = await generateWordDocument(jobPosting);
      console.log(`Generated document size: ${docBuffer.length} bytes`);
    } catch (err) {
      const error = err as Error;
      console.error(`Word generation error: ${error.message}`);
      console.error(error.stack);
      res.status(500).send(`Word文書の生成に失敗しました: ${error.message}`);
      return;
    }

    // Generate filename following Museum format
    const filename = generateFilename(jobPosting);
    console.log(`Generated filename: ${filename}`);

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Content-Length", docBuffer.length);

    // Send the document
    res.send(docBuffer);

    const duration = Date.now() - startTime;
    console.log(`Request completed in ${duration}ms`);
  } catch (err) {
    const error = err as Error;
    console.error("Unexpected error:", error.message);
    console.error(error.stack);
    res.status(500).send(`予期しないエラーが発生しました: ${error.message}`);
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("Unhandled error:", err.message);
  console.error(err.stack);
  res.status(500).send(`サーバーエラー: ${err.message}`);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API endpoint: POST http://localhost:${PORT}/api/generate`);

  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.warn("WARNING: OPENAI_API_KEY is not set in environment variables");
  } else {
    console.log("OpenAI API key loaded successfully");
  }
});
