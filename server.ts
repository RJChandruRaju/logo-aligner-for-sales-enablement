import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import sharp from "sharp";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import archiver from "archiver";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log("[SERVER] Initializing...");
  const app = express();
  const PORT = 3000;

  // Ensure temp directories exist in a writable location
  const TEMP_DIR = path.resolve(__dirname, "temp");
  const UPLOADS_DIR = path.resolve(TEMP_DIR, "uploads");
  const PROCESSED_DIR = path.resolve(TEMP_DIR, "processed");
  
  try {
    [TEMP_DIR, UPLOADS_DIR, PROCESSED_DIR].forEach(dir => {
      if (!fs.existsSync(dir)) {
        console.log(`[SERVER] Creating directory: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  } catch (err) {
    console.error("[SERVER] Failed to create directories:", err);
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    },
  });

  const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }
  });

  // Logging middleware
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  const jobs: Record<string, any> = {};

  // API Routes
  const api = express.Router();

  api.get("/health", (req, res) => {
    console.log("[API] Health check");
    res.json({ status: "ok", time: new Date(), env: process.env.NODE_ENV });
  });

  api.post("/upload", upload.array("logos"), (req, res) => {
    console.log("[API] Upload request received");
    const files = req.files as Express.Multer.File[];
    
    if (!files || files.length === 0) {
      console.log("[API] No files in request");
      return res.status(400).json({ error: "No files uploaded" });
    }

    console.log(`[API] Processing ${files.length} files`);
    const jobId = uuidv4();
    let settings = {};
    try {
      settings = typeof req.body.settings === 'string' ? JSON.parse(req.body.settings) : (req.body.settings || {});
    } catch (e) {
      console.error("[API] Settings parse error:", e);
    }

    jobs[jobId] = {
      id: jobId,
      status: "processing",
      total: files.length,
      processed: 0,
      results: [],
      createdAt: new Date(),
    };

    processLogos(jobId, files, settings);
    res.json({ jobId });
  });

  api.get("/job/:jobId", (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });

  api.get("/download/:jobId", async (req, res) => {
    const job = jobs[req.params.jobId];
    if (!job || job.status !== "completed") {
      return res.status(404).json({ error: "Job not found or not completed" });
    }

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment(`logos-${job.id}.zip`);
    archive.pipe(res);

    for (const result of job.results) {
      if (result.status === "success") {
        archive.file(result.outputPath, { name: result.originalName });
      }
    }
    await archive.finalize();
  });

  // Catch-all for API to prevent falling through to Vite
  api.use((req, res) => {
    console.log(`[API] 404: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  app.use("/api", api);
  app.use("/preview", express.static(PROCESSED_DIR));

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    console.log("[SERVER] Mounting Vite middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.resolve(distPath, "index.html")));
    }
  }

  // Error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[SERVER] Error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] Listening on http://0.0.0.0:${PORT}`);
  });

  async function processLogos(jobId: string, files: Express.Multer.File[], settings: any) {
    const job = jobs[jobId];
    const outputSize = parseInt(settings.size) || 1024;
    const paddingPercent = parseFloat(settings.padding) || 15;
    const format = settings.format || "png";

    for (const file of files) {
      try {
        const outputFilename = `processed-${uuidv4()}.${format}`;
        const outputPath = path.join(PROCESSED_DIR, outputFilename);

        const paddingPixels = Math.round(outputSize * (paddingPercent / 100));
        const maxInnerSize = outputSize - paddingPixels * 2;

        let pipeline = sharp(file.path).ensureAlpha().trim();
        const trimmedMetadata = await pipeline.toBuffer({ resolveWithObject: true });
        
        await sharp(trimmedMetadata.data)
          .resize({
            width: maxInnerSize,
            height: maxInnerSize,
            fit: "inside",
            withoutEnlargement: false,
          })
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .toBuffer()
          .then(async (buffer) => {
            const resizedMetadata = await sharp(buffer).metadata();
            const width = resizedMetadata.width || maxInnerSize;
            const height = resizedMetadata.height || maxInnerSize;

            const padLeft = Math.floor((outputSize - width) / 2);
            const padTop = Math.floor((outputSize - height) / 2);
            const padRight = outputSize - width - padLeft;
            const padBottom = outputSize - height - padTop;

            return sharp(buffer)
              .extend({
                top: padTop,
                bottom: padBottom,
                left: padLeft,
                right: padRight,
                background: { r: 255, g: 255, b: 255, alpha: 1 }
              })
              .toFormat(format as any)
              .toFile(outputPath);
          });

        job.results.push({
          status: "success",
          originalName: file.originalname,
          previewUrl: `/preview/${outputFilename}`,
          outputPath: outputPath,
        });
      } catch (error: any) {
        console.error(`[PROCESS] Error processing ${file.originalname}:`, error);
        job.results.push({
          status: "error",
          originalName: file.originalname,
          error: error.message,
        });
      }

      job.processed++;
      try { fs.unlinkSync(file.path); } catch (e) {}
    }
    job.status = "completed";
  }
}

startServer().catch(err => {
  console.error("[SERVER] Startup failed:", err);
});
