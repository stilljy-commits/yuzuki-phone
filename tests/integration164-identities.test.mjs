import test from 'node:test';
import assert from 'node:assert/strict';
import { WechatData } from '../apps/wechat/wechat-data.js';
import { buildContactProfileMessages } from '../apps/wechat/contact-profile.js';
import { sortVoicePoolByUsage } from '../config/voice-pool-usage.js';
import { PromptManager } from '../config/prompt-manager.js';

function setupData() {
    const values = { 'phone-tts-provider': 'volcengine', 'phone-tts-volc-auto-pick': JSON.stringify({ 'stable-id': { v: 'pinned-voice', g: 'f' } }),
        'phone-tts-volc-voice-pool': JSON.stringify([{ id: 'pinned-voice', gender: 'f' }, { id: 'another', gender: 'f' }]) };
    const data = Object.create(WechatData.prototype), writes = [];
    data.storage = { get: k => values[k], set: async (k, v) => { values[k] = v; writes.push(k); } };
    data.data = { contacts: [{ id: 'stable-id', name: '夜雨', nickname: '夜雨', remark: '晓雨姐', realName: '林晓雨', gender: 'female', ttsVoices: {} }],
        chats: [{ id: 'chat-old', type: 'single', contactId: 'stable-id', name: '很久以前的昵称' }], userInfo: { name: '我' } };
    data.saveData = async () => {};
    data._buildLobbyLinkSelection = () => ({ isLobby: false });
    return { data, values, writes };
}

test('nickname, remark and real name resolve to the old contact ID and keep its pinned/manual voice', () => {
    const { data, writes } = setupData();
    for (const name of ['夜雨', '晓雨姐', '林晓雨']) {
        assert.equal(data.resolveTtsVoiceByName(name, { persistAutoPick: false }).voice, 'pinned-voice');
        assert.equal(data.resolveTtsVoiceByName(name, { persistAutoPick: false }).contact.id, 'stable-id');
    }
    const sorted = sortVoicePoolByUsage([{ id: 'pinned-voice' }, { id: 'another' }], data);
    assert.deepEqual(sorted.map(v => [v.id, v.usageCount]), [['another', 0], ['pinned-voice', 1]]);
    assert.deepEqual(sorted[1].usedBy, ['晓雨姐']); assert.equal(writes.length, 0);
    data.data.contacts[0].ttsVoices.volcengine = 'manual';
    assert.equal(data.resolveTtsVoiceByName('林晓雨').voice, 'manual');
});

test('profile generation identifies one person by real name with nickname and remark as aliases', () => {
    const { data } = setupData();
    const messages = buildContactProfileMessages(data.data.contacts[0], {});
    assert.ok(messages.at(-1).content.includes('人物“林晓雨”'));
    assert.match(messages.at(-1).content, /微信昵称：夜雨/);
    assert.match(messages.at(-1).content, /备注：晓雨姐/);
});

test('new AI contact format fills database details by real name without duplicating an existing nickname', async () => {
    const oldST = globalThis.SillyTavern, oldWindow = globalThis.window;
    const context = { name1: '我', characterId: 0, chatId: 'same-work' };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = { AutoCardUpdaterAPI: { exportTableAsJson: () => ({ sheet_custom: { name: '重要角色表', content: [
        ['row_id', '姓名', '性别/年龄', '一句话介绍'], [1, '林晓雨', '女/25', '重要的旧友'], [2, '林霜', '女/22', '调查记者']
    ] } }) } };
    const { data } = setupData();
    data.buildContactPrompt = async () => [];
    data.setContactGender = () => {};
    data.sendToAI = async () => '<初始化设定>\n---【微信群】---\n---【微信好友】---\n1.夜雨-晓雨姐-林晓雨-女\n2.Momo-无-林霜-女\n---【初始时间】---\n年月日：2026年10月22日12:00\n星期：星期四\n</初始化设定>';
    try {
        const result = await data.loadContactsFromCharacter();
        assert.equal(result.success, true); assert.equal(result.count, 1);
        assert.equal(data.data.contacts.length, 2); assert.equal(data.data.contacts[0].id, 'stable-id');
        assert.equal(data.data.contacts[0].detailedProfile.summary, '重要的旧友');
        assert.equal(data.data.contacts[1].name, 'Momo'); assert.equal(data.data.contacts[1].realName, '林霜');
        assert.equal(data.data.contacts[1].detailedProfile.origin, 'database');
        assert.equal(data.data.contacts[1].detailedProfile.summary, '调查记者');
    } finally { globalThis.SillyTavern = oldST; globalThis.window = oldWindow; }
});

test('merged defaults keep the new contact format while refusing invented names or filler contacts', () => {
    const manager = new PromptManager({ get: () => null });
    const content = manager.getDefaultPrompts().wechat.loadContacts.content;
    assert.match(content, /昵称-备注-真实姓名-性别/);
    assert.match(content, /不得编造/); assert.match(content, /不设最低/);
    assert.ok(!content.includes('好友不得少于5人'));
});
