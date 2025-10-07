import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import {
    startBot,
    addSseClient,
    getPendingMail,
    confirmPendingMail,
} from './mailBot.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Абсолютный путь к последнему PDF
export const PDF_PATH = path.resolve('./latest.pdf');

app.use(express.json());

app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
}));

// SSE — поток событий для фронта
app.get('/sse', (req, res) => addSseClient(res));

// Подтверждение письма
app.post('/confirm-pdf', async (req, res) => {
    try {
        const success = await confirmPendingMail();
        res.json({ success });
    } catch (err) {
        console.error('Ошибка при подтверждении письма:', err);
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// Запуск IMAP-бота
startBot({
    email: process.env.IMAP_USER,
    password: process.env.IMAP_PASS
});

// Проверка наличия последнего PDF
app.get('/latest-pdf', (req, res) => {
    if (!fs.existsSync(PDF_PATH)) {
        return res.status(404).json({ message: 'PDF ещё не готов' });
    }
    res.json({ pdfUrl: `/pdf/latest.pdf` });
});

// Отдача самого PDF
app.get('/pdf/:filename', (req, res) => {
    if (!fs.existsSync(PDF_PATH)) {
        return res.status(404).send('Файл не найден');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(PDF_PATH);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
