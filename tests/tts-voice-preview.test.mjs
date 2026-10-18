import assert from 'node:assert/strict';
import test from 'node:test';
import { TtsVoicePreview, TTS_PREVIEW_TEXT } from '../config/tts-preview.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = () => ({ textContent: '试听', isConnected: true, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
function setup(requestTTS, extra = {}) {
    const audio = [], revoked = [], errors = [], states = [];
    const preview = new TtsVoicePreview({
        getManager: () => ({ requestTTS }), revokeUrl: url => revoked.push(url),
        createAudio: url => {
            const result = { src: url, pauses: 0, play: () => Promise.resolve(), pause() { this.pauses++; }, ...extra.audio };
            audio.push(result); return result;
        },
        onError: error => errors.push(error.message), onState: state => states.push(state), ...extra.options
    });
    return { preview, audio, revoked, errors, states };
}

test('preview uses the candidate provider, unsaved voice ID and contact language', async () => {
    let sent;
    const { preview, states } = setup(async (text, options) => { sent = { text, options }; return 'blob:candidate'; });
    const target = button();
    try {
        assert.equal(await preview.play({ provider: 'minimax_cn', voice: 'unsaved-voice', languageBoost: 'Chinese,Yue' }, target), true);
        assert.equal(sent.text, TTS_PREVIEW_TEXT);
        assert.equal(sent.options.provider, 'minimax_cn');
        assert.equal(sent.options.voice, 'unsaved-voice');
        assert.equal(sent.options.languageBoost, 'Chinese,Yue');
        assert.equal(target.textContent, '停止');
        assert.deepEqual(states.map(item => item.state), ['loading', 'playing']);
    } finally { preview.stop(); }
});

test('clicking the same preview again stops audio and releases its URL without a second request', async () => {
    let calls = 0;
    const { preview, audio, revoked } = setup(async () => { calls++; return 'blob:one'; });
    const target = button();
    await preview.play({ provider: 'volcengine', voice: 'one' }, target);
    assert.equal(await preview.play({ provider: 'volcengine', voice: 'one' }, target), false);
    assert.equal(calls, 1); assert.equal(audio[0].pauses, 1);
    assert.deepEqual(revoked, ['blob:one']); assert.equal(target.textContent, '试听');
});

test('switching voices cancels pending work and cannot play a late response from the old voice', async () => {
    const old = deferred(), fresh = deferred(); let oldSignal;
    const { preview, audio, revoked, errors } = setup(async (_text, options) => {
        if (options.voice === 'old') { oldSignal = options.signal; return old.promise; }
        return fresh.promise;
    });
    const first = preview.play({ voice: 'old' }, button());
    const second = preview.play({ voice: 'fresh' }, button());
    fresh.resolve('blob:fresh'); assert.equal(await second, true);
    assert.equal(await first, false); assert.equal(oldSignal.aborted, true);
    old.resolve('blob:old'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(audio.map(item => item.src), ['blob:fresh']);
    assert.deepEqual(revoked, ['blob:old']); assert.deepEqual(errors, []);
    preview.stop();
});

test('leaving the selection page aborts pending preview and suppresses late errors', async () => {
    const response = deferred(); let active = true, changed, unwatches = 0;
    const { preview, errors, revoked } = setup(() => response.promise, { options: {
        isActive: () => active, watchActive: callback => { changed = callback; return () => unwatches++; }
    } });
    const target = button(), task = preview.play({ voice: 'one' }, target);
    active = false; changed();
    assert.equal(await task, false); assert.equal(target.textContent, '试听'); assert.equal(unwatches, 1);
    response.resolve('blob:late'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(revoked, ['blob:late']); assert.deepEqual(errors, []);
});

test('preview failures restore controls and allow retry', async () => {
    let calls = 0;
    const { preview, errors } = setup(async () => { if (!calls++) throw new Error('音色不可用'); return 'blob:retry'; });
    const target = button();
    assert.equal(await preview.play({ voice: 'invalid' }, target), false);
    assert.equal(target.textContent, '试听'); assert.deepEqual(errors, ['音色不可用']);
    assert.equal(await preview.play({ voice: 'fixed' }, target), true);
    preview.stop();
});

test('browser autoplay rejection is reported and the generated audio is released', async () => {
    const { preview, revoked, errors } = setup(async () => 'blob:blocked', { audio: {
        play: () => Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    } });
    const target = button();
    assert.equal(await preview.play({ voice: 'one' }, target), false);
    assert.equal(target.textContent, '试听'); assert.deepEqual(revoked, ['blob:blocked']);
    assert.match(errors[0], /允许播放/);
});

test('generation timeout recovers even when the provider ignores cancellation', async () => {
    const response = deferred(); let signal;
    const { preview, errors, revoked } = setup((_text, options) => { signal = options.signal; return response.promise; });
    assert.equal(await preview.play({ voice: 'slow', requestTimeoutMs: 5 }, button()), false);
    assert.equal(signal.aborted, true); assert.match(errors[0], /生成超时/);
    response.resolve('blob:timeout-late'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(revoked, ['blob:timeout-late']);
});

test('playback timeout restores a stalled audio control', async () => {
    const { preview, errors, revoked } = setup(async () => 'blob:stalled', { audio: { play: () => new Promise(() => {}) } });
    const target = button();
    assert.equal(await preview.play({ voice: 'one', playbackTimeoutMs: 5 }, target), false);
    assert.equal(target.textContent, '试听'); assert.deepEqual(revoked, ['blob:stalled']); assert.match(errors[0], /播放超时/);
});

test('ending playback restores the button and disconnects page observation', async () => {
    let unwatches = 0;
    const { preview, audio, revoked } = setup(async () => 'blob:ended', { options: { watchActive: () => () => unwatches++ } });
    const target = button(); await preview.play({ voice: 'one' }, target); audio[0].onended();
    assert.equal(target.textContent, '试听'); assert.deepEqual(revoked, ['blob:ended']); assert.equal(unwatches, 1);
    assert.equal(preview.current, null);
});

test('preview does not start in a hidden view or without a configured manager', async () => {
    const hidden = setup(() => { throw new Error('should not request'); }, { options: { isActive: () => false } });
    assert.equal(await hidden.preview.play({ voice: 'one' }, button()), false);
    const missing = setup(() => {}, { options: { getManager: () => null } });
    assert.equal(await missing.preview.play({ voice: 'one' }, button()), false);
    assert.match(missing.errors[0], /配置语音服务/);
});
