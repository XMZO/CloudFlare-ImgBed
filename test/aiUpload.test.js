import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import * as tagHelpers from '../functions/utils/tagHelpers.js';
import * as responses from '../functions/utils/apiResponse.js';
import { isExpired } from '../functions/utils/fileExpiryHelpers.js';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';
import { WebDAVAPI } from '../functions/utils/storage/webdavAPI.js';

const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XQAAAAASUVORK5CYII=', 'base64'));
const imageUrl = bytes => 'data:image/png;base64,' + Buffer.from(bytes).toString('base64');
const metadata = (Channel = 'CloudflareR2') => ({ Channel, FileName: 'photo.png', FileType: 'image/png', FileSizeBytes: png.length, TimeStamp: 1, Tags: [] });
const decode = url => new Uint8Array(Buffer.from(url.split(',')[1], 'base64'));
const signal = () => new AbortController().signal;

async function readerModule(mocks = {}, globals = {}) {
    return loadFunction('functions/utils/ai/uploadImage.js', {
        getDatabase: () => ({}),
        GetObjectCommand: class { constructor(input) { this.input = input; } },
        ...mocks,
    }, globals);
}

describe('server-side upload image input', () => {
    for (const channel of ['CloudflareR2', 'S3', 'TelegramNew', 'Discord', 'HuggingFace', 'WebDAV']) {
        it(`uses the actual multipart file for ${channel}, never the separate preview`, async () => {
            const { readUploadImage } = await readerModule();
            const formdata = new FormData();
            formdata.set('file', new File([png], 'photo.png', { type: 'image/png' }));
            formdata.set('autoTagPreview', 'data:image/jpeg;base64,/9j/2Q==');
            const result = await readUploadImage({ env: {}, formdata, autoTagPreview: 'attacker-preview' }, 'photo.png', { metadata: metadata(channel) }, signal());
            assert.deepEqual(decode(result), png);
        });
    }

    it('reads the final R2 object for uploads without a multipart file', async () => {
        const { readUploadImage } = await readerModule();
        const result = await readUploadImage({ env: { img_r2: { get: async key => {
            assert.equal(key, 'folder/photo.png');
            return { size: png.length, body: new Blob([png]).stream() };
        } } } }, 'folder/photo.png', { metadata: metadata() }, signal());
        assert.equal(result, imageUrl(png));
    });

    it('preserves bytes across base64 encoding slices', async () => {
        const { readUploadImage } = await readerModule();
        const bytes = new Uint8Array(65539);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
        bytes.set(png);
        const formdata = new FormData();
        formdata.set('file', new File([bytes], 'photo.png'));
        assert.deepEqual(decode(await readUploadImage({ env: {}, formdata }, 'photo.png', { metadata: metadata() }, signal())), bytes);
    });

    it('reads S3 using its configured credentials, stored key and abort signal', async () => {
        const controller = new AbortController();
        let destroyed = false;
        const creds = { source: 'config', key: 'actual/key.png', bucketName: 'bucket', userAgent: 'custom' };
        const { readUploadImage } = await readerModule({
            resolveS3Credentials: async () => creds,
            createS3Client: value => {
                assert.equal(value, creds);
                return { send: async (command, options) => {
                    assert.deepEqual(command.input, { Bucket: 'bucket', Key: 'actual/key.png' });
                    assert.equal(options.abortSignal, controller.signal);
                    return { Body: { transformToWebStream: () => new Blob([png]).stream() }, ContentLength: png.length };
                }, destroy: () => { destroyed = true; } };
            },
        });
        assert.equal(await readUploadImage({ env: {} }, 'public-name.png', { metadata: metadata('S3') }, controller.signal), imageUrl(png));
        assert.equal(destroyed, true);
    });

    for (const channel of ['TelegramNew', 'Discord']) {
        it(`reassembles ${channel} chunks in record order and verifies their lengths`, async () => {
            const visited = [];
            const part = id => { visited.push(id); return new Response(id === 'first' ? png.slice(0, 5) : png.slice(5)); };
            const creds = { source: 'config', botToken: 'bot', channelId: 'channel', proxyUrl: '' };
            const { readUploadImage } = await readerModule({
                resolveTelegramCredentials: async () => creds, resolveDiscordCredentials: async () => creds,
                TelegramAPI: class { getFileContent(id, options) { assert.ok(options.signal); return part(id); } },
                DiscordAPI: class { getFileURL(channelId, id, options) {
                    assert.equal(channelId, 'channel'); assert.equal(options.maxRetries, 0); assert.ok(options.signal);
                    return 'https://cdn.discordapp.com/' + id;
                } },
            }, { fetch: async (url, options) => { assert.ok(options.signal); return part(new URL(url).pathname.slice(1)); } });
            const record = { metadata: { ...metadata(channel), IsChunked: true, TotalChunks: 2 }, value: JSON.stringify([
                { index: 1, fileId: 'last', messageId: 'last', size: png.length - 5 },
                { index: 0, fileId: 'first', messageId: 'first', size: 5 },
            ]) };
            assert.equal(await readUploadImage({ env: {} }, 'photo.png', record, signal()), imageUrl(png));
            assert.deepEqual(visited, ['first', 'last']);
            record.value = JSON.stringify([{ index: 0, fileId: 'first', messageId: 'first', size: 6 }, { index: 1, fileId: 'last', messageId: 'last', size: 6 }]);
            await assert.rejects(readUploadImage({ env: {} }, 'photo.png', record, signal()), /INCOMPLETE_IMAGE/);
        });
    }

    for (const channel of ['HuggingFace', 'WebDAV']) {
        it(`downloads ${channel} direct uploads through the authenticated storage helper`, async () => {
            const creds = { source: 'config', token: 'secret', repo: 'owner/repo', isPrivate: true, filePath: 'dir/photo.png' };
            class API {
                constructor(...args) { assert.deepEqual(args, channel === 'HuggingFace' ? ['secret', 'owner/repo', true] : [creds]); }
                getFileContent(path, options) { assert.equal(path, creds.filePath); assert.ok(options.signal); return new Response(png); }
                getFile(path, options) { return this.getFileContent(path, options); }
            }
            const { readUploadImage } = await readerModule({
                resolveHuggingFaceCredentials: async () => creds, HuggingFaceAPI: API,
                resolveWebDAVCredentials: async () => creds, WebDAVAPI: API,
            });
            assert.equal(await readUploadImage({ env: {} }, 'public.png', { metadata: metadata(channel) }, signal()), imageUrl(png));
        });
    }

    it('rejects arbitrary external links, non-image bytes and oversized metadata', async () => {
        const { readUploadImage, MAX_UPLOAD_IMAGE_BYTES } = await readerModule();
        await assert.rejects(readUploadImage({ env: {} }, 'x', { metadata: { ...metadata('External'), ExternalLink: 'http://127.0.0.1/private' } }, signal()), /UNSUPPORTED_CHANNEL/);
        await assert.rejects(readUploadImage({ env: {} }, 'x', { metadata: { ...metadata(), FileSizeBytes: MAX_UPLOAD_IMAGE_BYTES + 1 } }, signal()), /IMAGE_TOO_LARGE/);
        await assert.rejects(readUploadImage({ env: { img_r2: { get: async () => ({ body: new Blob(['<svg></svg>']).stream() }) } } }, 'x', { metadata: metadata() }, signal()), /UNSUPPORTED_IMAGE/);
    });

    it('bounds actual streamed bytes even when storage reports a small length', async () => {
        const { readUploadImage, MAX_UPLOAD_IMAGE_BYTES } = await readerModule();
        let cancelled = false;
        const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
        await assert.rejects(readUploadImage({ env: { img_r2: { get: async () => ({ body, size: 1 }) } } }, 'x', { metadata: metadata() }, signal()), /IMAGE_TOO_LARGE/);
        assert.equal(cancelled, true);
        let rejectedBodyCancelled = false;
        const largeBody = new ReadableStream({ cancel() { rejectedBodyCancelled = true; } });
        await assert.rejects(readUploadImage({ env: { img_r2: { get: async () => ({ body: largeBody, size: MAX_UPLOAD_IMAGE_BYTES + 1 }) } } }, 'x', { metadata: metadata() }, signal()), /IMAGE_TOO_LARGE/);
        assert.equal(rejectedBodyCancelled, true);
    });

    it('cancels a stalled stream and releases an R2 body arriving after cancellation', async () => {
        const { readUploadImage } = await readerModule();
        let release, cancelled = false;
        const controller = new AbortController();
        const pending = readUploadImage({ env: { img_r2: { get: () => new Promise(resolve => { release = resolve; }) } } }, 'x', { metadata: metadata() }, controller.signal);
        controller.abort();
        await assert.rejects(pending, /IMAGE_TIMEOUT/);
        release({ body: new ReadableStream({ cancel() { cancelled = true; } }), size: 12 });
        for (let i = 0; i < 4; i++) await Promise.resolve();
        assert.equal(cancelled, true);

        const stalled = new AbortController();
        let streamCancelled = false, reading;
        const begun = new Promise(resolve => { reading = resolve; });
        const body = new ReadableStream({ pull() { reading(); return new Promise(() => {}); }, cancel() { streamCancelled = true; } });
        const task = readUploadImage({ env: { img_r2: { get: async () => ({ body }) } } }, 'x', { metadata: metadata() }, stalled.signal);
        await begun; stalled.abort();
        await assert.rejects(task);
        assert.equal(streamCancelled, true);
    });
});

describe('automatic tagging with server image bytes', () => {
    async function fixture({ enabled = true, readError = false, providerError = false, empty = false, indexSuccess = true, readImage, globals = {} } = {}) {
        const db = memoryDatabase();
        const meta = metadata();
        await db.put('photo.png', '', { metadata: meta });
        const service = await loadFunction('functions/utils/tagService.js', {
            ...tagHelpers, ...responses, getDatabase: () => db, cleanPersistedMetadata: x => x,
            batchAddFilesToIndex: async () => ({ success: indexSuccess }), purgePublicFileListCache: async () => {}, purgeRandomFileListCache: async () => {},
        });
        const reader = await readerModule();
        const calls = [];
        let reads = 0;
        const tags = await loadFunction('functions/utils/ai/uploadTags.js', {
            ...reader, ...service, getDatabase: () => db, isExpired,
            readUploadImage: async (...args) => { reads++; if (readError) throw new Error('read failed'); return readImage ? readImage(...args) : reader.readUploadImage(...args); },
            createAIContext: () => ({
                getConfig: async () => ({ enabled, capabilities: { 'image.tags': { enabled: true, autoTagOnUpload: true } }, execution: { requestDeadlineMs: 25000 } }),
                invoke: async options => { calls.push(options); if (providerError) throw new Error('provider failed'); return { data: { tags: empty ? [] : ['cat'] } }; },
            }),
        }, globals);
        return { db, meta, calls, reads: () => reads, run: () => tags.autoTagUploadedFile({ env: { img_r2: { get: async () => ({ body: new Blob([png]).stream(), size: png.length }) } }, request: new Request('https://test/upload'), autoTagPreview: 'forged' }, 'photo.png', meta) };
    }

    it('recognizes the server-provided bytes without a client preview, then saves tags', async () => {
        const f = await fixture();
        assert.equal(await f.run(), true);
        assert.equal(f.calls[0].input.image, imageUrl(png));
        assert.ok(f.calls[0].signal);
        assert.deepEqual((await f.db.getWithMetadata('photo.png')).metadata.Tags, ['cat']);
    });

    for (const scenario of [{ enabled: false }, { readError: true }, { providerError: true }, { empty: true }]) {
        it(`leaves metadata unchanged: ${JSON.stringify(scenario)}`, async () => {
            const f = await fixture(scenario);
            assert.equal(await f.run(), false);
            assert.deepEqual((await f.db.getWithMetadata('photo.png')).metadata, f.meta);
            if (scenario.enabled === false) assert.equal(f.reads(), 0);
            if (scenario.readError) assert.equal(f.calls.length, 0);
        });
    }

    it('skips replaced or deleted files before downloading anything', async () => {
        const f = await fixture();
        await f.db.put('photo.png', '', { metadata: { ...f.meta, TimeStamp: 2 } });
        assert.equal(await f.run(), false);
        await f.db.delete('photo.png');
        assert.equal(await f.run(), false);
        assert.equal(f.reads(), 0);
    });

    it('does not treat pending index synchronization as complete success', async () => {
        const f = await fixture({ indexSuccess: false });
        assert.equal(await f.run(), false);
        assert.deepEqual((await f.db.getWithMetadata('photo.png')).metadata.Tags, ['cat']);
    });

    it('uses one deadline for image reading and recognition and never invokes AI after a read timeout', async () => {
        let expire;
        const reader = await readerModule();
        const f = await fixture({
            globals: { setTimeout: callback => { expire = callback; return 1; }, clearTimeout: () => {} },
            readImage: async (_ctx, _id, _record, signal) => { const pending = reader.waitForImageOperation(new Promise(() => {}), signal); expire(); return pending; },
        });
        assert.equal(await f.run(), false);
        assert.equal(f.calls.length, 0);
        assert.deepEqual((await f.db.getWithMetadata('photo.png')).metadata, f.meta);
    });
});

describe('storage helper read cancellation', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('forwards the same abort signal through Telegram path lookup and download', async () => {
        const s = signal();
        const calls = [];
        globalThis.fetch = async (url, options) => {
            calls.push(url); assert.equal(options.signal, s);
            return url.includes('/getFile?') ? new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/image.png' } })) : new Response(png);
        };
        const response = await new TelegramAPI('secret', 'telegram.example').getFileContent('file+id', { signal: s });
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
        assert.ok(calls[0].includes('file_id=file%2Bid'));
        assert.ok(calls[1].startsWith('https://telegram.example/'));
    });

    it('forwards Discord lookup cancellation without retrying an aborted request', async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = async (_url, options) => { calls++; assert.equal(options.signal, controller.signal); controller.abort(); throw new Error('aborted'); };
        await assert.rejects(new DiscordAPI('secret').getFileURL('channel', 'message', { signal: controller.signal, maxRetries: 0 }));
        assert.equal(calls, 1);
    });

    it('uses private HuggingFace authentication and escapes path query characters', async () => {
        const s = signal();
        globalThis.fetch = async (url, options) => {
            assert.ok(url.endsWith('/folder/a%3Fb%23c.png'));
            assert.equal(options.headers.Authorization, 'Bearer secret'); assert.equal(options.signal, s);
            return new Response(png);
        };
        await new HuggingFaceAPI('secret', 'owner/repo', true).getFileContent('folder/a?b#c.png', { signal: s });
    });

    it('forwards WebDAV read cancellation and configured authentication', async () => {
        const s = signal();
        globalThis.fetch = async (_url, options) => {
            assert.equal(options.signal, s); assert.ok(options.headers.get('Authorization').startsWith('Basic '));
            return new Response(png);
        };
        await new WebDAVAPI({ baseUrl: 'https://dav.example/', username: 'u', password: 'p' }).getFile('photo.png', { signal: s });
    });
});
