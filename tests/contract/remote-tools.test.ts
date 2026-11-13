import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runBeforeToolCallHook, wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { RemoteTools } from "../../src/remote-tools.js";
import { bindNativeSource } from "../../src/native-source.js";

const require = createRequire(import.meta.url);
const dist = dirname(dirname(require.resolve("openclaw/plugin-sdk/agent-harness-runtime")));
async function hostFunction(name: string): Promise<any> {
 const file=readdirSync(dist).find(file=>/^hook-runner-global-.*\.(m?js)$/.test(file)&&readFileSync(join(dist,file),'utf8').includes(`function ${name}(`));
 if(!file)throw new Error(`Missing native ${name}`);
 const loaded=await import(pathToFileURL(join(dist,file)).href);return Object.values(loaded).find(value=>typeof value==='function'&&value.name===name);
}
afterEach(()=>vi.unstubAllGlobals());
it('uses the installed native hook runner for Ask and source-bound automatic calls',async()=>{
 const home=await mkdtemp(join(tmpdir(),'inkbox-native-remote-'));
 const context={sessionKey:'agent:main:synthetic',sessionId:'native-session',runId:'native-run',agentId:'main'};
 const tools=[{name:'example_write',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}}];
 const writes:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const request=JSON.parse(options.body);const result=request.method==='server/discover'?{supportedVersions:['2026-07-28']}:request.method==='tools/list'?{tools}:(writes.push(request.params),request.params.requestState?{content:[{type:'text',text:'accepted'}],structuredContent:{receipt:'one'}}:{resultType:'input_required',requestState:'prepared'});return Response.json({jsonrpc:'2.0',id:request.id,result})}));
 const remote=new RemoteTools({getClient:async()=>({_apiKey:'synthetic',_baseUrl:'https://example.test',whoami:async()=>({authSubtype:'api_key.agent_scoped.claimed'})}),getIdentity:async()=>({id:'identity-test'})} as any,()=>({}),home);
 const initialize=await hostFunction('initializeGlobalHookRunner');const reset=await hostFunction('resetGlobalHookRunner');
 initialize({hooks:[],plugins:[],trustedToolPolicies:[],typedHooks:[{pluginId:'inkbox',hookName:'before_tool_call',handler:(event:any,ctx:any)=>remote.before(event,ctx)}]});
 let close:(()=>void)|undefined;
 try{
  remote.begin(context);const args={name:'example_write',arguments:{text:'hello'}};
  const denied=await runBeforeToolCallHook({toolName:'inkbox_remote_call',params:args,ctx:context,toolCallId:'denied',approvalMode:'report'} as any);
  expect(denied).toMatchObject({blocked:true,deniedReason:'plugin-approval'});expect(writes).toEqual([]);
  remote.end(context);close=bindNativeSource(context.sessionKey,{identityId:'identity-test',conversationId:'conversation-test',author:'sender',closed:false,runId:context.runId,nativeSessionId:context.sessionId,validate:async()=>{},beforeSend:async()=>{},afterSend:async()=>{}});remote.begin(context);
  let registered:any[]=[];remote.register({registerTool:(factory:any)=>{registered=factory({sessionKey:context.sessionKey,sessionId:context.sessionId})}});
  const native=wrapToolWithBeforeToolCallHook(registered.find(tool=>tool.name==='inkbox_remote_call'),context);
  const result:any=await native.execute('accepted-native-call',args);
  expect(result.structuredContent).toEqual({receipt:'one'});expect(writes).toHaveLength(2);
  close();close=undefined;expect(await native.execute('late-call',args)).toMatchObject({details:{status:'blocked'}});expect(writes).toHaveLength(2);
 }finally{close?.();remote.end(context);reset();await rm(home,{recursive:true,force:true})}
},30000);
