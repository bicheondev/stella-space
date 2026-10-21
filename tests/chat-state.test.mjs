import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker,{parseFxReplies,memberFromPath} from '../worker/index.js';
async function setup(){
 const html=await(await worker.fetch(new Request('https://test/'))).text();
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 new vm.Script(script);
 const elements=new Map(),element=()=>({textContent:'',value:'',className:'',hidden:false,children:[],style:{setProperty(){}},append(...x){this.children.push(...x);},replaceChildren(){this.children=[];},setAttribute(){},querySelector(){return null;}});
 const storage=new Map(),urls=[];const ctx=vm.createContext({URL,Intl,Date,Set,Image:class{},localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)},history:{replaceState(_state,_title,url){urls.push(url);}},clearTimeout(){},setTimeout(){},document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,body:{classList:{contains(){return false;}}}}});
 vm.runInContext(script.slice(0,script.indexOf("$('choose').onclick=")),ctx);
 vm.runInContext("render=()=>{};tick=async()=>{};",ctx);
 const refresh=script.slice(script.indexOf('async function refresh()'),script.lastIndexOf('refresh();setInterval'));
 vm.runInContext(refresh,ctx);
 return{ctx,elements,urls};
}
test('opening a Hina post synchronizes the selected member and header',async()=>{
 const{ctx,elements,urls}=await setup();ctx.response={id:'room',tweet:'123',handle:'ShirayukiHina_',state:'Running'};
 vm.runInContext('api=async()=>response',ctx);await vm.runInContext("connect('https://x.com/i/status/123')",ctx);
 assert.equal(urls.at(-1),'/ShirayukiHina_');assert.equal(vm.runInContext('selected',ctx),'ShirayukiHina_');assert.equal(elements.get('selectedName').textContent,'시라유키 히나');
});
test('a member refresh started before a selection change cannot connect the old room',async()=>{
 const{ctx}=await setup();let done;ctx.pending=new Promise(r=>done=r);vm.runInContext('api=()=>pending;connect=async()=>{throw Error("unexpected connect")}',ctx);
 const pending=vm.runInContext('refresh()',ctx);vm.runInContext("generation++;selected='ShirayukiHina_'",ctx);
 done([{handle:'ShirayukiHina_',status:'live',postUrl:'old',space:'old'}]);await pending;
 assert.equal(vm.runInContext('room',ctx),null);
});
test('photo attachments accept only X media URLs and keep thumbnail originals',()=>{
 const reply={id:'2',type:'status',replying_to:{status:'1'},text:'photo',media:{photos:[{url:'https://pbs.twimg.com/media/test.jpg?name=orig'},{url:'javascript:alert(1)'},{url:'https://evil.example/test.jpg'}]}};
 const result=parseFxReplies({code:200,replies:[reply]},'1');assert.deepEqual(result.messages[0].photos,[{url:'https://pbs.twimg.com/media/test.jpg?name=orig'}]);
});

test('member paths normalize handles and reject unrelated or malformed paths',()=>{
 const groups=[['group','name',[['히나','ShirayukiHina_']]]];
 assert.equal(memberFromPath('/shirayukihina_/',groups),'ShirayukiHina_');
 assert.equal(memberFromPath('/unknown',groups),null);assert.equal(memberFromPath('/%zz',groups),null);
});
