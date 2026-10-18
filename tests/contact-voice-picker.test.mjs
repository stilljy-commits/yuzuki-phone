import assert from 'node:assert/strict';
import test from 'node:test';
import { ContactsView } from '../apps/wechat/contacts-view.js';

function picker() {
    const pool = [{id:'first',label:'薇薇',gender:'女'},{id:'Second-ID',label:'小宇',gender:'男'}];
    const button = dataset => ({dataset,textContent:'使用',attributes:{},setAttribute(key,value){this.attributes[key]=value;}});
    const previews = pool.map((_,i)=>button({voicePreview:String(i)}));
    const uses = pool.map((_,i)=>button({voiceUse:String(i)}));
    const rows = pool.map((_,i)=>({dataset:{voiceIndex:String(i)},hidden:false,selected:false,
        classList:{toggle(_class,value){rows[i].selected=value;}},querySelector:()=>uses[i]}));
    const input={value:'existing-voice',handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}};
    const provider={value:'fish'},search={value:''},summary={textContent:''},empty={hidden:true};
    const nodes={'.edit-contact-tts-provider-input[data-provider="volcengine"]':input,'#edit-contact-tts-provider-select':provider,
        '#edit-contact-volc-picker-summary':summary,'#edit-contact-volc-pool-search':search,'#edit-contact-volc-pool-empty':empty};
    const root={querySelector:selector=>nodes[selector]||null,querySelectorAll:selector=>({'[data-voice-index]':rows,'[data-voice-preview]':previews,'[data-voice-use]':uses})[selector]||[]};
    let selected=0,stops=0;const requests=[];
    const preview={play:async(options,target)=>requests.push({options,target}),stop:()=>stops++};
    const view=Object.create(ContactsView.prototype);
    const sync=view._bindVolcVoicePicker(root,{pool,preview,onSelect:()=>selected++});
    return {pool,previews,uses,rows,input,provider,search,summary,empty,requests,sync,get selected(){return selected;},get stops(){return stops;}};
}

test('voice list can preview a candidate without changing the draft binding or provider',()=>{
    const ui=picker();
    ui.previews[1].onclick();
    assert.equal(ui.requests[0].options.voice,'Second-ID');
    assert.equal(ui.requests[0].options.provider,'volcengine');
    assert.equal(ui.requests[0].target,ui.previews[1]);
    assert.equal(ui.input.value,'existing-voice');assert.equal(ui.provider.value,'fish');assert.equal(ui.selected,0);
});

test('using a candidate changes only the draft and keeps selected state aligned with manual edits',()=>{
    const ui=picker();
    ui.uses[1].onclick();
    assert.equal(ui.input.value,'Second-ID');assert.equal(ui.provider.value,'volcengine');
    assert.equal(ui.selected,1);assert.equal(ui.stops,1);assert.equal(ui.rows[1].selected,true);assert.equal(ui.uses[1].textContent,'已选');
    ui.input.value='first';ui.input.handlers.input();
    assert.equal(ui.rows[0].selected,true);assert.equal(ui.rows[1].selected,false);assert.equal(ui.uses[1].textContent,'使用');
    assert.match(ui.summary.textContent,/薇薇/);
});

test('voice list filters by name and ID without requesting any audio',()=>{
    const ui=picker();
    ui.search.value='second-id';ui.search.oninput();assert.equal(ui.rows[0].hidden,true);assert.equal(ui.rows[1].hidden,false);
    ui.search.value='没有这个人';ui.search.oninput();assert.equal(ui.empty.hidden,false);
    ui.search.value='薇薇';ui.search.oninput();assert.equal(ui.rows[0].hidden,false);assert.equal(ui.rows[1].hidden,true);
    ui.search.value='';ui.search.oninput();assert.ok(ui.rows.every(row=>!row.hidden));assert.equal(ui.empty.hidden,true);
    assert.equal(ui.requests.length,0);assert.equal(ui.selected,0);
});

test('voice list escapes candidate names and attribute delimiters',()=>{
    const view=Object.create(ContactsView.prototype);
    const html=view._renderVolcVoicePicker([{id:'id<1>',label:'薇薇" onclick="bad',gender:'女'}]);
    assert.ok(html.includes('aria-label="试听 薇薇&quot; onclick=&quot;bad"'));
    assert.match(html,/id&lt;1&gt;/);assert.doesNotMatch(html,/<button[^>]+ onclick="bad/);
    assert.match(view._renderVolcVoicePicker([]),/先在手机设置中导入/);
});
