// cloudConvert.js
import CloudConvert from 'cloudconvert';
import fs from 'fs';

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

/**
 * Конвертирует локальный DOC файл в PDF и возвращает буфер PDF
 * @param {string} inputPath - путь к DOC файлу
 * @returns {Promise<Buffer>}
 */
export async function convertToPdf(inputPath) {
    const fileName = inputPath.split(/[\\/]/).pop();
    const job = await cloudConvert.jobs.create({
        tasks: {
            'import-my-file': {
                operation: 'import/upload'
            },
            'convert-my-file': {
                operation: 'convert',
                input: 'import-my-file',
                output_format: 'pdf',
                engine: 'libreoffice'
            },
            'export-my-file': {
                operation: 'export/url',
                input: 'convert-my-file'
            }
        }
    });

    const uploadTask = job.tasks.find(t => t.name === 'import-my-file');
    const uploadUrl = uploadTask.result.form.url;

    // загружаем файл на CloudConvert
    await cloudConvert.tasks.upload(uploadTask, fs.createReadStream(inputPath), fileName);

    // ждём завершения конвертации
    const completedJob = await cloudConvert.jobs.wait(job.id);

    const exportTask = completedJob.tasks.find(t => t.name === 'export-my-file');
    const fileUrl = exportTask.result.files[0].url;

    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();

    return Buffer.from(buffer);
}
