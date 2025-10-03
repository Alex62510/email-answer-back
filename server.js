const express = require("express");
const fs = require("fs");
const path = require("path");
const CloudConvert = require("cloudconvert");
const cors = require("cors");

require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const UPLOAD_DIR = path.join(__dirname, "uploads");
const PDF_DIR = path.join(__dirname, "pdfs");

// Создаем папки если нет
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR);

// Инициализация CloudConvert
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// Вспомогательная функция: конвертация через CloudConvert
async function convertDocToPdf(docPath) {
    const pdfPath = path.join(
        PDF_DIR,
        path.basename(docPath, ".doc") + ".pdf"
    );

    if (fs.existsSync(pdfPath)) return pdfPath;

    const job = await cloudConvert.jobs.create({
        tasks: {
            import_doc: { operation: "import/upload" },
            convert_to_pdf: {
                operation: "convert",
                input: "import_doc",
                input_format: "doc",
                output_format: "pdf"
            },
            export_pdf: { operation: "export/url", input: "convert_to_pdf" }
        }
    });

    const importTask = job.tasks.find(t => t.name === "import_doc");
    await cloudConvert.tasks.upload(importTask, fs.createReadStream(docPath), path.basename(docPath));
    const completedJob = await cloudConvert.jobs.wait(job.id);

    const exportTask = completedJob.tasks.find(t => t.operation === "export/url");
    const pdfUrl = exportTask.result.files[0].url;

    // Сохраняем PDF локально
    const response = await fetch(pdfUrl);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(pdfPath, Buffer.from(buffer));

    return pdfPath;
}

// GET /pdf — возвращает PDF одного документа в uploads
app.get("/pdf", async (req, res) => {
    const files = fs.readdirSync(UPLOAD_DIR).filter(f => f.endsWith(".doc"));

    if (files.length === 0) return res.status(404).json({ error: "No DOC files found" });

    const docPath = path.join(UPLOAD_DIR, files[0]);

    try {
        const pdfPath = await convertDocToPdf(docPath);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `inline; filename="${path.basename(pdfPath)}"`
        );
        res.sendFile(pdfPath);
    } catch (err) {
        console.error("Conversion error:", err);
        res.status(500).json({ error: "Conversion failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
