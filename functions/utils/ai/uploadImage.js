import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createS3Client } from '../storage/s3Client.js';
import { TelegramAPI } from '../storage/telegramAPI.js';
import { DiscordAPI } from '../storage/discordAPI.js';
import { HuggingFaceAPI } from '../storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../storage/webdavAPI.js';
import {
    resolveS3Credentials, resolveTelegramCredentials, resolveDiscordCredentials,
    resolveHuggingFaceCredentials, resolveWebDAVCredentials,
} from '../metadata/channelCredentials.js';
import { getDatabase } from '../databaseAdapter.js';

export const MAX_UPLOAD_IMAGE_BYTES = 20 * 1024 * 1024;
const CHANNELS = new Set(['CloudflareR2', 'S3', 'Telegram', 'TelegramNew', 'Discord', 'HuggingFace', 'WebDAV']);

// Some storage bindings cannot abort get(). Release a body even if it arrives after the deadline.
export function waitForImageOperation(operation, signal, onLate = () => {}) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const abort = () => {
            if (finished) return;
            finished = true;
            signal.removeEventListener('abort', abort);
            reject(new Error('IMAGE_TIMEOUT'));
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        Promise.resolve(operation).then(value => {
            if (finished) { Promise.resolve().then(() => onLate(value)).catch(() => {}); return; }
            finished = true;
            signal.removeEventListener('abort', abort);
            resolve(value);
        }, error => {
            if (finished) return;
            finished = true;
            signal.removeEventListener('abort', abort);
            reject(error);
        });
    });
}

function cancelBody(body) {
    try {
        if (body?.destroy) body.destroy();
        else Promise.resolve(body?.cancel()).catch(() => {});
    } catch { /* Best-effort release; never wait for a broken upstream to cancel. */ }
}

function imageType(bytes) {
    const text = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return 'image/png';
    if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
    if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
    if (bytes.length >= 16 && text(4, 4) === 'ftyp') {
        const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
        for (let offset = 8; offset + 4 <= Math.min(size, bytes.length, 64); offset += 4) {
            if (offset !== 12 && ['avif', 'avis'].includes(text(offset, 4))) return 'image/avif';
        }
    }
    throw new Error('UNSUPPORTED_IMAGE');
}

// Only upload bytes and configured storage records are sources. Never fetch a client-supplied URL/preview.
export async function readUploadImage(context, fileId, record, signal) {
    const metadata = record.metadata;
    if (!CHANNELS.has(metadata.Channel)) throw new Error('UNSUPPORTED_CHANNEL');
    if (Number(metadata.FileSizeBytes) > MAX_UPLOAD_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
    const chunks = [];
    let size = 0;
    async function consume(body, length) {
        if (signal.aborted) cancelBody(body);
        signal.throwIfAborted();
        if (Number(length) > MAX_UPLOAD_IMAGE_BYTES - size) {
            cancelBody(body);
            throw new Error('IMAGE_TOO_LARGE');
        }
        if (!body) throw new Error('IMAGE_NOT_FOUND');
        const stream = typeof body.transformToWebStream === 'function' ? body.transformToWebStream() : body;
        const reader = stream.getReader();
        const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        const before = size;
        try {
            while (true) {
                const { value, done } = await waitForImageOperation(reader.read(), signal);
                signal.throwIfAborted();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_UPLOAD_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
                chunks.push(value);
            }
        } catch (error) { cancel(); throw error; }
        finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
        return size - before;
    }
    async function consumeResponse(operation) {
        const response = await waitForImageOperation(operation, signal, res => cancelBody(res.body));
        if (response.status !== 200) {
            cancelBody(response.body);
            throw new Error('IMAGE_READ_FAILED');
        }
        return consume(response.body, response.headers.get('Content-Length'));
    }

    const file = context.formdata?.get('file');
    if (file && typeof file.stream === 'function') {
        // This is the same multipart file consumed by the successful upload, not a separate client field.
        await consume(file.stream(), file.size);
    } else if (metadata.Channel === 'CloudflareR2') {
        const object = await waitForImageOperation(context.env.img_r2.get(fileId), signal, value => cancelBody(value?.body));
        if (!object) throw new Error('IMAGE_NOT_FOUND');
        await consume(object.body, object.size);
    } else {
        const db = getDatabase(context.env);
        const resolveCredentials = {
            S3: resolveS3Credentials, Telegram: resolveTelegramCredentials, TelegramNew: resolveTelegramCredentials,
            Discord: resolveDiscordCredentials, HuggingFace: resolveHuggingFaceCredentials, WebDAV: resolveWebDAVCredentials,
        }[metadata.Channel];
        const credentials = await waitForImageOperation(resolveCredentials(db, context.env, metadata), signal);
        if (credentials.source !== 'config') throw new Error('CHANNEL_NOT_CONFIGURED');
        signal.throwIfAborted();
        if (metadata.Channel === 'S3') {
            if (!credentials.key) throw new Error('IMAGE_NOT_FOUND');
            const client = createS3Client(credentials);
            try {
                const object = await waitForImageOperation(client.send(new GetObjectCommand({
                    Bucket: credentials.bucketName, Key: credentials.key,
                }), { abortSignal: signal }), signal, value => cancelBody(value?.Body));
                await consume(object.Body, object.ContentLength);
            } finally { client.destroy?.(); }
        } else if (metadata.Channel === 'HuggingFace') {
            if (!credentials.filePath) throw new Error('IMAGE_NOT_FOUND');
            const api = new HuggingFaceAPI(credentials.token, credentials.repo, credentials.isPrivate);
            await consumeResponse(api.getFileContent(credentials.filePath, { signal }));
        } else if (metadata.Channel === 'WebDAV') {
            if (!credentials.filePath) throw new Error('IMAGE_NOT_FOUND');
            await consumeResponse(new WebDAVAPI(credentials).getFile(credentials.filePath, { signal }));
        } else {
            const telegram = metadata.Channel !== 'Discord';
            const api = telegram ? new TelegramAPI(credentials.botToken, credentials.proxyUrl) : new DiscordAPI(credentials.botToken);
            const readPart = async part => {
                signal.throwIfAborted();
                if (telegram) {
                    if (!part.fileId) throw new Error('IMAGE_NOT_FOUND');
                    return consumeResponse(api.getFileContent(part.fileId, { signal }));
                }
                if (!part.messageId) throw new Error('IMAGE_NOT_FOUND');
                const url = await waitForImageOperation(api.getFileURL(credentials.channelId, part.messageId, { signal, maxRetries: 0 }), signal);
                if (!url) throw new Error('IMAGE_NOT_FOUND');
                const target = new URL(url);
                if (target.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(target.hostname)) throw new Error('INVALID_ATTACHMENT_URL');
                const downloadUrl = credentials.proxyUrl ? url.replace('https://cdn.discordapp.com', `https://${credentials.proxyUrl}`) : url;
                return consumeResponse(fetch(downloadUrl, { signal }));
            };
            if (metadata.IsChunked) {
                const parts = JSON.parse(record.value);
                if (!Array.isArray(parts) || !parts.length || parts.length > 32 || parts.length !== metadata.TotalChunks) throw new Error('INVALID_CHUNKS');
                parts.sort((a, b) => a.index - b.index);
                if (parts.some((part, index) => part.index !== index || !Number.isSafeInteger(part.size) || part.size <= 0)) throw new Error('INVALID_CHUNKS');
                const total = parts.reduce((sum, part) => sum + part.size, 0);
                if (total > MAX_UPLOAD_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
                for (const part of parts) {
                    if (await readPart(part) !== part.size) throw new Error('INCOMPLETE_IMAGE');
                }
            } else {
                await readPart({ fileId: metadata.Channel === 'Telegram' ? fileId.split('.')[0] : credentials.fileId, messageId: credentials.messageId });
            }
        }
    }
    signal.throwIfAborted();
    if (!size) throw new Error('IMAGE_NOT_FOUND');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const type = imageType(bytes);
    // Multiples of three keep separately encoded slices aligned without internal base64 padding.
    const encoded = [];
    for (offset = 0; offset < bytes.length; offset += 24576) {
        encoded.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24576))));
    }
    return `data:${type};base64,${encoded.join('')}`;
}
