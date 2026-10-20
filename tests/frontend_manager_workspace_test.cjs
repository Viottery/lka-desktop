'use strict';
// Controller initialization contract: no services or model calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app/web/pet/chat.js'),'utf8');
const start=source.indexOf('  async function ensureManagerExecutionWorkspace(');
const end=source.indexOf('\n  function quickAssistantErrorMessage',start);
const manager=()=>({session:{session_id:'manager'},controller:{revision:3,default_execution_workspace:null}});
const calls=[];
const context={safeText:v=>String(v??''),defaultsReady:Promise.resolve(),runSettings:{workspaceParent:''},
 fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({path:'D:/Documents/Local Knowledge Agent/Workspaces',platform:'windows'})};},
 quickAssistantRequest:async(path,method,body)=>{calls.push({path,method,body});return {session:{session_id:'manager'},controller:{revision:4,default_execution_workspace:body.default_execution_workspace}};}};
vm.createContext(context);vm.runInContext(source.slice(start,end),context);
(async()=>{
 const result=await context.ensureManagerExecutionWorkspace(manager());
 assert.equal(result.controller.default_execution_workspace.platform,'windows');
 assert.equal(calls.length,2);assert.equal(calls[0].url,'/pet/session-workspace-parent');
 assert.equal(calls[1].body.expected_revision,3);
 assert.equal(calls[1].path,'/managers/manager');
 assert(!('backend_path' in calls[1].body.default_execution_workspace),'backend derives execution path');
 calls.length=0;await context.ensureManagerExecutionWorkspace(result);assert.equal(calls.length,0,'existing user configuration is preserved');
 context.quickAssistantRequest=async(path,method)=>{calls.push({method});if(method==='PATCH'){const e=new Error('conflict');e.status=409;throw e;}return result;};
 assert.equal(await context.ensureManagerExecutionWorkspace(manager()),result,'CAS conflict accepts latest configured directory');
 assert.deepEqual(calls.slice(-2).map(c=>c.method),['PATCH',undefined],'conflict never repeats mutation');
 context.quickAssistantRequest=async(path,method)=>{if(method==='PATCH'){const e=new Error('conflict');e.status=409;throw e;}return manager();};
 await assert.rejects(context.ensureManagerExecutionWorkspace(manager()),/默认任务目录同步失败/);
 context.quickAssistantRequest=async()=>manager();
 await assert.rejects(context.ensureManagerExecutionWorkspace(manager()),/后端未确认默认目录已保存/);
 context.fetch=async()=>({ok:false,json:async()=>({detail:'parent_unavailable'})});
 await assert.rejects(context.ensureManagerExecutionWorkspace(manager()),/默认任务目录准备失败.*parent_unavailable/);
 console.log('PASS manager workspace: desktop parent resolution, separate controller field, CAS, existing settings, conflict reload without retry, visible failure contracts');
})().catch(e=>{console.error(e);process.exitCode=1;});
