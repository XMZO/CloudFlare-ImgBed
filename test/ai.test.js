import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import * as responses from '../functions/utils/apiResponse.js';
import { createContext } from './helpers/context.js';
import { png } from './helpers/files.js';
import { defaultAIConfig, normalizeAIConfig } from '../functions/utils/ai/config.js';

describe('AI tagging', () => {
    let db, mocks;

    beforeEach(() => {
        db = memoryDatabase();
        mocks = { ...responses, getDatabase: () => db };
    });

    function context(url, body) { return createContext(url, { method: 'POST', body }); }

    it('normalizes AI preview MIME while retaining format, signature, and size checks', async () => {
        const calls = [];
        const route = await loadFunction('functions/api/manage/ai/tags.js', {
            ...mocks,
            createAIContext: () => ({
                getConfig: async () => ({ enabled: true, capabilities: { 'image.tags': { enabled: true } }, execution: { maxBatchSize: 5, concurrency: 1, requestDeadlineMs: 10000 } }),
                invoke: async options => { calls.push(options); return { data: { tags: ['test'] } }; },
            }),
            validateFileId: () => {},
            fileIdentity: async () => 'identity',
        });
        for (const [original, preview, bytes, error] of [
            ['IMAGE/PNG; charset=binary', 'image/png; charset=binary', png(), null],
            ['image/svg+xml', 'image/png', png(), 'UNSUPPORTED_INPUT'],
            ['image/png', 'image/png', new Uint8Array(24), 'INVALID_IMAGE'],
            ['image/png', 'image/svg+xml', png(), 'INVALID_IMAGE'],
            ['image/png', 'image/png', new Uint8Array(256 * 1024 + 1), 'INVALID_IMAGE'],
        ]) {
            await db.put('photo.png', '', { metadata: { FileType: original } });
            const form = new FormData();
            form.set('items', JSON.stringify([{ fileId: 'photo.png' }]));
            form.set('image0', new File([bytes], 'preview.png', { type: preview }));
            const response = await route.onRequest(context('https://test/api/manage/ai/tags', form));
            const { results } = await response.json();
            assert.equal(results[0].error?.code ?? null, error);
        }
        assert.equal(calls.length, 1);
        assert.equal(calls[0].input.image.startsWith('data:image/png;base64,'), true);
    });

    it('keeps automatic upload tagging opt-in while preserving saved values', () => {
        assert.equal(defaultAIConfig().capabilities['image.tags'].autoTagOnUpload, false);
        const input = defaultAIConfig();
        input.capabilities['image.tags'].autoTagOnUpload = true;
        assert.equal(normalizeAIConfig(input).capabilities['image.tags'].autoTagOnUpload, true);
        delete input.capabilities['image.tags'].autoTagOnUpload;
        assert.equal(normalizeAIConfig(input).capabilities['image.tags'].autoTagOnUpload, false);
    });

    it('rejects stale automatic tag writes without changing metadata', async () => {
        await db.put('photo.png', '', { metadata: { FileName: 'photo.png', FileType: 'image/png', TimeStamp: 1, Tags: ['existing'] } });
        const service = await loadFunction('functions/utils/tagService.js', {
            getDatabase: () => db,
            batchAddFilesToIndex: async () => ({ success: true }),
            cleanPersistedMetadata: value => value,
            mergeTags: (oldTags, tags) => [...new Set([...oldTags, ...tags])],
            validateTag: tag => typeof tag === 'string' && !!tag,
            purgePublicFileListCache: async () => {},
            purgeRandomFileListCache: async () => {},
            APIError: responses.APIError,
            errorResult: responses.errorResult,
        });
        const identity = await service.fileIdentity((await db.getWithMetadata('photo.png')).metadata);
        const changed = (await db.getWithMetadata('photo.png')).metadata;
        changed.TimeStamp = 2;
        await db.put('photo.png', '', { metadata: changed });
        const result = await service.applyTagItems({ env: {}, request: new Request('https://test/upload') }, [{ fileId: 'photo.png', tags: ['new'], sourceIdentity: identity }]);
        assert.equal(result.results[0].saved, false);
        assert.equal(result.results[0].error.code, 'FILE_CHANGED');
        assert.deepEqual((await db.getWithMetadata('photo.png')).metadata.Tags, ['existing']);
    });

});
