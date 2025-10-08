// mailBot.js
import fs from 'fs';
import path from 'path';
import { simpleParser } from 'mailparser';
import { extractNeededInfo } from './parser.js';
import { convertToPdf } from './cloudConvert.js'; // твоя функция конвертации
import Imap from 'imap';

export const PDF_PATH = path.resolve('./latest.pdf'); // путь для последнего PDF

let imap = null;
let lastProcessedUID = 0;
let sseClients = [];
let _pendingMail = null;
const processedUIDs = new Set(); // чтобы не обрабатывать письма повторно

export function getPendingMail() {
    return _pendingMail;
}

export function addSseClient(res) {
    sseClients.push(res);
}

function notifyNewMail(mail) {
    sseClients.forEach(res => res.write(`data: ${JSON.stringify(mail)}\n\n`));
}

export async function confirmPendingMail() {
    if (!_pendingMail) return false;
    // после подтверждения сбрасываем
    _pendingMail = null;
    return true;
}

export function startBot({ email, password }) {
    if (!process.env.IMAP_HOST || !process.env.IMAP_PORT) {
        console.error('❌ IMAP_HOST или IMAP_PORT не настроены в .env');
        return;
    }

    imap = new Imap({
        user: email,
        password,
        host: process.env.IMAP_HOST,
        port: Number(process.env.IMAP_PORT),
        tls: true,
    });

    imap.once('ready', () => {
        console.log(`📥 IMAP connected as ${email}`);
        checkMail();
        setInterval(checkMail, 300_000);
    });

    imap.once('error', err => console.error('❌ IMAP error:', err));
    imap.connect();
}

async function checkMail() {
    console.log('🔍 Checking new mails...');
    imap.openBox('INBOX', false, (err, box) => {
        if (err) return console.error('❌ Error opening INBOX:', err);

        const searchCriteria = [['FROM', process.env.TARGET_SENDER], ['UID', `${lastProcessedUID + 1}:*`]];

        imap.search(searchCriteria, (err, results) => {
            if (err) return console.error('❌ Search error:', err);
            if (!results || results.length === 0) return console.log('📭 No new messages from target sender.');

            console.log('📬 Found messages:', results);

            const f = imap.fetch(results, { bodies: '', struct: true });

            f.on('message', msg => {
                let uid;
                msg.on('attributes', attrs => {
                    uid = attrs.uid;
                });

                msg.on('body', async stream => {
                    const parsed = await simpleParser(stream);
                    if (!parsed.attachments || parsed.attachments.length === 0) return;

                    for (const att of parsed.attachments) {
                        const filename = att.filename;
                        if (!filename) continue;

                        console.log('📎 Attachment found:', filename);

                        if (!filename.endsWith('.doc') && !filename.endsWith('.docx')) {
                            console.log(`⏩ Skipping non-DOC attachment: ${filename}`);
                            continue;
                        }

                        if (processedUIDs.has(uid)) {
                            console.log(`⏩ Already processed UID ${uid}, skipping`);
                            continue;
                        }

                        const tempPath = path.resolve(`temp_${filename}`);
                        fs.writeFileSync(tempPath, att.content);
                        console.log(`💾 Saved DOC: ${tempPath}`);

                        try {
                            if (!process.env.CLOUDCONVERT_API_KEY) throw new Error('CloudConvert API key not set');

                            const pdfBuffer = await convertToPdf(tempPath);
                            fs.writeFileSync(PDF_PATH, pdfBuffer);
                            console.log(`✅ Converted to PDF: ${PDF_PATH}, size: ${pdfBuffer.length}`);

                            const text = att.content.toString(); // простой текст из doc
                            const info = extractNeededInfo(text);

                            _pendingMail = {
                                uid,
                                info,
                                attachment: { filename: PDF_PATH, content: pdfBuffer }
                            };

                            notifyNewMail(_pendingMail);

                            // помечаем как прочитанное
                            imap.addFlags(uid, '\\Seen', err => {
                                if (err) console.error('❌ Error marking as seen:', err);
                                else console.log(`📨 Marked as seen: ${filename}`);
                            });

                            processedUIDs.add(uid);
                            lastProcessedUID = Math.max(lastProcessedUID, uid);

                        } catch (e) {
                            console.error('❌ Conversion failed:', e);
                        } finally {
                            try {
                                fs.unlinkSync(tempPath);
                                console.log(`🗑 Temp file deleted: ${tempPath}`);
                            } catch (e) {
                                console.warn(`⚠️ Temp file already deleted or not found: ${tempPath}`);
                            }
                        }
                    }
                });
            });
        });
    });
}

