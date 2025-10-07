import Imap from 'imap';
import fs from 'fs';
import path from 'path';
import textract from 'textract';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { extractNeededInfo } from './parser.js';
import { decode } from 'iconv-lite';

dotenv.config();

let imap;
let interval;
let _pendingMail = null;
let currentCreds = null;
let sseClients = [];

const PDF_PATH = path.resolve('./latest.pdf'); // путь для последнего PDF

// =================== START / STOP BOT ===================
export function startBot(creds) {
    currentCreds = creds;

    function connect() {
        if (imap) imap.end();

        imap = new Imap({
            user: creds.email,
            password: creds.password,
            host: process.env.IMAP_HOST,
            port: parseInt(process.env.IMAP_PORT),
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            keepalive: {
                interval: 10000,
                idleInterval: 300000,
                forceNoop: true
            },
            authTimeout: 10000
        });

        imap.once('ready', () => {
            console.log('📥 IMAP connected as', creds.email);
            checkMail();
            if (interval) clearInterval(interval);
            interval = setInterval(checkMail, 60_000);
        });

        imap.once('error', err => {
            console.error('IMAP error:', err);
            console.log('🔁 Reconnect in 5s...');
            setTimeout(connect, 5000);
        });

        imap.once('end', () => {
            console.log('⚠️ IMAP connection ended. Reconnecting...');
            setTimeout(connect, 5000);
        });

        imap.connect();
    }

    connect();
}

export function stopBot() {
    if (imap) {
        clearInterval(interval);
        imap.end();
        imap = null;
        console.log('🛑 Bot stopped');
    }
}

// =================== SSE ===================
export function addSseClient(res) {
    sseClients.push(res);
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('\n');

    res.on('close', () => {
        console.log('❌ SSE client disconnected');
        sseClients = sseClients.filter(c => c !== res);
    });
}

function notifyNewMail(pending) {
    const data = JSON.stringify({ filename: pending.attachment.filename, info: pending.info });
    console.log('📡 Отправляем SSE уведомление фронту:', data);
    sseClients.forEach(res => res.write(`data: ${data}\n\n`));
}

// =================== PENDING MAIL ===================
export function getPendingMail() {
    return _pendingMail;
}

export function clearPendingMail() {
    _pendingMail = null;
}

// =================== HELPERS ===================
function openInbox(cb) {
    imap.openBox('INBOX', false, cb);
}

function markAsSeen(uid) {
    imap.addFlags(uid, '\\Seen', err => {
        if (err) console.error('Error marking as seen:', err);
        else console.log(`👁 Email ${uid} помечен как прочитанный`);
    });
}

function findAttachmentParts(struct, attachments = []) {
    for (const s of struct) {
        if (Array.isArray(s)) findAttachmentParts(s, attachments);
        else {
            console.log('📦 Checking part:', s.disposition?.type, s.type, s.subtype, s.params?.name);
            if (s.disposition && s.disposition.type.toUpperCase() === 'ATTACHMENT') {
                attachments.push(s);
                console.log('✅ Attachment found:', s.disposition.params.filename);
            }
        }
    }
    return attachments;
}

function fetchAttachment(uid, part, callback) {
    console.log(`📥 Fetching attachment UID:${uid} PartID:${part.partID} Filename:${part.disposition?.params?.filename}`);
    const f = imap.fetch(uid, { bodies: [part.partID], struct: true });
    f.on('message', msg => {
        msg.on('body', async stream => {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            console.log(`📄 Attachment fetched, size: ${buffer.length} bytes`);
            callback(buffer, part);
        });
    });
}

function extractTextFromFile(filePath) {
    return new Promise((resolve, reject) => {
        textract.fromFileWithPath(filePath, (err, text) => {
            if (err) return reject(err);
            resolve(text);
        });
    });
}

// =================== CHECK MAIL ===================
async function checkMail() {
    console.log('🔍 Checking new mails...');
    openInbox(err => {
        if (err) return console.error('Error opening INBOX:', err);

        imap.search(['UNSEEN', ['FROM', process.env.TARGET_SENDER]], (err, results) => {
            if (err) return console.error('Search error:', err);
            if (!results || !results.length) {
                console.log('📭 Новых писем нет');
                return;
            }

            console.log('📬 Found messages:', results);

            const f = imap.fetch(results, { bodies: '', struct: true });
            f.on('message', msg => {
                let uid;
                msg.on('attributes', attrs => {
                    uid = attrs.uid;
                    const attachments = findAttachmentParts(attrs.struct);

                    attachments.forEach(part => {
                        let filename = part.disposition.params.filename;

                        // декодируем base64 имя, если оно закодировано
                        if (/=\?UTF-8\?B\?/.test(filename)) {
                            const base64 = filename.match(/=\?UTF-8\?B\?(.*)\?=/)[1];
                            filename = Buffer.from(base64, 'base64').toString('utf8');
                        }

                        console.log('📎 Decoded filename:', filename);

                            if (!filename.endsWith('.doc') && !filename.endsWith('.docx')) return;

                            const tempPath = path.resolve(`temp_${filename}`);
                            fs.writeFileSync(tempPath, buffer);
                            console.log(`💾 Временный файл сохранён: ${tempPath}`);

                            try {
                                console.log(`📄 Обрабатываем файл: ${filename}`);
                                const text = await extractTextFromFile(tempPath);
                                console.log('📝 Текст извлечён из документа');

                                const info = extractNeededInfo(text);
                                console.log('🔍 Информация из текста извлечена:', info);

                                console.log('⏳ Начинаем конвертацию в PDF...');
                                const pdfBuffer = await convertToPDF(tempPath);
                                console.log('✅ Конвертация завершена');

                                fs.writeFileSync(PDF_PATH, pdfBuffer);
                                console.log('💾 PDF сохранён:', PDF_PATH);

                                _pendingMail = { uid, info, attachment: { filename: PDF_PATH, content: pdfBuffer } };
                                markAsSeen(uid);
                                console.log(`📤 DOC обработан и PDF готов: ${filename}`);
                                notifyNewMail(_pendingMail);

                            } catch (e) {
                                console.error('❌ Ошибка при обработке файла:', e);
                            } finally {
                                fs.unlinkSync(tempPath);
                                console.log('🗑 Временный файл удалён:', tempPath);
                            }
                        });
                    });
                });
            });
        });
    });
}

// =================== CLOUDCONVERT ===================
async function convertToPDF(filePath) {
    console.log('🚀 Отправка файла на CloudConvert:', filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const formData = new FormData();
    formData.append('file', fileBuffer, path.basename(filePath));
    formData.append('outputformat', 'pdf');

    const response = await fetch('https://api.cloudconvert.com/v2/convert', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.CLOUDCONVERT_API_KEY}`
        },
        body: formData
    });

    if (!response.ok) {
        console.error('❌ Ошибка конвертации в PDF:', response.statusText);
        throw new Error('PDF conversion failed');
    }

    console.log('📤 PDF успешно получен от CloudConvert');
    const data = await response.arrayBuffer();
    return Buffer.from(data);
}

// =================== SEND REPLY ===================
export async function sendReply(info, attachment) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT),
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
        from: currentCreds.email,
        to: process.env.TARGET_SENDER,
        subject: 'Ответ на письмо',
        text: info,
        attachments: [
            {
                filename: path.basename(attachment.filename),
                content: attachment.content
            }
        ]
    });

    console.log('📤 Reply sent');
}

export async function confirmPendingMail() {
    const pending = getPendingMail();
    if (!pending) return false;

    await sendReply("Отчет подписан", pending.attachment);
    markAsSeen(pending.uid);
    clearPendingMail();
    console.log('✅ Pending mail confirmed and cleared');
    return true;
}


