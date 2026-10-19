import { voicePreviewLibrary, TTS_PREVIEW_TEXT } from './tts-preview-library.js?v=20261020-local-library';
export { TTS_PREVIEW_TEXT };

export function isVoicePreviewViewActive(root) {
    return !!root?.isConnected && root.classList.contains('phone-view-current')
        && (!root.checkVisibility || root.checkVisibility({ checkVisibilityCSS: true }));
}

export function watchVoicePreviewView(root, onChange) {
    if (!globalThis.MutationObserver || !root?.ownerDocument?.body) return () => {};
    const observer = new MutationObserver(onChange);
    observer.observe(root.ownerDocument.body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'open', 'hidden']
    });
    return () => observer.disconnect();
}

// Shared by contact selection and the settings voice pool; never saves a voice binding.
export class TtsVoicePreview {
    constructor({ getManager = () => globalThis.window?.VirtualPhone?.ttsManager, isActive = () => true,
        watchActive = null, onState = () => {}, onError = () => {}, createAudio = url => new Audio(url),
        revokeUrl = url => URL.revokeObjectURL(url), library = typeof window === 'undefined' ? null : voicePreviewLibrary } = {}) {
        Object.assign(this, { getManager, isActive, watchActive, onState, onError, createAudio, revokeUrl, library });
        this.current = null;
    }

    _revoke(url) {
        if (String(url || '').startsWith('blob:')) this.revokeUrl(url);
    }

    _isLive(ticket) {
        return this.current === ticket && this.isActive() && ticket.button?.isConnected !== false
            && (!ticket.button?.checkVisibility || ticket.button.checkVisibility({ checkVisibilityCSS: true }));
    }

    _state(ticket, state) {
        if (ticket.button) {
            ticket.button.textContent = state === 'playing' ? '停止' : '取消';
            ticket.button.setAttribute('aria-pressed', 'true');
        }
        this.onState({ state, options: ticket.options });
    }

    _finish(ticket, error = null) {
        if (this.current !== ticket) return;
        const reportError = error && this._isLive(ticket);
        this.current = null;
        ticket.controller.abort();
        clearTimeout(ticket.timer);
        ticket.unwatch?.();
        if (ticket.audio) {
            ticket.audio.onended = ticket.audio.onerror = ticket.audio.onplaying = null;
            ticket.audio.pause();
            if (ticket.audio.removeAttribute) ticket.audio.removeAttribute('src');
            else ticket.audio.src = '';
            ticket.audio.load?.();
        }
        this._revoke(ticket.url);
        if (ticket.button) {
            ticket.button.textContent = ticket.buttonText;
            ticket.button.setAttribute('aria-pressed', 'false');
        }
        const message = error?.name === 'NotAllowedError' ? '浏览器阻止了声音播放，请允许播放后重试。' : error?.message;
        this.onState({ state: 'idle', options: ticket.options, error: reportError ? message : '' });
        if (reportError) this.onError(new Error(message || '无法播放试听音频'));
    }

    stop() {
        if (this.current) this._finish(this.current);
    }

    async play(options = {}, button = null) {
        if (button && this.current?.button === button) { this.stop(); return false; }
        this.stop();
        if (!this.isActive()) return false;
        const manager = this.getManager();
        if (!manager?.requestTTS) { this.onError(new Error('请先在手机设置中配置语音服务。')); return false; }
        const ticket = { options: { ...options }, button, buttonText: button?.textContent || '试听', controller: new AbortController(), url: '' };
        this.current = ticket;
        const signal = ticket.controller.signal;
        const aborted = new Promise((_, reject) => {
            ticket.abortListener = () => reject(ticket.failure || new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', ticket.abortListener, { once: true });
        });
        const timeout = (ms, message) => {
            clearTimeout(ticket.timer);
            ticket.timer = setTimeout(() => { ticket.failure = new Error(message); ticket.controller.abort(); }, ms);
        };
        this._state(ticket, 'loading');
        try {
            ticket.unwatch = this.watchActive?.(() => { if (!this._isLive(ticket)) this._finish(ticket); });
            timeout(options.requestTimeoutMs || 30000, '试听生成超时，请重试。');
            const request = Promise.resolve(this.library ? this.library.get(manager, { ...options, signal }).then(result => {
                ticket.options.source = result.source;
                ticket.options.persistent = result.persistent;
                return URL.createObjectURL(result.blob);
            }) : manager.requestTTS(TTS_PREVIEW_TEXT, {
                provider: options.provider, voice: options.voice, languageBoost: options.languageBoost, signal
            })).then(url => {
                if (!this._isLive(ticket) || signal.aborted) {
                    this._revoke(url);
                    throw new DOMException('Aborted', 'AbortError');
                }
                return url;
            });
            ticket.url = await Promise.race([request, aborted]);
            clearTimeout(ticket.timer);
            if (!ticket.url) throw new Error('语音服务未返回可播放的音频。');
            ticket.audio = this.createAudio(ticket.url);
            ticket.audio.onended = () => this._finish(ticket);
            ticket.audio.onerror = () => this._finish(ticket, new Error('音频播放失败，请检查音色和语音服务配置。'));
            timeout(options.playbackTimeoutMs || 10000, '试听播放超时，请重试。');
            await Promise.race([
                new Promise((resolve, reject) => {
                    ticket.audio.onplaying = resolve;
                    const playResult = ticket.audio.play();
                    playResult?.then?.(resolve, reject);
                }),
                aborted
            ]);
            clearTimeout(ticket.timer);
            if (!this._isLive(ticket)) { this._finish(ticket); return false; }
            this._state(ticket, 'playing');
            return true;
        } catch (error) {
            if (this.current === ticket) this._finish(ticket, error?.name === 'AbortError' ? null : error);
            return false;
        } finally {
            signal.removeEventListener('abort', ticket.abortListener);
        }
    }
}
