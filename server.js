// server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { startBot, addSseClient, confirmPendingMail, getPendingMail } from './mailBot.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
}));

// SSE
app.get('/sse', (req, res) => addSseClient(res));

// Подтверждение письма
app.post('/confirm-pdf', async (req, res) => {
    const success = await confirmPendingMail();
    res.json({ success });
});

// Запуск бота
startBot({ email: process.env.IMAP_USER, password: process.env.IMAP_PASS });

// Отдаём последнюю PDF
app.get('/latest-pdf', (req, res) => {
    const pending = getPendingMail();

    if (!pending || !pending.attachment || !fs.existsSync(PDF_PATH)) {
        return res.status(404).json({ message: "PDF ещё не готов" });
    }

    res.json({ pdfUrl: `/pdf/${path.basename(PDF_PATH)}` });
});

// Отдаём сам PDF
app.get('/pdf/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.resolve(`./${filename}`);

    if (!fs.existsSync(filePath)) return res.status(404).send("Файл не найден");

    res.setHeader("Content-Type", "application/pdf");
    res.sendFile(filePath);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
