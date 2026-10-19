// Audio stays in this browser's IndexedDB, separate from story/chat metadata.
import { previewSha256 as hash } from './preview-sha256.js?v=20261020-local-library';
export const TTS_PREVIEW_TEXT = '下午三点，我们在图书馆见。太好了！我就知道你一定能成功！你怎么又失约了？我真的生气了，请认真回答。';
const abortError = () => new DOMException('Aborted', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

export class PreviewAudioStore {
    constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.memory = new Map(); this.persistent = false; }
    async _db() {
        if (!this.indexedDB) return null;
        if (!this.opening) this.opening = new Promise(resolve => {
            const request = this.indexedDB.open('yuzuki-phone-voice-previews', 1);
            let finished = false;
            const fallback = () => { finished = true; resolve(null); };
            const timer = setTimeout(fallback, 3000);
            request.onupgradeneeded = () => request.result.createObjectStore('audio', { keyPath: 'key' });
            request.onerror = request.onblocked = () => { clearTimeout(timer); fallback(); };
            request.onsuccess = () => {
                clearTimeout(timer);
                const db = request.result;
                if (finished) { db.close(); return; }
                db.onversionchange = () => { db.close(); this.opening = null; };
                this.persistent = true;
                resolve(db);
            };
        });
        return this.opening;
    }
    async _run(mode, action) {
        const db = await this._db();
        if (!db) return null;
        return new Promise(resolve => {
            try {
                const tx = db.transaction('audio', mode);
                const request = action(tx.objectStore('audio'));
                tx.oncomplete = () => resolve({ value: request.result });
                tx.onerror = tx.onabort = () => { this.persistent = false; resolve(null); };
            } catch { this.persistent = false; resolve(null); }
        });
    }
    async get(key) {
        if (this.memory.has(key)) return this.memory.get(key);
        return (await this._run('readonly', store => store.get(key)))?.value || null;
    }
    async put(record) {
        const result = await this._run('readwrite', store => store.put(record));
        // Retain only a session copy if persistence is unavailable or storage is full.
        if (!result) this.memory.set(record.key, record);
        else this.memory.delete(record.key);
        return !!result;
    }
}

export class VoicePreviewLibrary {
    constructor({ store = new PreviewAudioStore(), fetchAudio = url => fetch(url), revokeUrl = url => URL.revokeObjectURL(url) } = {}) {
        Object.assign(this, { store, fetchAudio, revokeUrl });
        this.pending = new Map();
    }
    async describe(manager, options = {}) {
        const config = manager?._resolveConfig?.(options) || options;
        const provider = String(config.provider || options.provider || '');
        // Do not write credentials, endpoints, or relay URLs into the library/export.
        const endpoint = await hash(JSON.stringify([config.apiUrl || '', config.relayUrl || '', config.appId || '']));
        const descriptor = { provider, voice: String(config.voice || options.voice || ''),
            model: String(config.model || ''), resource: String(config.resourceId || ''), endpoint,
            language: provider.startsWith('minimax') ? String(options.languageBoost || 'auto') : '', text: TTS_PREVIEW_TEXT };
        if (!descriptor.voice) throw new Error('请先填写音色 ID。');
        return { key: await hash(JSON.stringify(descriptor)), descriptor };
    }
    async lookup(manager, options) {
        const identity = await this.describe(manager, options);
        return { ...identity, record: await this.store.get(identity.key) };
    }
    async get(manager, options = {}) {
        checkAbort(options.signal);
        const { key, descriptor, record } = await this.lookup(manager, options);
        checkAbort(options.signal);
        if (record?.blob?.size) return { blob: record.blob, source: 'local', persistent: this.store.persistent };
        if (!manager?.requestTTS) throw new Error('请先在手机设置中配置语音服务。');
        let task = this.pending.get(key);
        if (task?.controller.signal.aborted) task = null;
        if (!task) {
            task = { controller: new AbortController(), listeners: new Set() };
            this.pending.set(key, task);
            const currentTask = task;
            task.promise = (async () => {
                let url = '';
                const signal = currentTask.controller.signal;
                try {
                    url = await manager.requestTTS(TTS_PREVIEW_TEXT, { provider: options.provider, voice: options.voice,
                        languageBoost: options.languageBoost, signal });
                    checkAbort(signal);
                    if (!url) throw new Error('语音服务未返回音频。');
                    const response = await this.fetchAudio(url);
                    if (!response.ok) throw new Error('无法读取试听音频。');
                    const blob = await response.blob();
                    if (!blob.size || blob.size > 25 * 1024 * 1024 || /^(text\/|application\/json)/i.test(blob.type)) throw new Error('试听音频无效或过大。');
                    checkAbort(signal);
                    const persistent = await this.store.put({ key, descriptor, blob, createdAt: Date.now() });
                    return { blob, source: 'generated', persistent };
                } finally {
                    if (String(url).startsWith('blob:')) this.revokeUrl(url);
                    if (this.pending.get(key) === currentTask) this.pending.delete(key);
                }
            })();
        }
        const listener = {};
        task.listeners.add(listener);
        let onAbort;
        try {
            return await Promise.race([task.promise, new Promise((_, reject) => {
                onAbort = () => reject(abortError());
                options.signal?.addEventListener('abort', onAbort, { once: true });
                if (options.signal?.aborted) onAbort();
            })]);
        } finally {
            options.signal?.removeEventListener('abort', onAbort);
            task.listeners.delete(listener);
            if (!task.listeners.size) task.controller.abort();
        }
    }
    async recordsFor(manager, voices) {
        const unique = [...new Set(voices.map(v => String(v.id || '').trim()).filter(Boolean))];
        const records = [];
        for (const voice of unique) {
            const result = await this.lookup(manager, { provider: 'volcengine', voice });
            if (result.record?.blob?.size) records.push(result.record);
        }
        return { records, total: unique.length };
    }
}

// A dependency-free, uncompressed ZIP. Audio is already compressed; exports are
// portable individual audio files plus a manifest that allows exact cache reuse.
const crc32 = bytes => {
    let crc = -1;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
};
export function packPreviewZip(files) {
    const parts = [], directory = [];
    let offset = 0, centralSize = 0;
    for (const [name, data] of files) {
        const filename = new TextEncoder().encode(name), crc = crc32(data);
        const local = new Uint8Array(30 + filename.length), v = new DataView(local.buffer);
        v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true);
        v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
        v.setUint16(26, filename.length, true); local.set(filename, 30);
        const central = new Uint8Array(46 + filename.length), c = new DataView(central.buffer);
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
        c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
        c.setUint16(28, filename.length, true); c.setUint32(42, offset, true); central.set(filename, 46);
        parts.push(local, data); directory.push(central);
        offset += local.length + data.length; centralSize += central.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
export async function exportPreviewLibrary(records) {
    const files = [], samples = [];
    for (const record of records) {
        const data = new Uint8Array(await record.blob.arrayBuffer());
        const ext = /wav/i.test(record.blob.type) ? 'wav' : /ogg/i.test(record.blob.type) ? 'ogg' : /mp4|m4a/i.test(record.blob.type) ? 'm4a' : 'mp3';
        const safeVoice = record.descriptor.voice.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 70);
        const file = `audio/${safeVoice}-${record.key.slice(0, 12)}.${ext}`;
        samples.push({ key: record.key, descriptor: record.descriptor, mime: record.blob.type, createdAt: record.createdAt, file, sha256: await hash(data) });
        files.push([file, data]);
    }
    files.unshift(['manifest.json', new TextEncoder().encode(JSON.stringify({ format: 'yuzuki-voice-previews', version: 1, samples }, null, 2))]);
    return packPreviewZip(files);
}
export async function importPreviewLibrary(file, store) {
    if (file.size > 300 * 1024 * 1024) throw new Error('试听库超过 300 MB，请分批导入。');
    const bytes = new Uint8Array(await file.arrayBuffer()), v = new DataView(bytes.buffer), files = new Map();
    let pos = 0;
    while (pos + 30 <= bytes.length && v.getUint32(pos, true) === 0x04034b50) {
        const flags = v.getUint16(pos + 6, true), method = v.getUint16(pos + 8, true);
        const size = v.getUint32(pos + 18, true), rawSize = v.getUint32(pos + 22, true);
        const nameSize = v.getUint16(pos + 26, true), extraSize = v.getUint16(pos + 28, true);
        const start = pos + 30 + nameSize + extraSize, end = start + size;
        if ((flags & 9) || method !== 0 || size !== rawSize || end > bytes.length || files.size > 5001) throw new Error('请导入本插件下载的原始试听库 ZIP。');
        const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nameSize));
        const data = bytes.subarray(start, end);
        if (files.has(name) || crc32(data) !== v.getUint32(pos + 14, true)) throw new Error('试听库文件校验失败。');
        files.set(name, data); pos = end;
    }
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json'))); } catch { throw new Error('未找到有效的试听库清单。'); }
    if (manifest.format !== 'yuzuki-voice-previews' || manifest.version !== 1 || !Array.isArray(manifest.samples) || manifest.samples.length > 5000) throw new Error('试听库格式不支持。');
    const validated = [];
    for (const sample of manifest.samples) {
        const d = sample.descriptor, data = files.get(sample.file);
        if (!d || typeof d.voice !== 'string' || d.text !== TTS_PREVIEW_TEXT || !data?.length || data.length > 25 * 1024 * 1024
            || !/^(audio\/|application\/octet-stream$)/i.test(sample.mime || '') || await hash(data) !== sample.sha256
            || await hash(JSON.stringify(d)) !== sample.key) throw new Error('试听库内容校验失败或试听文本版本不一致。');
        validated.push({ key: sample.key, descriptor: d, blob: new Blob([data], { type: sample.mime }), createdAt: sample.createdAt });
    }
    let added = 0, skipped = 0;
    for (const record of validated) {
        if ((await store.get(record.key))?.blob?.size) { skipped++; continue; }
        await store.put(record); added++;
    }
    return { added, skipped, persistent: store.persistent };
}
export const voicePreviewLibrary = new VoicePreviewLibrary();
