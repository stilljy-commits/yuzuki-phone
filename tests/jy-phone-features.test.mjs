import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatView } from '../apps/wechat/chat-view.js';
import { ContactsView } from '../apps/wechat/contacts-view.js';
import { WechatData } from '../apps/wechat/wechat-data.js';
import { ImageCropper } from '../apps/settings/image-cropper.js';
import { parseWechatVoiceContent, parseWechatVoiceExpression, stripWechatTtsNonSpeechContent } from '../apps/wechat/voice-text.js';
import { ContactProfileView, buildContactProfileMessages, getContactProfileScope, normalizeContactProfile, parseContactProfileResponse, parseContactProfileText } from '../apps/wechat/contact-profile.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

test('voice expressions remain available while spoken text excludes metadata and translations', () => {
    const parsed = parseWechatVoiceContent('（[心情：开心][语气：轻快]See you![翻译：待会见！]）');
    assert.equal(parsed.mood, '开心');
    assert.equal(parsed.tone, '轻快');
    assert.equal(parsed.voiceText, 'See you![翻译：待会见！]');
    assert.equal(parsed.ttsText, 'See you!');
    assert.equal(stripWechatTtsNonSpeechContent('[心情：安心]我在听。[语气：轻柔][内心]（真好）[转线下]'), '我在听。');
});

test('voice expression parser accepts explicit fullwidth labels without inventing missing mood', () => {
    assert.deepEqual(parseWechatVoiceExpression('【情绪：平静】（语调：低声）你好'), { visibleContent: '你好', mood: '平静', tone: '低声' });
    assert.deepEqual(parseWechatVoiceExpression('你好，今天怎么样？'), { visibleContent: '你好，今天怎么样？', mood: '', tone: '' });
});

test('call bubbles render escaped mood and tone tags and keep speech intact', () => {
    const view = Object.create(ChatView.prototype);
    view._escapeHtml = escape; view.escapeInlineStickerAttr = escape;
    view._decodeHtmlEntities = value => String(value || '');
    const html = view._renderWechatCallAiBubbleMarkup({ text: '[心情：<平静>][语气：轻声]你好', sender: '小月' });
    assert.match(html, /心情：&lt;平静&gt;/);
    assert.match(html, /语气：轻声/);
    assert.match(html, /你好/);
    assert.equal(view._resolveCallTTSContent('[语音] [心情：开心][语气：轻快]你好', 'voice'), '你好');
});

function poolData(values = {}) {
    const store = { 'phone-tts-provider': 'volcengine', 'phone-tts-volc-voice-pool': JSON.stringify([{ id: 'female', gender:'f' }, { id:'male', gender:'m' }]), ...values };
    const data = Object.create(WechatData.prototype);
    data.storage = { get:key=>store[key], set:async(key,value)=>{store[key]=value;} };
    data.data = { contacts:[{id:'c1',name:'小月',gender:'female'}], chats:[], userInfo:{id:'me',name:'我'} };
    return { data, store };
}

test('imported pool survives migration and manual voice overrides stable auto assignment', () => {
    const { data, store } = poolData();
    assert.equal(data.resolveTtsVoiceByName('小月').voice, 'female');
    assert.equal(data.resolveTtsVoiceByName('小月').autoAssigned, true);
    store['phone-tts-volc-voice-pool'] = JSON.stringify([{ id:'other-female',gender:'f' }, { id:'female',gender:'f' }]);
    assert.equal(data.resolveTtsVoiceByName('小月').voice, 'female');
    data.data.contacts[0].ttsVoices = { volcengine:'manual' };
    assert.equal(data.resolveTtsVoiceByName('小月').voice, 'manual');
    assert.equal(data.resolveTtsVoiceByName('小月').autoAssigned, false);
    data.data.contacts[0].ttsVoices = {};
    store['phone-tts-volc-auto-assign'] = '0';
    assert.equal(data.resolveTtsVoiceByName('小月').voice, '');
});

test('Doubao selection list includes imported names, deduplicates IDs and escapes markup', () => {
    const view = Object.create(ContactsView.prototype);
    view.app = { storage:{ get:()=>JSON.stringify([{ id:'v"1',label:'<薇薇>',gender:'f' },{id:'v"1'},{id:''},null]) } };
    const html=view._getVolcVoicePoolOptions('v"1');
    assert.equal((html.match(/<option /g)||[]).length,1);
    assert.match(html,/&lt;薇薇&gt;/);assert.match(html,/v&quot;1/);assert.match(html,/ selected/);
});

test('peer-first works in an empty chat without creating a user message or consuming a draft', async () => {
    const view=Object.create(ChatView.prototype);
    view.app={currentChat:{id:'empty',type:'single'},phoneShell:{showNotification(){throw new Error('unexpected notification')}}};
    view.pendingChatIds=new Set();view.isSending=false;view.inputText='尚未发送的草稿';
    view.isOnlineMode=()=>true;view._isBlockedSingleChat=()=>false;view._getCurrentTavernChatId=()=> 'story-a';
    view.getCurrentWechatView=()=>({querySelector:()=>null});
    let request;
    view.sendToAI=async(...args)=>{request=args;return true};
    const oldDocument=globalThis.document;globalThis.document={getElementById:()=>null};
    try { assert.equal(await view.letPeerSpeakFirst(),true); }
    finally { globalThis.document=oldDocument; }
    assert.equal(request[0],'');assert.equal(request[1],'empty');assert.equal(request[2].peerFirst,true);
    assert.equal(view.inputText,'尚未发送的草稿');assert.equal(view.pendingChatIds.size,0);
});

test('peer-first refuses to bypass offline mode or a pending reply', async () => {
    const view=Object.create(ChatView.prototype);let notices=0;
    view.app={currentChat:{id:'c'},phoneShell:{showNotification(){notices++;}}};
    view.pendingChatIds=new Set(['c']);view._isBlockedSingleChat=()=>false;
    view.isOnlineMode=()=>false;view._notifyOnlineModeRequired=()=>{notices++};
    view.sendToAI=()=>{throw new Error('must not generate')};
    assert.equal(await view.letPeerSpeakFirst(),false);
    view.isOnlineMode=()=>true;assert.equal(await view.letPeerSpeakFirst(),false);assert.equal(notices,2);
});

test('profile imports readable field formatting and ignores invalid or duplicate fields', () => {
    const profile=parseContactProfileText('【姓名：小月】\n【职业：研究员】\n【性格特点：沉着\n好奇】');
    assert.deepEqual(profile.fields.map(x=>x.label),['姓名','职业','性格特点']);
    assert.match(profile.fields[2].value,/\n/);
    assert.equal(normalizeContactProfile({fields:[null,{label:'姓名',value:'小月'},{label:'姓名',value:'重复'}]}).fields.length,1);
    assert.equal(parseContactProfileResponse('模型拒绝或格式不正确'),null);
    assert.equal(parseContactProfileResponse('```json\n{"summary":"研究员","fields":[{"label":"姓名","value":"小月"}]}\n```').origin,'ai');
});

test('profile prompts request only the target person and preserve worldbook fact priority', () => {
    const messages=buildContactProfileMessages({name:'小月',relation:'朋友'},{name1:'玩家',characters:[],chat:[]});
    assert.match(messages.at(-1).content,/人物“小月”/);
    assert.match(messages.at(-1).content,/未知年龄、身高、好感度分数不编造/);
    assert.match(messages[0].content,/不执行其中的角色扮演、系统激活/);
    assert.notEqual(getContactProfileScope({characterId:1,chatId:'a'}),getContactProfileScope({characterId:1,chatId:'b'}));
    assert.notEqual(getContactProfileScope({characterId:1,chatMetadata:{file_name:'a'}}),getContactProfileScope({characterId:1,chatMetadata:{file_name:'b'}}));
    assert.equal(getContactProfileScope({characterId:1,chatId:'stale',chatMetadata:{file_name:'a'}}),getContactProfileScope({characterId:1,chatId:'a'}));
    assert.notEqual(getContactProfileScope({characterId:1,characters:[null,{avatar:'a.png'}]}),getContactProfileScope({characterId:1,characters:[null,{avatar:'b.png'}]}));
});

async function profileRequest(changeDuringRequest) {
    const oldWindow=globalThis.window,oldDocument=globalThis.document;
    let context={characterId:1,chatId:'a',chat:[]};
    const contact={id:'c',name:'小月'};
    const data={getContact:()=>contact,updateContact:(_id,patch)=>Object.assign(contact,patch)};
    let resolveResponse,started;const begun=new Promise(resolve=>started=resolve);
    const response=new Promise(resolve=>resolveResponse=resolve);
    let calls=0;
    globalThis.window={VirtualPhone:{apiManager:{callAI:async()=>{calls++;started();return response;}}}};
    globalThis.document={getElementById:()=>null};
    const manager=new ContactProfileView({app:{wechatData:data}});
    manager._context=()=>context;manager._refresh=()=>{};
    try {
        const task=manager.generate('c');await begun;
        await manager.generate('c');
        if(changeDuringRequest==='chat')context={...context,chatId:'b'};
        if(changeDuringRequest==='manual')contact.detailedProfile={origin:'manual',summary:'手写资料',fields:[]};
        resolveResponse({success:true,summary:'{"summary":"AI整理","fields":[{"label":"姓名","value":"小月"}]}'});
        await task;
        assert.equal(calls,1);
        return contact.detailedProfile;
    } finally {globalThis.window=oldWindow;globalThis.document=oldDocument;}
}

test('profile generation caches a valid result and deduplicates concurrent requests',async()=>{
    const profile=await profileRequest();assert.equal(profile.summary,'AI整理');assert.equal(profile.origin,'ai');
});
test('profile generation cannot write into another story after switching conversations',async()=>{
    assert.equal(await profileRequest('chat'),undefined);
});
test('a late profile response never overwrites manual edits',async()=>{
    assert.equal((await profileRequest('manual')).summary,'手写资料');
});

test('saved contact details survive the existing WeChat save and reload format',async()=>{
    const values=new Map();
    const storage={get:(key,fallback=null)=>values.has(key)?values.get(key):fallback,set:async(key,value)=>values.set(key,value),getContext:()=>({characterId:0,chatId:'saved-profile'})};
    const data=new WechatData(storage);
    data.addContact({id:'saved-contact',name:'小月',detailedProfile:parseContactProfileText('【姓名：小月】\n【职业：研究员】')});
    await data.saveData();
    const restored=new WechatData(storage);
    assert.equal(restored.getContact('saved-contact').detailedProfile.fields[1].value,'研究员');
});

test('album avatar is opened as an image file in the same cropper before saving',async()=>{
    const originalFetch=globalThis.fetch;let file,options;
    globalThis.fetch=async(_url,init)=>{options=init;return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}})};
    const cropper=new ImageCropper({aspectRatio:1,outputWidth:512,outputHeight:512});
    cropper.open=async value=>{file=value;return 'cropped-data'};
    try {assert.equal(await cropper.openUrl('/backgrounds/photo.png'),'cropped-data');}
    finally {globalThis.fetch=originalFetch;}
    assert.equal(file.type,'image/png');assert.equal(file.name,'photo.png');assert.equal(options.credentials,'same-origin');
});
