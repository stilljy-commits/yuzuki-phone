import test from 'node:test';
import assert from 'node:assert/strict';
import { VoicePreviewLibrary, PreviewAudioStore, TTS_PREVIEW_TEXT, exportPreviewLibrary, importPreviewLibrary } from '../config/tts-preview-library.js';
import { sortVoicePoolByUsage } from '../config/voice-pool-usage.js';
import { sampleContactText, buildContactHistory } from '../apps/wechat/contact-generation-context.js';
import { WechatData } from '../apps/wechat/wechat-data.js';
import { parseImportantCharacterTables, readImportantCharacterDatabase } from '../apps/wechat/character-database.js';
import { sha256Fallback } from '../config/preview-sha256.js';
import { createHash } from 'node:crypto';

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
test('LAN HTTP hashing fallback matches SHA-256 for text, padding boundaries and audio-sized data', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
        const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 19) % 256);
        assert.equal(sha256Fallback(bytes), createHash('sha256').update(bytes).digest('hex'));
    }
});
function librarySetup() {
    let calls = 0;
    const revoked = [];
    const config = { provider: 'volcengine', model: 'seed-2', apiUrl: 'https://example.test/tts', apiKey: 'secret-key', appId: 'secret-app' };
    const manager = { _resolveConfig: options => ({ ...config, ...options }), requestTTS: async () => { calls++; return 'blob:test'; } };
    const store = new PreviewAudioStore(null);
    const library = new VoicePreviewLibrary({ store, fetchAudio: async () => new Response(new Blob(['audio'], { type: 'audio/wav' })), revokeUrl: url => revoked.push(url) });
    return { library, manager, store, config, revoked, calls: () => calls };
}

test('preview generates once, then reads local audio across library instances without TTS', async () => {
    const s = librarySetup(), options = { provider: 'volcengine', voice: 'voice-a' };
    const first = await s.library.get(s.manager, options);
    assert.equal(first.source, 'generated'); assert.equal(first.persistent, false);
    const second = await new VoicePreviewLibrary({ store: s.store }).get(s.manager, options);
    assert.equal(second.source, 'local'); assert.equal(await second.blob.text(), 'audio');
    assert.equal(s.calls(), 1); assert.deepEqual(s.revoked, ['blob:test']);
});

test('configuration invalidates audio identity but API key rotation and Doubao language do not', async () => {
    const s = librarySetup(), options = { provider: 'volcengine', voice: 'a' };
    await s.library.get(s.manager, options);
    s.config.apiKey = 'rotated-key';
    await s.library.get(s.manager, { ...options, languageBoost: 'Chinese,Yue' });
    assert.equal(s.calls(), 1);
    s.config.model = 'different'; await s.library.get(s.manager, options);
    s.config.apiUrl = 'https://different.test/tts'; await s.library.get(s.manager, options);
    await s.library.get(s.manager, { ...options, voice: 'b' });
    assert.equal(s.calls(), 4);
    const serialized = JSON.stringify((await s.library.lookup(s.manager, options)).record?.descriptor);
    assert.ok(!serialized.includes('secret')); assert.ok(!serialized.includes('different.test')); assert.ok(!serialized.includes('rotated-key'));
});

test('MiniMax preview language is part of the local audio identity', async () => {
    const s = librarySetup();
    const a = await s.library.describe(s.manager, { provider: 'minimax_cn', voice: 'a', languageBoost: 'Chinese' });
    const b = await s.library.describe(s.manager, { provider: 'minimax_cn', voice: 'a', languageBoost: 'Chinese,Yue' });
    assert.notEqual(a.key, b.key);
});

test('concurrent requests share one generation and cancelling one listener keeps the other', async () => {
    const s = librarySetup(), controller = new AbortController();
    let resolve, signal;
    s.manager.requestTTS = (_text, options) => { signal = options.signal; return new Promise(yes => { resolve = yes; }); };
    const first = s.library.get(s.manager, { voice: 'a', signal: controller.signal }).catch(error => error);
    const second = s.library.get(s.manager, { voice: 'a' });
    await tick(); controller.abort();
    assert.equal((await first).name, 'AbortError'); assert.equal(signal.aborted, false);
    resolve('blob:shared'); assert.equal((await second).source, 'generated');
    assert.deepEqual(s.revoked, ['blob:shared']);
});

test('cancelling all listeners prevents a late result from being cached and allows retry', async () => {
    const s = librarySetup(), controller = new AbortController(); let resolve, signal;
    s.manager.requestTTS = (_text, options) => { signal = options.signal; return new Promise(yes => { resolve = yes; }); };
    const first = s.library.get(s.manager, { voice: 'a', signal: controller.signal }).catch(error => error);
    await tick(); controller.abort(); assert.equal((await first).name, 'AbortError'); assert.equal(signal.aborted, true);
    resolve('blob:late'); await tick();
    assert.equal((await s.library.lookup(s.manager, { voice: 'a' })).record, null);
    s.manager.requestTTS = async () => 'blob:retry';
    assert.equal((await s.library.get(s.manager, { voice: 'a' })).source, 'generated');
});

test('failed generation and invalid audio are never cached', async () => {
    const s = librarySetup();
    s.manager.requestTTS = async () => { throw new Error('quota'); };
    await assert.rejects(s.library.get(s.manager, { voice: 'a' }), /quota/);
    assert.equal((await s.library.lookup(s.manager, { voice: 'a' })).record, null);
    s.manager.requestTTS = async () => 'blob:error';
    s.library.fetchAudio = async () => new Response('error', { headers: { 'Content-Type': 'text/plain' } });
    await assert.rejects(s.library.get(s.manager, { voice: 'a' }), /无效/);
    assert.deepEqual(s.revoked, ['blob:error']);
});

test('ZIP backup restores exact audio offline, skips duplicates and excludes credentials', async () => {
    const s = librarySetup();
    await s.library.get(s.manager, { voice: '小月/a' });
    const { records, total } = await s.library.recordsFor(s.manager, [{ id: '小月/a' }, { id: '小月/a' }, { id: 'missing' }]);
    assert.equal(records.length, 1); assert.equal(total, 2);
    const zip = await exportPreviewLibrary(records);
    assert.ok(!(await zip.text()).includes('secret-key'));
    const store = new PreviewAudioStore(null);
    assert.deepEqual(await importPreviewLibrary(zip, store), { added: 1, skipped: 0, persistent: false });
    assert.equal((await importPreviewLibrary(zip, store)).skipped, 1);
    const library = new VoicePreviewLibrary({ store });
    s.manager.requestTTS = () => { throw new Error('must not call TTS'); };
    assert.equal((await library.get(s.manager, { voice: '小月/a' })).source, 'local');
    assert.equal(TTS_PREVIEW_TEXT.length, 49);
});

test('tampered ZIP is rejected without partially importing records', async () => {
    const s = librarySetup(); await s.library.get(s.manager, { voice: 'a' });
    const zip = await exportPreviewLibrary((await s.library.recordsFor(s.manager, [{ id: 'a' }])).records);
    const data = new Uint8Array(await zip.arrayBuffer()); data[60] ^= 1;
    const store = new PreviewAudioStore(null);
    await assert.rejects(importPreviewLibrary(new Blob([data]), store), /校验|清单/);
    assert.equal(store.memory.size, 0);
});

function usageData() {
    const writes = [];
    const data = Object.create(WechatData.prototype);
    const values = { 'phone-tts-provider': 'volcengine', 'phone-tts-volc-voice-pool': JSON.stringify([{ id: 'auto', gender: 'f' }]) };
    data.storage = { get: key => values[key], set: async (...args) => writes.push(args) };
    data.data = { contacts: [
        { id: 'a', name: '甲', ttsVoices: { volcengine: 'used' }, gender: 'female' },
        { id: 'b', name: '乙', ttsVoices: { volcengine: 'used' }, ttsProvider: 'minimax_cn' },
        { id: 'c', name: '丙', gender: 'female' }], chats: [
        { id: 'private-a', type: 'single', name: '甲' }, { id: 'g', type: 'group', name: '群聊', ttsVoice: 'used' }], userInfo: { id: 'me', name: '我' } };
    return { data, writes };
}

test('usage sorts unused first, counts manual and automatic voices once per character without writing pins', () => {
    const { data, writes } = usageData();
    const result = sortVoicePoolByUsage([{ id: 'used' }, { id: 'free-b' }, { id: 'auto' }, { id: 'free-a' }], data);
    assert.deepEqual(result.map(v => [v.id, v.usageCount, v.sourceIndex]), [['free-b', 0, 1], ['free-a', 0, 3], ['auto', 1, 2], ['used', 2, 0]]);
    assert.deepEqual(result.at(-1).usedBy, ['甲', '乙']); assert.equal(writes.length, 0);
    data.data.contacts = [];
    data.data.chats = [];
    assert.ok(sortVoicePoolByUsage([{ id: 'used' }], data).every(v => !v.usageCount));
});

test('contact history includes names after the old 180-char cut, old messages and actual speakers', () => {
    const context = { chat: Array.from({ length: 60 }, (_, i) => ({ name: i === 0 ? '较早主角' : '小月', mes: i === 0 ? '张晨是主要同伴' : i === 40 ? '甲'.repeat(200) + '苏沐晴就在身旁。' : `记录${i}` })) };
    const result = buildContactHistory(context, { charName: '小月', userName: '我' });
    assert.ok(result.text.includes('苏沐晴')); assert.ok(result.text.includes('张晨'));
    assert.ok(result.text.includes('较早主角:')); assert.ok(result.candidates.includes('较早主角'));
    assert.equal(result.recent, 30); assert.equal(result.older, 12);
    const long = '头'.repeat(4000) + '尾部角色';
    assert.ok(sampleContactText(long, 900).endsWith('尾部角色')); assert.ok(sampleContactText(long, 900).length <= 900);
});

test('contact prompt reads V2 character card fields and appends coverage rule to saved prompts', async () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    const data = Object.create(WechatData.prototype);
    data.data = { contacts: [{ name: '旧友' }] };
    data._buildLobbyLinkSelection = () => ({ isLobby: false }); data._resolveLobbySelectedUsers = () => [];
    data._resolveLobbySelectedUserProfiles = async () => [];
    globalThis.document = { getElementById: () => null };
    globalThis.window = { VirtualPhone: { promptManager: { _loaded: true, getPromptForFeature: () => '用户已保存的原提示词' }, worldbookManager: { appendWorldbookMessages: async messages => messages.push({ role: 'system', content: '世界书人物林霜' }) } } };
    try {
        const messages = await data.buildContactPrompt({ name1: '我', name2: '小月', characterId: 0, characters: [{ data: { description: '主要角色林遥', personality: '人物性格', scenario: '校园故事' } }], chat: [] });
        const prompt = messages.map(m => m.content).join('\n');
        assert.match(prompt, /主要角色林遥/); assert.match(prompt, /人物性格/); assert.match(prompt, /世界书人物林霜/);
        assert.match(prompt, /用户已保存的原提示词/); assert.match(prompt, /主要人物覆盖核对/); assert.match(prompt, /不为凑满/);
    } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

test('failed or stale contact generation never clears existing contacts', async () => {
    const original = globalThis.SillyTavern;
    let context = { characterId: 1, chatId: 'story-a' }, clears = 0;
    globalThis.SillyTavern = { getContext: () => context };
    const data = Object.create(WechatData.prototype); data.data = { contacts: [{ name: '旧友' }] };
    data._buildLobbyLinkSelection = () => ({ isLobby: false });
    data.buildContactPrompt = async () => []; data.clearContactsAndGroupsForSmartLoad = () => { clears++; };
    data.sendToAI = async () => 'invalid';
    const oldError = console.error; console.error = () => {};
    try {
        assert.equal((await data.loadContactsFromCharacter({ replaceExisting: true })).success, false);
        data.sendToAI = async () => { context = { ...context, chatId: 'story-b' }; return 'ignored'; };
        const result = await data.loadContactsFromCharacter({ replaceExisting: true });
        assert.equal(result.success, false); assert.match(result.message, /已切换作品/);
        assert.equal(clears, 0); assert.equal(data.data.contacts[0].name, '旧友');
    } finally { console.error = oldError; globalThis.SillyTavern = original; }
});

const databaseFixture = () => ({ mate: { type: 'chatSheets' }, sheet_custom_id: { name: '重要角色表', content: [
    ['row_id', '姓名', '性别/年龄', '一句话介绍', '外貌特征', '是否离场', '过往经历'],
    [1, '林霜', '女/22', '调查记者', '黑发', '否', '曾与你共同调查一宗案件'],
    [2, '陈晨', '男/25', '老朋友', '戴眼镜', '是', '很久以前就与你相识'],
    [3, '我', '女/20', '主角', '', '否', '']
] }, sheet_inventory: { name: '重要物品表', content: [['姓名'], ['不能当人物']] } });

test('database reads actual shujuku header layout and only the important-character table', async () => {
    const raw = databaseFixture(), before = JSON.stringify(raw);
    const result = parseImportantCharacterTables(raw);
    assert.deepEqual(result.characters.map(c => c.name), ['林霜', '陈晨', '我']);
    assert.equal(result.characters[0].gender, 'female'); assert.equal(result.characters[1].gender, 'male');
    assert.equal(result.characters[0].summary, '调查记者');
    assert.ok(result.characters[0].fields.every(f => f.label !== 'row_id'));
    let reads = 0;
    const database = await readImportantCharacterDatabase({ AutoCardUpdaterAPI: { exportTableAsJson() { reads++; return raw; } } });
    assert.equal(database.characters.length, 3); assert.equal(reads, 1); assert.equal(JSON.stringify(raw), before);
    assert.equal((await readImportantCharacterDatabase({})).available, false);
    assert.match((await readImportantCharacterDatabase({ AutoCardUpdaterAPI: { exportTableAsJson() { throw new Error('not ready'); } } })).message, /not ready/);
});

test('database direct import needs no AI, includes absent characters, skips self and preserves manual profiles and chats', async () => {
    const oldWindow = globalThis.window, oldST = globalThis.SillyTavern;
    const context = { characterId: 1, chatId: 'work-a', name1: '我' };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = { AutoCardUpdaterAPI: { exportTableAsJson: databaseFixture } };
    const data = Object.create(WechatData.prototype), manual = { origin: 'manual', summary: '手动写的人物详情' };
    data.data = { contacts: [{ id: 'old', name: '陈晨', gender: 'unknown', detailedProfile: manual }], chats: [{ id: 'old-chat', name: '陈晨' }], messages: { 'old-chat': ['保留的聊天'] }, userInfo: { name: '我' } };
    data._buildLobbyLinkSelection = () => ({ isLobby: false });
    let saves = 0; data.saveData = async () => saves++; data.sendToAI = () => { throw new Error('must not call AI'); };
    try {
        const result = await data.loadContactsFromDatabase();
        assert.equal(result.success, true); assert.equal(result.count, 1); assert.equal(data.data.contacts.length, 2);
        assert.equal(data.data.contacts[0].detailedProfile, manual); assert.equal(data.data.contacts[0].gender, 'male');
        assert.equal(data.data.contacts[1].detailedProfile.origin, 'database');
        assert.equal(data.data.contacts[1].detailedProfile.summary, '调查记者');
        assert.deepEqual(data.data.messages['old-chat'], ['保留的聊天']); assert.equal(saves, 1);
        assert.equal((await data.loadContactsFromDatabase()).count, 0);
    } finally { globalThis.window = oldWindow; globalThis.SillyTavern = oldST; }
});

test('database-backed AI prompt uses recent chat only and includes every table character as context', async () => {
    const oldWindow = globalThis.window, oldDocument = globalThis.document;
    const data = Object.create(WechatData.prototype); data.data = { contacts: [] };
    data._buildLobbyLinkSelection = () => ({ isLobby: false }); data._resolveLobbySelectedUsers = () => [];
    data._resolveLobbySelectedUserProfiles = async () => [];
    globalThis.document = { getElementById: () => null };
    globalThis.window = { VirtualPhone: { promptManager: { _loaded: true, getPromptForFeature: () => '格式规则' } } };
    try {
        const context = { name1: '我', name2: '叙述者', chat: Array.from({ length: 100 }, (_, i) => ({ mes: i === 0 ? '非常古老的聊天内容' : `近期状态${i}` })) };
        const messages = await data.buildContactPrompt(context, { database: parseImportantCharacterTables(databaseFixture()) });
        const text = messages.map(m => m.content).join('\n');
        assert.match(text, /林霜/); assert.match(text, /陈晨/); assert.match(text, /调查记者/);
        assert.ok(!text.includes('非常古老的聊天内容')); assert.match(text, /近期状态99/);
        assert.match(text, /较早0条抽样/);
    } finally { globalThis.window = oldWindow; globalThis.document = oldDocument; }
});

test('database import rejects a late response after switching works', async () => {
    const oldWindow = globalThis.window, oldST = globalThis.SillyTavern;
    let context = { characterId: 1, chatId: 'a' };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = { AutoCardUpdaterAPI: { exportTableAsJson: () => { context = { ...context, chatId: 'b' }; return databaseFixture(); } } };
    const data = Object.create(WechatData.prototype); data.data = { contacts: [] };
    data._buildLobbyLinkSelection = () => ({ isLobby: false });
    data.saveData = () => { throw new Error('must not save'); };
    try {
        const result = await data.loadContactsFromDatabase();
        assert.equal(result.success, false); assert.match(result.message, /已切换作品/); assert.equal(data.data.contacts.length, 0);
    } finally { globalThis.window = oldWindow; globalThis.SillyTavern = oldST; }
});
