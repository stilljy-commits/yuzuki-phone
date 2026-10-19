import { voicePreviewLibrary, TTS_PREVIEW_TEXT, exportPreviewLibrary, importPreviewLibrary } from './tts-preview-library.js?v=20261020-local-library';
import { isVoicePreviewViewActive, watchVoicePreviewView } from './tts-preview.js?v=20261020-local-library';

export function renderPreviewLibraryControls() {
    const style = 'padding:7px 8px;border:1px solid #d8e3ef;border-radius:6px;background:#f2f7ff;color:#576b95;font-size:12px;cursor:pointer;';
    return `<div style="margin:12px 0;line-height:1.6;">
        <div style="font-size:13px;font-weight:700;">本地试听库</div>
        <div style="font-size:11px;color:#888;">同一段49字（陈述、开心、生气）。仅首次生成缺少的音色会消耗合成用量；以后优先本地播放。音频保存在本浏览器，可下载 ZIP 备份并导入其他设备。更换模型或服务地址后会重新生成。</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px;">
            <button type="button" id="phone-preview-library-generate" style="${style}" disabled>正在读取试听库…</button>
            <button type="button" id="phone-preview-library-download" style="${style}">下载已有试听库</button>
            <button type="button" id="phone-preview-library-import" style="${style}">导入试听库 ZIP</button>
            <button type="button" id="phone-preview-library-cancel" style="${style}" hidden>停止生成</button>
        </div>
        <input type="file" id="phone-preview-library-file" accept=".zip,application/zip" hidden>
        <div id="phone-preview-library-status" role="status" style="font-size:11px;color:#777;margin-top:7px;overflow-wrap:anywhere;">正在读取本地音频…</div>
    </div>`;
}

export function bindPreviewLibraryControls(root, { getPool, getManager, stopPreview = () => {}, library = voicePreviewLibrary }) {
    const query = id => root.querySelector(`#phone-preview-library-${id}`);
    const generate = query('generate'), download = query('download'), importButton = query('import'), cancel = query('cancel'), fileInput = query('file'), status = query('status');
    if (!generate) return { refresh: () => {} };
    let batch = null, revision = 0;
    const setStatus = text => { if (status.isConnected && isVoicePreviewViewActive(root)) status.textContent = text; };
    const refresh = async () => {
        const current = ++revision;
        try {
            const { records, total } = await library.recordsFor(getManager(), getPool());
            if (current !== revision || !generate.isConnected || !isVoicePreviewViewActive(root) || batch) return;
            const missing = total - records.length;
            generate.disabled = !missing;
            generate.textContent = missing ? `生成缺少的 ${missing} 款（约${missing * TTS_PREVIEW_TEXT.length}字）` : library.store.persistent ? '全部已保存在本地' : '本次会话音频已齐全';
            download.disabled = !records.length;
            setStatus(`本地已有 ${records.length}/${total} 款。${library.store.persistent ? '' : '当前仅会话缓存可用，请下载备份；关闭页面后可能丢失。'}`);
        } catch (error) { setStatus(error.message); generate.disabled = true; }
    };
    const saveZip = async records => {
        if (!records.length) throw new Error('当前音色池还没有可下载的本地试听，请先生成。');
        const blob = await exportPreviewLibrary(records), url = URL.createObjectURL(blob);
        const link = root.ownerDocument.createElement('a');
        link.href = url; link.download = `yuzuki-voice-previews-${new Date().toISOString().slice(0, 10)}.zip`;
        root.ownerDocument.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    download.onclick = async () => {
        try { await saveZip((await library.recordsFor(getManager(), getPool())).records); }
        catch (error) { setStatus(error.message); }
    };
    importButton.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        importButton.disabled = true;
        try {
            const result = await importPreviewLibrary(file, library.store);
            await refresh();
            setStatus(`已导入 ${result.added} 款，跳过已有 ${result.skipped} 款。${result.persistent ? '' : '仅会话缓存可用，请保留 ZIP 备份。'}`);
        } catch (error) { setStatus(error.message); }
        finally { fileInput.value = ''; importButton.disabled = false; }
    };
    cancel.onclick = () => batch?.abort();
    root.addEventListener('input', event => {
        if (event.target?.matches?.('input[id^="phone-tts"], select[id^="phone-tts"]')) batch?.abort();
    });
    root.addEventListener('change', event => {
        if (event.target?.matches?.('input[id^="phone-tts"], select[id^="phone-tts"]')) batch?.abort();
    });
    generate.onclick = async () => {
        if (batch) return;
        stopPreview();
        const controller = new AbortController(); batch = controller;
        const manager = getManager();
        const pool = [...new Map(getPool().map(item => [item.id, item])).values()];
        const poolIds = JSON.stringify(getPool().map(item => item.id));
        let completed = 0, failed = 0, consecutiveFailures = 0, lastError = '';
        generate.disabled = true; importButton.disabled = true; cancel.hidden = false;
        const unwatch = watchVoicePreviewView(root, () => {
            if (!generate.isConnected || !isVoicePreviewViewActive(root) || JSON.stringify(getPool().map(item => item.id)) !== poolIds) controller.abort();
        });
        try {
            for (const item of pool) {
                if (controller.signal.aborted) break;
                const voiceController = new AbortController();
                const onAbort = () => voiceController.abort();
                controller.signal.addEventListener('abort', onAbort, { once: true });
                const timer = setTimeout(() => voiceController.abort(), 30000);
                setStatus(`正在准备 ${completed + failed + 1}/${pool.length}：${item.label || item.id}；完成 ${completed}，失败 ${failed}。`);
                try {
                    await library.get(manager, { provider: 'volcengine', voice: item.id, signal: voiceController.signal });
                    completed++; consecutiveFailures = 0;
                } catch (error) {
                    if (controller.signal.aborted) break;
                    failed++; consecutiveFailures++;
                    lastError = `${item.label || item.id}：${error.name === 'AbortError' ? '生成超时' : error.message}`;
                    if (consecutiveFailures >= 3) { lastError = `连续3款失败，已暂停；请检查配置或移除不可用音色后继续。最后一项：${lastError}`; break; }
                } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
            }
            if (!controller.signal.aborted && !failed) await saveZip((await library.recordsFor(manager, pool)).records);
        } catch (error) { lastError = error.message; }
        finally {
            unwatch(); batch = null; cancel.hidden = true; importButton.disabled = false;
            await refresh();
            setStatus(`${controller.signal.aborted ? '已停止' : '准备结束'}：可用 ${completed}，失败 ${failed}。已生成的音频会保留，可继续补齐或下载。${lastError ? ` ${lastError}` : ''}${library.store.persistent ? '' : ' 当前仅会话缓存可用，请下载备份。'}`);
        }
    };
    void refresh();
    return { refresh, stop: () => batch?.abort() };
}
