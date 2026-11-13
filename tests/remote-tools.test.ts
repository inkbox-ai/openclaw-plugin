import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteTools, bindManagedToolPolicy } from "../src/remote-tools.js";
import { bindNativeSource } from "../src/native-source.js";

let home: string, calls: any[], descriptors: any[], remote: RemoteTools, native: any[], context: any, authority: string;
let response: (params: any) => any;
beforeEach(async () => {
 home=await mkdtemp(join(tmpdir(),'inkbox-remote-'));calls=[];native=[];authority='api_key.agent_scoped.claimed';
 context={sessionKey:'agent:main:test',sessionId:'session-1',runId:'run-1'};
 descriptors=[{name:'example_write',description:'first',inputSchema:{type:'object',properties:{text:{type:'string',minLength:2}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true}}];
 response=params=>params.requestState?{content:[{type:'text',text:'accepted'}],structuredContent:{id:'receipt'}}:{resultType:'input_required',requestState:'durable-operation'};
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const request=JSON.parse(options.body);const result=request.method==='server/discover'?{supportedVersions:['2026-07-28']}:request.method==='tools/list'?{tools:descriptors}:(calls.push(request.params),await response(request.params));return Response.json({jsonrpc:'2.0',id:request.id,result})}));
 remote=new RemoteTools({getClient:async()=>({_apiKey:'synthetic',_baseUrl:'https://example.test',whoami:async()=>({authSubtype:authority})}),getIdentity:async()=>({id:'identity-test'})} as any,()=>({}),home);
 remote.begin(context);remote.register({registerTool:(factory:any)=>native.push(...factory({sessionKey:context.sessionKey,sessionId:context.sessionId}))});
});
afterEach(async()=>{vi.unstubAllGlobals();await rm(home,{recursive:true,force:true})});
const call=()=>native.find(tool=>tool.name==='inkbox_remote_call');
const discover=()=>native.find(tool=>tool.name==='inkbox_remote_tools');
async function approve(id:string,args:any,decision='allow-once'){
 const result=await remote.before({toolName:'inkbox_remote_call',toolCallId:id,params:args},context);
 expect(result.requireApproval.allowedDecisions).toEqual(['allow-once','deny']);result.requireApproval.onResolution(decision);
}
describe('remote native tools',()=>{
 it('retains full schemas and structured results; server annotations never grant approval',async()=>{
  const listed=JSON.parse((await discover().execute('list',{})).content[0].text);expect(listed.tools).toEqual(descriptors);
  const args={name:'example_write',arguments:{text:'hello'}};
  await expect(call().execute('a',args)).rejects.toThrow('not been approved');expect(calls).toEqual([]);
  await approve('a',args);expect((await call().execute('a',args)).structuredContent).toEqual({id:'receipt'});expect(calls).toHaveLength(2);
 });
 it('denies, binds approval to arguments and validates complete schemas',async()=>{
  const args={name:'example_write',arguments:{text:'hello'}};await approve('a',args,'deny');
  await expect(call().execute('a',args)).rejects.toThrow('not been approved');
  await approve('b',args);await expect(call().execute('b',{...args,arguments:{text:'changed'}})).rejects.toThrow('not been approved');
  const invalid={name:'example_write',arguments:{text:'x'}};await approve('c',invalid);await expect(call().execute('c',invalid)).rejects.toThrow('remote schema');expect(calls).toEqual([]);
 });
 it('refreshes at turn boundaries without changing the active catalog',async()=>{
  expect(JSON.parse((await discover().execute('list',{})).content[0].text).tools[0].description).toBe('first');
  descriptors[0].description='changed';expect(JSON.parse((await discover().execute('list',{})).content[0].text).tools[0].description).toBe('first');
  context={...context,runId:'run-2'};remote.begin(context);expect(JSON.parse((await discover().execute('list',{})).content[0].text).tools[0].description).toBe('changed');
  descriptors=[];context={...context,runId:'run-3'};remote.begin(context);expect(JSON.parse((await discover().execute('list',{})).content[0].text).tools).toEqual([]);
 });
 it('reopens an uncertain operation and never merges separate identical calls',async()=>{
  const args={name:'example_write',arguments:{text:'hello'}};await approve('a',args);
  response=params=>{if(params.requestState)throw new Error('lost response');return {resultType:'input_required',requestState:'durable'}};
  await expect(call().execute('a',args)).rejects.toThrow('unavailable');
  remote.end(context);context={...context,runId:'run-2'};remote.begin(context);await approve('a',args);
  response=()=>({content:[],structuredContent:{id:'accepted'}});await call().execute('a',args);expect(calls.map(p=>p.requestState)).toEqual([undefined,'durable','durable']);
  await approve('b',args);await call().execute('b',args);expect(calls.at(-1).requestState).toBeUndefined();
 });
 it('revalidates admitted source between preparation and write',async()=>{
  remote.end(context);const source={identityId:'identity-test',conversationId:'conversation',author:'sender',closed:false,runId:context.runId,nativeSessionId:context.sessionId,validate:vi.fn(async()=>{}),beforeSend:vi.fn(),afterSend:vi.fn()};
  const release=bindNativeSource(context.sessionKey,source);remote.begin(context);
  try{const args={name:'example_write',arguments:{text:'hello'}};expect(await remote.before({toolName:'inkbox_remote_call',toolCallId:'a',params:args},context)).toBeUndefined();
   response=()=>{source.closed=true;return {resultType:'input_required',requestState:'prepared'}};
   await expect(call().execute('a',args)).rejects.toThrow('no longer active');expect(calls).toHaveLength(1);
  }finally{release()}
 });
 it('browser Ask overrides admitted-source automation and applies to native local tools',async()=>{
  const release=bindManagedToolPolicy(context.sessionKey,{mode:'ask',runId:context.runId,validate:async()=>{}});
  try{const result=await remote.before({toolName:'exec',toolCallId:'shell-1',params:{command:'true'}},context);expect(result.requireApproval.allowedDecisions).toEqual(['allow-once','deny']);}finally{release()}
 });
 it('retains legacy credential tools but does not fall back after unknown authority',async()=>{
  const local=vi.fn(async()=>({content:[]}));let wrapped:any;
  remote.wrap({registerTool:(factory:any)=>{wrapped=factory({sessionKey:context.sessionKey,sessionId:context.sessionId})}}).registerTool({name:'inkbox_get_contact',execute:local});
  authority='api_key.admin_scoped';await wrapped.execute('a',{contactId:'contact'});expect(local).toHaveBeenCalledOnce();
  remote.end(context);context={...context,runId:'run-2'};remote.begin(context);authority='unknown';
  await expect(wrapped.execute('b',{contactId:'contact'})).rejects.toThrow('claimed identity');expect(local).toHaveBeenCalledOnce();
 });
});

it('managed browser approval is awaited and revalidated inside the native hook',async()=>{
 let finish:(value:boolean)=>void=()=>{};let valid=true;
 const release=bindManagedToolPolicy(context.sessionKey,{mode:'ask',runId:context.runId,validate:async()=>{if(!valid)throw new Error('Cancelled')},ask:()=>new Promise(resolve=>{finish=resolve})});
 try{const pending=remote.before({toolName:'exec',toolCallId:'native-shell',params:{command:'true'}},context);await new Promise(resolve=>setTimeout(resolve,5));valid=false;finish(true);expect(await pending).toMatchObject({block:true,blockReason:'Cancelled'});}finally{release()}
});

it('binds the final SMS destination and suppresses only an accepted terminal receipt',async()=>{
 const {terminalReceipt}=await import('../src/terminal-reply.js');
 const runtime={getClient:async()=>({_apiKey:'synthetic',_baseUrl:'https://example.test'}),getIdentity:async()=>({id:'identity-test'})} as any;
 const source={replyChannel:'sms' as const,replySourceId:'incoming-message',replyRoute:'conversation',identityId:'identity-test',conversationId:'conversation',author:'+15550000002',closed:false,runId:context.runId,nativeSessionId:context.sessionId,validate:async()=>{},beforeSend:vi.fn(async()=>{}),afterSend:vi.fn(async()=>{})};
 const release=bindNativeSource(context.sessionKey,source);remote.end(context);remote.begin(context);
 descriptors=[{name:'inkbox_text_send',inputSchema:{type:'object',properties:{to:{type:'array',items:{type:'string'}},text:{type:'string'},idempotency_key:{type:'string'}},required:['to','text','idempotency_key']}}];
 response=params=>params.requestState?{content:[],structuredContent:{message_id:'accepted-sms',recipients:['+15550000002'],delivery_status:'queued'}}:{resultType:'input_required',requestState:'prepared'};
 try{
  const args={text:'Final answer'};expect(await remote.before({toolName:'inkbox_reply_current',toolCallId:'reply-1',params:args},context)).toBeUndefined();
  const reply=native.find(tool=>tool.name==='inkbox_reply_current');await reply.execute('reply-1',args);
  expect(calls[0].arguments.to).toEqual(['+15550000002']);expect(await terminalReceipt(runtime,source,home)).toBe('accepted-sms');expect(source.afterSend).toHaveBeenCalledWith(expect.any(String),'accepted-sms','Final answer');
  await reply.execute('reply-1',args);expect(calls).toHaveLength(2);
 }finally{release()}
});
it.each([
 {message_id:'blocked',recipients:['+15550000002'],delivery_status:'blocked'},
 {message_id:'wrong-target',recipients:['+15550000003'],delivery_status:'sent'},
 {recipients:['+15550000002'],delivery_status:'sent'},
])('withholds automatic delivery after an unconfirmed terminal result %j',async receipt=>{
 const {terminalReceipt}=await import('../src/terminal-reply.js');
 const runtime={getClient:async()=>({_apiKey:'synthetic',_baseUrl:'https://example.test'}),getIdentity:async()=>({id:'identity-test'})} as any;
 const source={replyChannel:'sms' as const,replySourceId:'incoming-message',replyRoute:'conversation',identityId:'identity-test',conversationId:'conversation',author:'+15550000002',closed:false,runId:context.runId,nativeSessionId:context.sessionId,validate:async()=>{},beforeSend:async()=>{},afterSend:async()=>{}};
 const release=bindNativeSource(context.sessionKey,source);remote.end(context);remote.begin(context);
 descriptors=[{name:'inkbox_text_send',inputSchema:{type:'object'}}];response=params=>params.requestState?{content:[],structuredContent:receipt}:{resultType:'input_required',requestState:'prepared'};
 try{const args={text:'Final answer'};await remote.before({toolName:'inkbox_reply_current',toolCallId:'reply',params:args},context);await expect(native.find(tool=>tool.name==='inkbox_reply_current').execute('reply',args)).rejects.toThrow('unconfirmed');await expect(terminalReceipt(runtime,source,home)).rejects.toThrow('withheld');}finally{release()}
});
it('serializes source ownership and cancels a queued source without replacing the active one',async()=>{
 const {acquireNativeSource,activeNativeSource}=await import('../src/native-source.js');
 const make=()=>({identityId:'identity-test',conversationId:'conversation',author:'sender',closed:false,validate:async()=>{},beforeSend:async()=>{},afterSend:async()=>{}});
 const first=make(),second=make();const release=await acquireNativeSource(context.sessionKey,first);const abort=new AbortController();
 const waiting=acquireNativeSource(context.sessionKey,second,abort.signal);expect(activeNativeSource(context.sessionKey)).toBe(first);abort.abort();await expect(waiting).rejects.toThrow();expect(activeNativeSource(context.sessionKey)).toBe(first);release();const next=await acquireNativeSource(context.sessionKey,second);expect(activeNativeSource(context.sessionKey)).toBe(second);next();
});

it('enforces configured email recipients against the canonical remote arguments',async()=>{
 remote.end(context);native=[];
 remote=new RemoteTools({getClient:async()=>({_apiKey:'synthetic',_baseUrl:'https://example.test',whoami:async()=>({authSubtype:authority})}),getIdentity:async()=>({id:'identity-test'})} as any,()=>({allowedRecipients:['allowed@example.test']}),home);
 remote.begin(context);remote.register({registerTool:(factory:any)=>native.push(...factory({sessionKey:context.sessionKey,sessionId:context.sessionId}))});
 descriptors=[{name:'inkbox_email_send',inputSchema:{type:'object'}}];
 const allowed={name:'inkbox_email_send',arguments:{recipients:{to:['allowed@example.test'],cc:[],bcc:[]},subject:'Hello',body:'Message'}};
 await approve('allowed',allowed);await call().execute('allowed',allowed);expect(calls).toHaveLength(2);
 const blocked={...allowed,arguments:{...allowed.arguments,recipients:{to:['allowed@example.test'],cc:['blocked@example.test'],bcc:[]}}};
 await approve('blocked',blocked);await expect(call().execute('blocked',blocked)).rejects.toThrow();expect(calls).toHaveLength(2);
});
it('applies managed Ask to legacy contact tools before local execution',async()=>{
 authority='api_key.admin_scoped';const ask=vi.fn(async()=>false);
 const release=bindManagedToolPolicy(context.sessionKey,{mode:'ask',runId:context.runId,validate:async()=>{},ask});
 try { expect(await remote.before({toolName:'inkbox_create_contact',toolCallId:'legacy',params:{name:'Test'}},context)).toMatchObject({block:true});expect(ask).toHaveBeenCalledOnce();expect(calls).toEqual([]); }
 finally {release()}
});
