import { createAIContext } from './index.js';
import { readUploadImage, waitForImageOperation, MAX_UPLOAD_IMAGE_BYTES } from './uploadImage.js';
import { getDatabase } from '../databaseAdapter.js';
import { applyTagItems, fileIdentity } from '../tagService.js';
import { normalizeMimeType } from '../mimeTypes.js';
import { isExpired } from '../fileExpiryHelpers.js';

const SOURCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']);

export async function autoTagUploadedFile(context, fileId, metadata) {
    let timer;
    const controller = new AbortController();
    const { signal } = controller;
    try {
        if (!SOURCE_TYPES.has(normalizeMimeType(metadata?.FileType)) || metadata.Channel === 'External' ||
            Number(metadata.FileSizeBytes) > MAX_UPLOAD_IMAGE_BYTES) return false;
        const started = Date.now();
        timer = setTimeout(() => controller.abort(), 25000);
        const ai = createAIContext(context.env);
        const config = await waitForImageOperation(ai.getConfig(), signal);
        const options = config.capabilities?.['image.tags'];
        if (!config.enabled || !options?.enabled || options.autoTagOnUpload !== true) return false;
        const deadlineAt = started + config.execution.requestDeadlineMs;
        clearTimeout(timer);
        if (deadlineAt <= Date.now()) return false;
        timer = setTimeout(() => controller.abort(), deadlineAt - Date.now());
        const sourceIdentity = await waitForImageOperation(fileIdentity(metadata), signal);
        const record = await waitForImageOperation(getDatabase(context.env).getWithMetadata(fileId), signal);
        if (!record?.metadata || isExpired(record.metadata) || await waitForImageOperation(fileIdentity(record.metadata), signal) !== sourceIdentity) return false;
        const image = await readUploadImage(context, fileId, record, signal);
        signal.throwIfAborted();
        const result = await waitForImageOperation(ai.invoke({
            capability: 'image.tags', input: { image }, deadlineAt, signal,
        }), signal);
        if (!Array.isArray(result.data?.tags) || result.data.tags.length === 0) return false;
        signal.throwIfAborted();
        const applied = await applyTagItems({ ...context, waitUntil: undefined }, [{ fileId, tags: result.data.tags, sourceIdentity }], 'add', {
            maxItems: 1, maxTags: 10, maxTagLength: 24,
        });
        return applied.success === true;
    } catch {
        // Storage errors may contain signed URLs or credentials; do not log upstream messages.
        console.warn('Automatic AI tagging skipped: image read, recognition or saving failed.');
        return false;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
