import { mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decideRoute, classifyTask, admitAttempt, childFloorFor, QUOTA_MAX_AGE_MS, type QuotaSnapshot } from '../core/policy';
import { contextTools } from './context-tools';
import { inspectQuotas } from '../core/quota';
import { getPromotion } from '../core/promotion';
import { inspectMeridian, withMeridianProfile } from '../core/meridian';
import { BudgetLedger, estimateUpperBoundUsd } from '../core/budget';
import { streamSimple, registerCustomApi, unregisterCustomApis, resolveModelServiceTier } from '@oh-my-pi/pi-ai';
import { installGuardedOpenRouter, guardOpenRouterModel, GUARDED_OPENROUTER_MARKER } from '../core/guarded-openrouter';
import { randomUUID, randomBytes } from 'node:crypto';
import { buildSessionContext, AgentRegistry, MAIN_AGENT_ID } from '@oh-my-pi/pi-coding-agent';
import { writeFanout, readSiblings, readInFlightWindows, removeFanout } from '../core/fanout';
import { installNineRouter as installNineRouterBundle } from './ninerouter';
import type { NineRouterController } from './ninerouter-types';
import { gatewayQuota, readNineRouterUsage, refreshNineRouterUsage, readPasswordFromOp, NINE_ROUTER_REFRESH_THROTTLE_MS } from '../core/ninerouter-usage';
import { installProviderDiagnostics, unsupportedModel } from './diagnostics';
import { buildRoutingContext, assessmentCacheKey, JEV_SCHEMA_VERSION, JEV_QUESTION_SET_VERSION } from '../core/routing-context';
import { AssessmentCache, cacheKeyFor } from '../core/assessment-cache';
import { createJevClient, JEVS_CLASSIFIER_MODEL, JEV_INPUT_USD_PER_MTOK } from '../core/jev-client';
import { advanceEpisode, advanceDecisionEpoch, type TaskEpisode } from '../core/episode';
import { resolveClassification, type RouteTier, type RoutePhase, type SemanticAssessment, type SemanticMode } from '../core/policy';
import { showRoster } from './roster-ui';
import { PROBE_FIXTURE_VERSION } from '../core/roster-probe';
// The generated bundle is emitted untyped; bind it to the contract the router uses.
const installNineRouter=installNineRouterBundle as (pi:unknown,options:{root:string;nativeStreamSimple:unknown;log:(event:string,data?:unknown)=>void})=>NineRouterController;

const VERSION='1.3.0';
const REFS=['openai-codex/gpt-6-astra','openai-codex/gpt-6-sol','openai-codex/gpt-6-luna','anthropic/claude-fable-5-1','anthropic/claude-sonnet-5','anthropic/claude-opus-5-5','opencode-go/deepseek-v4.1-flash','opencode-go/glm-5.3-flash'];
const BACKUPS=['openrouter/openai/gpt-6-astra'];
/** After three consecutive classifier transport failures, stop calling it for this long. */
const CLASSIFIER_BACKOFF_MS=120_000;
const ref=(model:any)=>model ? `${model.provider}/${model.id}` : undefined;
const parse=(file:string,fallback:any)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return fallback;}};
/**
 * One effective Go qualification from stored evidence. A goQualifications
 * record must be about this wire model (or its 9router-prefixed ref), the
 * current transport and fixture, and must have passed the tool round trip.
 * A goValidated entry with no record counts only under goLegacyValidated.
 */
export function goValidation(cfg:any,goModelId:string,modelRef:string):{tools:boolean;vision:boolean;reasoning:boolean}{
  const listed=cfg.goValidated?.includes(goModelId)??false;
  const vision=cfg.goVisionValidated?.includes(goModelId)??false;
  const record=cfg.goQualifications?.[goModelId];
  if(!record){const legacy=listed&&cfg.goLegacyValidated===true;return {tools:legacy,vision:vision&&legacy,reasoning:legacy};}
  const wire=modelRef.startsWith('9router/')?modelRef.slice('9router/'.length):modelRef;
  const sameModel=record.model===wire||`9router/${record.model}`===modelRef||record.model===goModelId;
  const current=sameModel&&record.transport==='openai-chat-completions'&&record.fixtureVersion===PROBE_FIXTURE_VERSION;
  const tools=listed&&current&&record.toolRoundTrip===true;
  return {tools,vision:vision&&current,reasoning:listed&&current};
}
/**
 * Readers for the fields routing needs off a session message. OMP's message
 * union does not expose them on every variant, and assistant text lives in
 * content blocks; routing and mining must read them the same way.
 */
const messageText=(message:unknown):string=>{
  if(!message||typeof message!=='object')return '';
  const record=message as {text?:unknown;content?:unknown};
  if(typeof record.text==='string')return record.text;
  if(typeof record.content==='string')return record.content;
  if(Array.isArray(record.content))return record.content.filter((c:any)=>c?.type==='text').map((c:any)=>String(c.text??'')).join('\n');
  return '';
};
const messageStopReason=(message:unknown):string|undefined=>{
  const value=(message as {stopReason?:unknown}|undefined)?.stopReason;
  return typeof value==='string'?value:undefined;
};
const messageToolCalls=(message:unknown):number|undefined=>{
  const content=(message as {content?:unknown}|undefined)?.content;
  return Array.isArray(content)?content.filter((c:any)=>c?.type==='toolCall'||c?.type==='tool_use').length:undefined;
};
const textLength=(value:any):number=>{
  if(typeof value==='string')return value.length;
  if(!value||typeof value!=='object')return 0;
  if(value.type==='image')return 8000;
  return Array.isArray(value)?value.reduce((sum,v)=>sum+textLength(v),0):Object.entries(value).reduce((sum,[k,v])=>sum+(k==='data'||k==='signature'?0:textLength(v)),0);
};
const hasImage=(v:any):boolean=>!!v&&typeof v==='object'&&(v.type==='image'||(Array.isArray(v)?v.some(hasImage):Object.values(v).some(hasImage)));

export default function personalRouter(pi:any) {
  const root=process.env.OMP_PERSONAL_ROUTER_HOME ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.omp','agent'),'personal-router');
  // Cache-key HMAC secret: env override, else a random 32-byte key generated
  // once and stored 0600. A path string is not a secret.
  const hmacKeyFile=join(root,'hmac.key');
  const hmacKey=():string=>{
    if(process.env.OMP_ROUTER_HMAC_KEY)return process.env.OMP_ROUTER_HMAC_KEY;
    try{const existing=readFileSync(hmacKeyFile,'utf8').trim();if(existing.length>=32)return existing;}catch{}
    const generated=randomBytes(32).toString('hex');
    writeFileSync(hmacKeyFile,generated,{mode:0o600});
    return generated;
  };
  mkdirSync(root,{recursive:true,mode:0o700});
  const settingsFile=join(root,'settings.json');
  let ctxCurrent:any, state:any={}, child=false, lastActual:string|undefined, lastStatus:any, lastQuota:any, blocked=false;
  // The concrete model the virtual `router/auto` entry delegates to. Set only
  // by a completed routing decision; the stream refuses without it.
  let route:{target:any;effort?:string}|undefined;
  let ledger:BudgetLedger|undefined, reservation:any;
  let nineRouter:NineRouterController;
  let gatewayUsage:any;
  let usageRefreshAt=0;
  let usageRefreshPromise:Promise<unknown>|undefined;
  let semanticMode:SemanticMode='off';
  let lastSemanticTrace:any;
  // Repeated classifier outages must not add the full deadline to every turn.
  let classifierFailures=0, classifierBackoffUntil=0;
  // Immutable snapshot of the last routing decision's inputs, so a provider
  // attempt can be re-admitted without reclassifying or refreshing quota.
  let lastAttemptContext:any;
  const settings=()=>parse(settingsFile,{goValidated:[],goVisionValidated:[],paidFallbackEnabled:false});
  const TYPESAFE_PROVIDER='typesafe';
  const ROUTER_PROVIDER='router', ROUTER_MODEL='router', ROUTER_API='personal-router-virtual';
  /** Auto = the user selected the router entry in /model. Any concrete model is manual. */
  const isAuto=(model:any)=>model?.provider===ROUTER_PROVIDER;
  /**
   * The user sees two states: auto and pin. Inside auto, Jev assists whenever a
   * key is present; otherwise rules run alone and the status line says so.
   * `assisted` is the only mode the user ever gets: it can clarify phase and
   * raise the floor, never lower it.
   *
   * `shadow` is a research mode. `calibrated` enables semantic DOWNGRADES,
   * which calibration on 2026-09-18 showed are not supported by evidence (see
   * SEMANTIC_GATES in policy.ts), so it additionally requires
   * `semanticRouter.acknowledgeUncalibratedDowngrades: true`. Without that
   * flag the mode is ignored and we stay on `assisted`; a stray config value
   * must not quietly start under-routing.
   */
  const semanticSettings=()=> {
    const cfg=settings().semanticRouter;
    const override=cfg?.mode;
    let developerMode=(['off','shadow','calibrated'] as const).includes(override)?override as SemanticMode:undefined;
    if(developerMode==='calibrated'&&cfg?.acknowledgeUncalibratedDowngrades!==true)developerMode=undefined;
    return { mode:developerMode??('assisted' as SemanticMode), overridden:developerMode!==undefined };
  };
  // The TypeSafe key lives in omp's own credential store, the same place every
  // other provider key lives, so it survives shells and restarts. authStorage
  // resolves stored key first, then TYPESAFE_API_KEY from the environment.
  // Never read from or written to settings.json.
  const typesafeKey=async():Promise<string|undefined>=>{
    try{return await ctxCurrent?.modelRegistry?.authStorage?.getApiKey(TYPESAFE_PROVIDER)??process.env.TYPESAFE_API_KEY;}
    catch{return process.env.TYPESAFE_API_KEY;}
  };
  /**
   * 1Password item holding the TypeSafe key (a LOGIN item: the key is in
   * `password`). Vault layout is a deployment fact, so it is overridable.
   */
  const TYPESAFE_OP_REF=process.env.OMP_ROUTER_TYPESAFE_OP_REF??'op://Personal/AgentKit - Typesafe/password';
  // `/route key` is the rotation path, so it always reads the vault itself and
  // refreshes the keychain cache; it never serves a stale cached key.
  const readTypesafeKeyFromOp=()=>readPasswordFromOp(TYPESAFE_OP_REF,AbortSignal.timeout(60_000),{forceVaultRead:true});
  const budget=()=>ledger??=new BudgetLedger(join(root,'budget.sqlite'),{dailyCapUsd:settings().dailyCashCapUsd??10,monthlyCapUsd:settings().monthlyCashCapUsd??30});
  const assessmentCache=new AssessmentCache();
  const jev=createJevClient({
    // Measured against api.typesafe.ai: warm calls settle at ~290-360ms, but the
    // first call of a fresh process pays TLS + connection setup and lands at
    // ~790-840ms. At 750ms every session's first routing decision aborted and
    // fell back to rules. This is a ceiling, not a delay: warm calls still
    // return in ~300ms, so raising it only stops discarding the cold answer.
    deadlineMs:1500,
    admit:(estimateUsd)=>{
      const id=`classifier-${randomUUID()}`;
      const result=budget().reserve(id,estimateUsd,Date.now(),{purpose:'classifier',subcaps:{dailyCapUsd:0.10,monthlyCapUsd:1.00}});
      if(!result.ok)return {ok:false as const,reason:result.reason};
      return {
        ok:true as const,
        dispatched:()=>{budget().markDispatched(id);},
        settle:(actualUsd:number)=>{try{const s=budget().settle(id,actualUsd);log('budget-settled',{requestId:id,purpose:'classifier',actualUsd,overEstimateUsd:s.overEstimateUsd});}catch(error:any){log('budget-settle-error',{requestId:id,errorType:error?.name??'Error'});}},
      };
    },
    inputUsdPerMillion:JEV_INPUT_USD_PER_MTOK,
    // Resolved per call, never snapshotted: the key can be stored after load.
    apiKey:typesafeKey,
  });
  const priceCeiling=(m:any)=>{
    const configured=settings().openrouterPriceCeilings?.[m.id];
    if(configured)return configured;
    const input=Math.max(m.cost?.input??NaN,m.cost?.cacheRead??0,m.cost?.cacheWrite??0)*4;
    return {input,output:(m.cost?.output??NaN)*4,cacheRead:input,cacheWrite:input};
  };
  const guard=installGuardedOpenRouter({ledger:budget,nativeStreamSimple:streamSimple,registerCustomApi,unregisterCustomApis,ratesFor:priceCeiling,maxOutputTokens:32768,onEvent:log,onBlocked:(reason)=>{blocked=true;ctxCurrent?.abort();notify(`OpenRouter: chamada bloqueada (${reason}).`,'warning');}});
  function releaseUndispatched(){if(reservation&&!reservation.dispatched){budget().releaseBeforeDispatch(reservation.id);reservation=undefined;}}
  async function reconcile(ctx:any) {
    const pending=budget().pendingGenerations();if(!pending.length)return;
    const apiKey=await ctx.modelRegistry.authStorage.getApiKey('openrouter');if(!apiKey)return;
    await Promise.all(pending.map(async p=>{
      try{
        const r=await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(p.generationId)}`,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(4000)});
        if(!r.ok)return;const body:any=await r.json();const cost=body.data?.total_cost;
        if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)return;
        const settled=budget().settle(p.requestId,cost);log('budget-settled',{requestId:p.requestId,actualUsd:cost,overEstimateUsd:settled.overEstimateUsd});
      }catch{}
    }));
  }
  function log(event:string,data:any={}) {
    appendFileSync(join(root,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),version:VERSION,event,sessionId:ctxCurrent?.sessionManager.getSessionId(),child,...data})+'\n',{mode:0o600});
  }
  function save() { pi.appendEntry('personal-router-state',state); }
  function notify(text:string,level='info') { ctxCurrent?.ui.notify(text,level); }
  const isGateway=(model:any):boolean=>model?.provider==='9router'||model?.gateway===true||model?.ref?.startsWith('9router/');
  const canonical=(model:any):string|undefined=>{
    if(!model)return undefined;
    if(typeof model==='string')return model.startsWith('9router/')?(nineRouter?.canonicalRef(model)??model):model;
    if(typeof model.canonicalRef==='string'&&model.canonicalRef)return model.canonicalRef;
    const modelRef=ref(model);
    return modelRef&&isGateway(model)?(nineRouter?.canonicalRef(modelRef)??modelRef):modelRef;
  };
  function readGatewayUsage(){
    if(!nineRouter?.enabled)return gatewayUsage;
    try{gatewayUsage=readNineRouterUsage(root)??gatewayUsage;}catch(error:any){log('ninerouter-usage-read-error',{errorType:error?.name??'Error'});}
    return gatewayUsage;
  }
  function usageSummary(cache:any){
    if(!cache)return undefined;
    const ageSeconds=Math.max(0,(Date.now()-cache.fetchedAt)/1000);
    const available=cache.fetchedAt>0&&ageSeconds*1000<=QUOTA_MAX_AGE_MS&&!cache.errors?.auth&&!cache.errors?.stats;
    return {scope:'instance',period:'today',costBasis:'nominal-estimate',fetchedAt:cache.fetchedAt,ageSeconds,available,total:available?cache.total:undefined,providers:Object.keys(cache.providers??{}),errors:cache.errors};
  }
  function refreshGatewayUsage(now=Date.now()){
    if(!nineRouter?.enabled||usageRefreshPromise||now-usageRefreshAt<NINE_ROUTER_REFRESH_THROTTLE_MS)return;
    usageRefreshAt=now;
    // 2500ms is the HTTP budget only; the secret read has its own timeout, so a
    // biometric cache miss no longer aborts the refresh mid-credential-fetch.
    usageRefreshPromise=Promise.resolve(refreshNineRouterUsage(root,{timeoutMs:2500})).then((cache:any)=>{gatewayUsage=cache;}).catch((error:any)=>{log('ninerouter-usage-refresh-error',{errorType:error?.name??'Error'});}).finally(()=>{usageRefreshPromise=undefined;});
  }
  function gatewayQuotaFor(model:any,cache:any):QuotaSnapshot|undefined{
    if(!isGateway(model))return undefined;
    const modelRef=ref(model);
    const description=modelRef?nineRouter?.describe(modelRef):undefined;
    const id=description?.canonicalRef??canonical(model)??model.id??modelRef;
    const unknown:QuotaSnapshot={observedAt:Date.now(),state:'unknown',windows:[]};
    try{return gatewayQuota(id,cache)??unknown;}catch(error:any){log('ninerouter-quota-error',{errorType:error?.name??'Error',model:ref(model)});return unknown;}
  }
  const fanoutDir=join(root,'fanout');
  function ownAgentId(ctx:any):string|undefined{
    try{
      const direct=typeof ctx?.getAgentId==='function'?ctx.getAgentId():undefined;
      if(direct)return direct;
      const sessionFile=ctx?.sessionManager?.getSessionFile?.();
      if(sessionFile){
        const match=AgentRegistry.global().list().find((a:any)=>a.sessionFile===sessionFile);
        if(match)return match.id;
      }
      if(!child)return MAIN_AGENT_ID;
    }catch{}
    return undefined;
  }
  function fanoutSiblings(ctx:any):{agentId?:string;parentId?:string;siblings:Array<{canonicalRef:string;count:number}>}{
    try{
      const agentId=ownAgentId(ctx);
      if(!agentId)return{siblings:[]};
      const parentId=AgentRegistry.global().get(agentId)?.parentId;
      const siblings=readSiblings(fanoutDir,agentId,parentId);
      return{agentId,parentId,siblings};
    }catch{return{siblings:[]};}
  }
  nineRouter=installNineRouter(pi,{root,nativeStreamSimple:streamSimple,log});
  // OMP's `/fast` keys off the model's provider family; `9router/*` and
  // `router/router` are custom apis with none, so the builtin refuses them.
  // Toggle the OpenAI family tier here; the transports apply it to OpenAI routes.
  // ponytail: OpenAI only. Gateway Claude rejects `speed: fast` without usage credits.
  pi.on('input',(event:any,ctx:any)=>{
    const match=/^\/fast(?:\s+(\S+))?$/i.exec(event.text?.trim()??'');
    const m=ctx.model??ctx.models.current();
    if(!match||!(isAuto(m)||(m?.provider===nineRouter.provider&&m.id.startsWith('cx/'))))return;
    const arg=(match[1]??'toggle').toLowerCase();
    const on=pi.getServiceTiers().openai==='priority';
    if(arg==='status'){ctx.ui.notify(`Fast mode is ${on?'on':'off'} (OpenAI routes).`);return{handled:true};}
    const next=arg==='on'?true:arg==='off'?false:arg==='toggle'?!on:undefined;
    if(next===undefined){ctx.ui.notify('Usage: /fast [on|off|status]','warning');return{handled:true};}
    pi.setServiceTier('openai',next?'priority':undefined);
    ctx.ui.notify(`Fast mode ${next?'enabled':'disabled'} (OpenAI routes).`);
    return{handled:true};
  });
  // The router is a model in the picker, not a mode. Selecting `router/auto`
  // routes; selecting any concrete model is manual, no command needed.
  // ponytail: contextWindow is a static ceiling; per-attempt admission checks the real route's window.
  pi.registerProvider(ROUTER_PROVIDER,{
    name:'Router',baseUrl:'https://router.invalid',apiKey:'personal-router-virtual',api:ROUTER_API,
    models:[{id:ROUTER_MODEL,name:'Router (auto)',reasoning:true,thinking:{efforts:['off','minimal','low','medium','high','xhigh','max']},input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:400_000,maxTokens:32768}],
    streamSimple:(model:any,context:any,options:any={})=>{
      if(model?.provider!==ROUTER_PROVIDER||!route){log('router-stream-refused',{model:ref(model),decided:!!route});throw new Error('router: no admitted route for this request');}
      const target=route.target;
      const opts={...options,apiKey:ctxCurrent.modelRegistry.resolver(target,ctxCurrent.sessionManager.getSessionId()),headers:undefined,fetch:undefined,maxInFlightRequests:{}};
      if(route.effort)opts.reasoning=route.effort;
      // Host resolved the tier against `router/router` (no family); re-resolve for the real target.
      opts.serviceTier=resolveModelServiceTier(pi.getServiceTiers(),target);
      return streamSimple(target,context,opts);
    },
  });
  const diagnostics=installProviderDiagnostics(pi,{log,notify,changed:status});
  // Source of the last automatic decision, always visible: a silent fallback
  // from jev to rules is exactly the kind of failure that hides.
  let lastSource:'jev'|'rules'|'override'|undefined;
  function status() {
    const auto=isAuto(ctxCurrent?.models?.current());
    const source=auto&&lastSource?` · ${lastSource}`:'';
    ctxCurrent?.ui.setStatus('personal-router',`route ${auto?'auto':'manual'}${source} · ${lastActual?.split('/').pop()??'ready'}${diagnostics.label?` · ${diagnostics.label}`:''}`);
  }
  function init(ctx:any) {
    ctxCurrent=ctx;
    const entries=ctx.sessionManager.getEntries();
    const nativeInit=entries.find((e:any)=>e.type==='session_init');
    child=!!nativeInit;
    state=[...ctx.sessionManager.getBranch()].reverse().find((e:any)=>e.type==='custom'&&e.customType==='personal-router-state')?.data??{};
    // A child inherits a floor from the parent's subagent role, not a user role.
    if(child&&!state.childFloor)state.childFloor=childFloorFor(nativeInit?.modelRole);
    lastActual=isAuto(ctx.model)?state.route:ref(ctx.model);
    readGatewayUsage();
    refreshGatewayUsage();
    status();
    log('loaded',{mode:ctx.mode,model:ref(ctx.model),route:state.route,childFloor:state.childFloor,gateway:nineRouter.enabled});
  }
  pi.on('session_start',(_e:any,ctx:any)=>init(ctx));
  pi.on('session_switch',(_e:any,ctx:any)=>init(ctx));
  // Compaction removes the evidence a decision leaned on, but not the purpose
  // of the work: keep the episode goal and open a fresh decision epoch.
  pi.on('session_compact',()=>{state.phase=undefined;state.episode=advanceDecisionEpoch(state.episode);state.handoffReady=true;save();});

  pi.on('before_agent_start',async(event:any,ctx:any)=>{
    ctxCurrent=ctx; blocked=false;
    const cfg=settings();
    // Manual: a concrete model in the picker. No classification, no spend; the
    // only intervention is the OpenRouter budget guard, which is transport safety.
    if(!isAuto(ctx.model)){if(ctx.model?.provider==='openrouter'&&!ctx.model[GUARDED_OPENROUTER_MARKER])await pi.setModel(guardOpenRouterModel(ctx.model,guard.apiId));route=undefined;lastAttemptContext=undefined;lastActual=ref(ctx.model);status();return;}
    try {
      readGatewayUsage();
      refreshGatewayUsage();
      // The route last decided for this session, never the picker entry itself.
      const current:string|undefined=state.route;
      const gatewayRefs=nineRouter.enabled?nineRouter.models
        .filter((m:any)=>typeof m.canonicalRef==='string'&&REFS.includes(m.canonicalRef))
        .map((m:any)=>`${m.provider}/${m.id}`):[];
      const ids=new Set([...REFS,...gatewayRefs,...(cfg.paidFallbackEnabled?BACKUPS:[]),...(current?[current]:[])]);
      const available=ctx.models.list();
      const models=[...ids].map(id=>available.find((m:any)=>ref(m)===id)).filter(Boolean);
      const gatewayCache=readGatewayUsage();
      const [quotas,promotion,meridian]=await Promise.all([inspectQuotas(ctx,models.filter((m:any)=>!isGateway(m)&&(cfg.claudeAccountOwner!=='meridian'||m.provider!=='anthropic')),AbortSignal.timeout(18000)),getPromotion(join(root,'promotion.json')),cfg.claudeAccountOwner==='meridian'?inspectMeridian(models.filter((m:any)=>!isGateway(m)),join(root,'meridian-usage.json'),state.claudeProfile,state.unavailableProfiles):Promise.resolve(new Map())]);
      for(const [id,quota] of meridian)quotas.set(id,quota);
      for(const m of models){
        if(!isGateway(m))continue;
        const modelRef=ref(m);
        const quota=gatewayQuotaFor(m,gatewayCache);
        if(modelRef&&quota)quotas.set(modelRef,{quota,accountOwner:'gateway'});
      }
      const branch=ctx.sessionManager.getBranch();
      const messages=buildSessionContext(branch).messages;
      const reportedTokens=ctx.getContextUsage()?.tokens;
      const registeredTools=pi.getAllTools();
      const activeTools=contextTools(registeredTools,pi.getActiveTools());
      const initialTokens=Math.ceil((textLength(event.systemPrompt)+textLength(activeTools))/3);
      const contextTokens=(Number.isFinite(reportedTokens)&&reportedTokens>0?Math.max(reportedTokens,initialTokens):initialTokens+Math.ceil(textLength(messages)/3)) + Math.ceil(textLength(event.prompt)/3) + (event.images?.length??0)*8000;
      const needsImages=!!event.images?.length||messages.some(hasImage);
      const routeModels=models.map((m:any)=>{
        const modelRef=ref(m)!;
        const gateway=isGateway(m);
        const description=gateway?nineRouter.describe(modelRef):undefined;
        const canonicalRef=description?.canonicalRef??canonical(m);
        // Either signal steers automatic allocation away; only the terminal
        // one refuses an attempt outright (see before_provider_request).
        const unavailableUntil=Math.max(state.unavailableModels?.[modelRef]??0,state.blockedModels?.[modelRef]??0);
        const goModelId=canonicalRef?.startsWith('opencode-go/')?canonicalRef.slice('opencode-go/'.length):undefined;
        return {
          ref:modelRef,
          canonicalRef,
          gateway,
          // A gateway route is authenticated by its registered provider/keyfile,
          // never by a native account or the host's OAuth store.
          authenticated:gateway?description?.allowed===true&&nineRouter.isAllowed(modelRef):true,
          contextWindow:gateway?(description?.contextWindow??m.contextWindow):m.contextWindow,
          supportsImages:gateway?(description?.supportsImages===true):(m.provider==='openrouter'?false:(m.input?.includes('image')??false)),
          supportsTools:gateway?(description?.supportsTools===true):true,
          supportedEfforts:m.thinking?.efforts??(gateway?(description?.reasoning?['medium','high']:['off']):(m.reasoning?['medium','high']:['off'])),
          // OpenCode Go validation belongs to the canonical model id, and only
          // counts when the stored qualification record is about THIS wire
          // model/transport/fixture. A bare goValidated entry without a record
          // is legacy evidence: accepted only when settings.goLegacyValidated
          // opts in, so an old boolean never silently stands as current proof.
          validated:goModelId?goValidation(cfg,goModelId,modelRef):undefined,
          quota:unavailableUntil>Date.now()?({observedAt:Date.now(),state:'depleted',windows:[{id:'runtime-model-backoff',exhausted:true,resetsAt:unavailableUntil}]} satisfies QuotaSnapshot):quotas.get(modelRef)?.quota,
          payg:gateway?(description?.payg===true):m.provider==='openrouter',
          qualityTiers:BACKUPS.includes(modelRef)?['mechanical','bounded','execution','complex','premium']:undefined,
          // Same conservative bound the ledger reserves against, so the price
          // the allocator compares is the price admission will demand.
          taskCostUsd:m.provider==='openrouter'&&Number.isFinite(m.maxTokens)?(()=>{
            try{return estimateUpperBoundUsd({inputTokens:contextTokens,maxOutputTokens:Math.min(m.maxTokens,32768),rates:priceCeiling(m)});}catch{return undefined;}
          })():undefined,
        };
      });
      const contract=child && /(?:scope|escopo)\s*:/i.test(event.prompt) && /(?:acceptance|aceite|criterios? de aceite)\s*:/i.test(event.prompt);
      const input:any={prompt:event.prompt,now:Date.now(),models:routeModels,current:current?{model:current,effort:pi.getThinkingLevel(),tier:state.tier,phase:state.phase}:undefined,previous:state.tier?{tier:state.tier,phase:state.phase}:undefined,childFloor:state.childFloor,contextTokens,outputMarginTokens:8192,needsImages,needsTools:pi.getActiveTools().length>0,boundary:state.providerFailed?'provider-failure':child&&!state.tier?'child':'user',task:{bounded:contract,acceptanceDefined:contract,failedQualityChecks:state.failedQualityChecks??0},promotion,paidFallback:{authorized:false,budgetReserved:false,allowedModels:[]},handoffReady:state.handoffReady??false};
      input.hasWorkContext=messages.some((message:any)=>message?.role==='assistant');
      if(child&&!state.tier)input.siblings=fanoutSiblings(ctx).siblings;
      // Work other live agents already committed against the same shared
      // allowances. Advisory: the provider's own accounting stays authoritative.
      try{const self=ownAgentId(ctx);input.inFlightByWindow=readInFlightWindows(fanoutDir,self??'');}catch{}
      // The rules baseline is THIS request's classification, computed once and
      // fed explicitly to the allocator. A prompt override ("use strong") is
      // the human's decision: it skips the classifier and never spends.
      const rulesClassification=classifyTask(input);
      // Semantic classification: mode-gated, budget-gated, fail-closed. Shadow
      // records but never changes the executed decision. Classification only
      // happens at a safe boundary (here), never per tool-loop continuation.
      // auto = rules + Jev-assisted when a key exists. No key => rules only.
      const semantic=semanticSettings();
      semanticMode=!rulesClassification.override&&await typesafeKey()?semantic.mode:'off';
      let semanticAssessment:SemanticAssessment|undefined;
      let semanticTrace:any;
      // A short follow-up ("yep", "you seem stuck") carries no task of its own.
      // Sending it as the goal made Jev answer `unknown` with high confidence —
      // correctly, since nothing in the state said what the work was. The
      // episode holds the latest substantive statement of the work; a new
      // substantive request replaces it and opens a fresh decision epoch, so an
      // unrelated later task is never assessed against the previous one.
      const episode:TaskEpisode=advanceEpisode(state.episode,String(event.prompt??''),Date.now(),randomUUID);
      state.episode=episode;
      // Structured difficulty signals from the session itself. Free text is
      // never added here; each field was measured against the outcome corpus.
      const lastAssistant=[...messages].reverse().find((msg:any)=>msg?.role==='assistant');
      const previousTurnErrored=messageStopReason(lastAssistant)==='error'||state.providerFailed===true;
      const previousTurnToolCalls=messageToolCalls(lastAssistant);
      const priorUserTurns=messages.filter((msg:any)=>msg?.role==='user').length;
      if(semanticMode!=='off'){
        const routingContext=buildRoutingContext({
          taskGoal:episode.goal,
          currentUserRequest:String(event.prompt??''),
          previousPhase:episode.phase??state.phase,
          scope:child?String(event.prompt??''):undefined,
          acceptanceCriteria:contract?[String(event.prompt??'')]:undefined,
          recentEvidence:messages.filter((msg:any)=>msg?.role==='assistant').slice(-2).map((msg:any)=>messageText(msg)).filter(Boolean),
          boundary:input.boundary==='child'?'child':input.boundary==='provider-failure'?'provider-failure':'user',
          hasImages:needsImages,
          toolsRequired:input.needsTools,
          confirmedQualityFailures:state.failedQualityChecks??0,
          previousTurnErrored,
          priorUserTurns,
          ...(previousTurnToolCalls!==undefined?{previousTurnToolCalls}:{}),
          upstreamTruncated:episode.goalTruncated===true,
        });
        const cacheKey=cacheKeyFor(routingContext,assessmentCacheKey({state:routingContext,schemaVersion:JEV_SCHEMA_VERSION,questionSetVersion:JEV_QUESTION_SET_VERSION,classifierModel:JEVS_CLASSIFIER_MODEL,hmacKey:hmacKey()}),JEV_QUESTION_SET_VERSION,JEVS_CLASSIFIER_MODEL,`${episode.id}:${episode.decisionEpoch}`);
        const cached=assessmentCache.get(cacheKey);
        if(cached){semanticAssessment=cached;}
        else if(Date.now()<classifierBackoffUntil){
          semanticTrace={result:'backoff',elapsedMs:0,mode:semanticMode,truncated:routingContext.truncated};
        }
        else{
          // Single-flight: concurrent identical assessments share one paid call.
          const result=await assessmentCache.dedupe(cacheKey,()=>jev.assess(routingContext,cacheKey)).catch(()=>({ok:false as const,reason:'transport' as const,elapsedMs:0}));
          semanticTrace={result:result.ok?'assessed':result.reason,elapsedMs:result.elapsedMs,mode:semanticMode,tierAssessed:result.ok?result.assessment.tier.selected:undefined,phaseAssessed:result.ok?result.assessment.phase.selected:undefined,resolvedModel:result.ok?result.assessment.resolvedModel:undefined,questionSetVersion:JEV_QUESTION_SET_VERSION,truncated:routingContext.truncated};
          if(result.ok){assessmentCache.put(cacheKey,result.assessment);semanticAssessment=result.assessment;classifierFailures=0;}
          else if(result.reason!=='budget'&&result.reason!=='no-key'&&result.reason!=='cancelled'){
            // Repeated outages must not add the full deadline to every turn.
            classifierFailures+=1;
            if(classifierFailures>=3){classifierBackoffUntil=Date.now()+CLASSIFIER_BACKOFF_MS;log('semantic-backoff',{untilMs:CLASSIFIER_BACKOFF_MS,failures:classifierFailures});}
          }
        }
      }
      if(rulesClassification.override)input.classification={tier:rulesClassification.tier,phase:rulesClassification.phase};
      let semanticResolution:{tier:RouteTier;phase:RoutePhase;source:'rules'|'semantic-assisted'|'semantic-downgrade';reason:string}|undefined;
      if(semanticMode!=='off'&&semanticAssessment){
        const resolveWith=(mode:SemanticMode)=>resolveClassification({assessment:semanticAssessment,rulesClassification,mode,floorTier:state.childFloor?.tier,floorLocksPhase:!!state.childFloor,failedQualityChecks:state.failedQualityChecks??0,previousTurnErrored,priorUserTurns});
        if(semanticMode==='shadow'){
          // Shadow: a real assisted proposal against the same frozen input, recorded only.
          const proposal=resolveWith('assisted');
          const proposed=decideRoute({...input,classification:{tier:proposal.tier,phase:proposal.phase}});
          semanticTrace={...(semanticTrace??{}),shadow:{baselineTier:rulesClassification.tier,baselinePhase:rulesClassification.phase,semanticTier:proposal.tier,semanticPhase:proposal.phase,proposedSource:proposal.source,proposedModel:proposed.model}};
        } else {
          semanticResolution=resolveWith(semanticMode);
          if(semanticResolution.source!=='rules')input.classification={tier:semanticResolution.tier,phase:semanticResolution.phase};
        }
      }
      if(semanticTrace)log('semantic-router',{...semanticTrace,cacheSize:assessmentCache.size});
      lastSemanticTrace=semanticTrace??lastSemanticTrace;
      // "jev" only when a usable assessment actually shaped the executed decision.
      lastSource=rulesClassification.override?'override':input.classification?'jev':'rules';
      let decision=decideRoute(input);
      if(decision.action==='unavailable'&&cfg.paidFallbackEnabled){
        await reconcile(ctx);
        // This second pass proposes a candidate only. No switch/dispatch occurs until atomic reservation succeeds below.
        const proposed=decideRoute({...input,paidFallback:{authorized:true,budgetReserved:true,allowedModels:BACKUPS}});
        if(proposed.model?.startsWith('openrouter/')){
          const m=models.find((m:any)=>ref(m)===proposed.model);
          if(m){
            const id=randomUUID(),estimate=estimateUpperBoundUsd({inputTokens:contextTokens,maxOutputTokens:Math.min(m.maxTokens,32768),rates:priceCeiling(m)});
            const hold=budget().reserve(id,estimate);
            if(hold.ok){reservation={id,model:proposed.model,estimate,dispatched:false};decision=proposed;}
            else log('budget-blocked',{reason:hold.reason,estimateUsd:estimate});
          }
        }
      }
      lastStatus=decision;
      lastAttemptContext=undefined;
      if(decision.action==='unavailable'||!decision.model){
        blocked=true;ctx.abort();log('blocked',{reason:decision.reason,rejected:decision.rejected,contextTokens});notify('Routing: nenhuma rota adequada disponível. /route mostra o motivo; escolha um modelo concreto em /model para seguir manualmente.','warning');return;
      }
      let target=models.find((m:any)=>ref(m)===decision.model);
      if(!target){releaseUndispatched();blocked=true;ctx.abort();log('blocked',{reason:'selected-model-unavailable',model:decision.model});notify('Routing: catálogo da rota selecionada indisponível.','warning');return;}
      const q=quotas.get(decision.model); lastQuota=q;
      if(target?.provider==='openrouter')target=guardOpenRouterModel(target,guard.apiId);
      if(target.provider==='anthropic'&&cfg.claudeAccountOwner==='meridian'){
        // Meridian routing needs a concrete profile; without one the account is unknown and we must not guess.
        if(!q?.profile){blocked=true;ctx.abort();log('blocked',{reason:'meridian-profile-unknown',model:decision.model});notify('Routing: perfil Meridian indisponível para a rota selecionada.','warning');return;}
        target=withMeridianProfile(target,q.profile,ctx.sessionManager.getSessionId());
      }
      if(target.provider!=='9router'&&q?.credentialId&&target.provider!=='opencode-go')ctx.modelRegistry.authStorage.pinSessionOAuthAccount(target.provider,ctx.sessionManager.getSessionId(),q.credentialId);
      // No model switch: the picker stays on router/auto and the stream
      // delegates to `route`. Auth is resolved per request by the registry.
      route={target};
      if(decision.effort)pi.setThinkingLevel(decision.effort);
      // State is committed only after the route was actually applied.
      state={...state,route:decision.model,tier:decision.tier,phase:decision.phase,episode:{...episode,phase:decision.phase},providerFailed:false,handoffReady:false,...(q?.profile?{claudeProfile:q.profile}:{})};
      // Frozen DECISION (route identity, committed tier, capability snapshots).
      // Execution facts (context size, quota, clock) are rebuilt per attempt.
      lastAttemptContext={models:routeModels,model:decision.model,tier:decision.tier,contextTokens,outputMarginTokens:input.outputMarginTokens,needsImages,needsTools:input.needsTools,quotaMaxAgeMs:input.quotaMaxAgeMs,episodeId:episode.id};
      lastActual=decision.model;
      save();status();
      try{
        const agentId=ownAgentId(ctx);
        if(agentId){
          const ownCanonical=routeModels.find((m:any)=>m.ref===lastActual)?.canonicalRef??canonical(lastActual);
          const childrenMap:Record<string,string>={};
          for(const a of AgentRegistry.global().list()){
            if(a.parentId!==agentId||a.status!=='running'||a.id===agentId)continue;
            const childCanonical=a.session?canonical(a.session.model):undefined;
            if(childCanonical)childrenMap[a.id]=childCanonical;
          }
          // Shared windows of the selected route, so siblings can debit them.
          const ownWindows=[...new Set((quotas.get(decision.model)?.quota?.windows??[]).map((w:any)=>w.sharedKey).filter((k:any):k is string=>typeof k==='string'&&!!k))];
          writeFanout(fanoutDir,agentId,ownCanonical??lastActual,childrenMap,ownWindows);
          const siblingInfo=fanoutSiblings(ctx);
          log('fanout',{agentId,parentId:siblingInfo.parentId,siblings:siblingInfo.siblings});
        }
      }catch{}
      const active=target.provider==='9router'?undefined:ctx.modelRegistry.authStorage.listOAuthAccounts(target.provider,ctx.sessionManager.getSessionId()).find((a:any)=>a.active);
      const requestedCanonicalModel=routeModels.find((m:any)=>m.ref===decision.model)?.canonicalRef??decision.model;
      const actualCanonicalModel=routeModels.find((m:any)=>m.ref===lastActual)?.canonicalRef??canonical(lastActual);
      log('decision',{requestedModel:decision.model,requestedWireModel:decision.model,requestedCanonicalModel,actualModel:lastActual,actualWireModel:lastActual,actualCanonicalModel,effort:pi.getThinkingLevel(),reason:decision.reason,tier:decision.tier,phase:decision.phase,contextTokens,needsImages,preferredCredentialId:target.provider==='9router'?undefined:q?.credentialId,actualCredentialId:target.provider==='9router'?undefined:q?.accountOwner==='meridian'?undefined:active?.credentialId,preferredProfile:q?.profile,accountOwner:target.provider==='9router'?'gateway':q?.accountOwner??'omp-native',quota:q?.quota,promotion:{active:promotion.active,confirmedAt:promotion.confirmedAt},rejected:decision.rejected});
    }catch(error:any){
      releaseUndispatched();blocked=true;ctx.abort();log('router-error',{errorType:error?.name??'Error'});notify('Routing: falha de verificação. A chamada foi interrompida; escolha um modelo concreto em /model para seguir manualmente.','error');
    }
  });

  /**
   * Current facts for one attempt: latest context size and gateway usage,
   * never the first snapshot. A transient runtime backoff is deliberately NOT
   * folded in here: it steers the next routing decision, but refusing the
   * attempt on it would strand a session whose only route just blipped.
   */
  function attemptFacts(ctx:any,record:any,modelRef:string){
    const base=record.models.find((entry:any)=>entry.ref===modelRef);
    if(!base)return undefined;
    const now=Date.now();
    const catalog=ctx.models.list().find((m:any)=>ref(m)===modelRef);
    const gatewayQuota=catalog&&isGateway(catalog)?gatewayQuotaFor(catalog,readGatewayUsage()):undefined;
    const quota=gatewayQuota??base.quota;
    const reported=ctx.getContextUsage?.()?.tokens;
    const contextTokens=Number.isFinite(reported)&&reported>0?Math.max(reported,record.contextTokens):record.contextTokens;
    return {model:{...base,quota},input:{prompt:'',now,models:record.models,contextTokens,outputMarginTokens:record.outputMarginTokens,needsImages:record.needsImages,needsTools:record.needsTools,quotaMaxAgeMs:record.quotaMaxAgeMs,current:{model:record.model,tier:record.tier}}};
  }
  pi.on('before_provider_request',(_event:any,ctx:any)=>{
    const picked=ctx.model??ctx.models.current();
    // Every attempt, including tool-loop continuations, is checked against the
    // route it is actually about to use. Classification is NOT redone here: a
    // continuation must not pay for an assessment or change models mid-loop.
    // Under router/auto the attempt runs on the delegate; a concrete pick is
    // manual and still checked against terminal blocks the router knows.
    const auto=isAuto(picked);
    const m=auto?route?.target:picked;
    const modelRef=ref(m);
    if(modelRef){
      // Only a TERMINAL block refuses an attempt outright. A transient
      // backoff is allocation input, not grounds to strand the session.
      // No decision record at all means the router has not decided yet
      // (first call, or a retry after a failure cleared it) — that is not
      // evidence the route is wrong. Only a record that exists and does not
      // cover this model is real drift.
      const blockedUntil=state.blockedModels?.[modelRef];
      const facts=lastAttemptContext?attemptFacts(ctx,lastAttemptContext,modelRef):undefined;
      const admitted=blockedUntil>Date.now()?{ok:false as const,reason:'route is not served by the upstream'}
        :facts?admitAttempt(facts.model,facts.input,auto?lastAttemptContext.tier:undefined)
        :!lastAttemptContext||!auto?{ok:true as const}
        :{ok:false as const,reason:'route was never admitted by the routing decision'};
      if(!admitted.ok){
        blocked=true;ctx.abort();log('attempt-blocked',{model:modelRef,decided:lastAttemptContext?.model,auto,reason:admitted.reason});
        notify(`Routing: rota atual inválida para esta chamada (${admitted.reason}).`,'warning');
        return;
      }
    }
    if(m?.provider!=='openrouter')return;
    releaseUndispatched();
    if(!m[GUARDED_OPENROUTER_MARKER]){blocked=true;ctx.abort();log('budget-blocked',{reason:'unguarded-openrouter-transport'});notify('OpenRouter: transporte sem proteção de orçamento; chamada interrompida.','warning');}
  });
  pi.on('message_end',async(event:any,ctx:any)=>{
    if(event.message?.role!=='assistant')return;
    const m=event.message;
    const actual=m.provider===ROUTER_PROVIDER?ref(route?.target):m.provider&&m.model?`${m.provider}/${m.model}`:isAuto(ctx.models.current())?ref(route?.target):ref(ctx.models.current());
    lastActual=actual;
    const gatewayResponse=m.provider==='9router';
    const active=gatewayResponse?undefined:ctx.modelRegistry.authStorage.listOAuthAccounts(m.provider??ctx.model?.provider,ctx.sessionManager.getSessionId()).find((a:any)=>a.active);
    const actualCanonicalModel=canonical(actual);
    log('response',{actualModel:actual,actualWireModel:actual,actualCanonicalModel,actualCredentialId:gatewayResponse||m.provider==='anthropic'&&settings().claudeAccountOwner==='meridian'?undefined:active?.credentialId,accountOwner:gatewayResponse?'gateway':m.provider==='anthropic'?settings().claudeAccountOwner??'omp-native':'omp-native',preferredProfile:m.provider==='anthropic'?state.claudeProfile:undefined,stopReason:m.stopReason,usage:m.usage?{input:m.usage.input,output:m.usage.output,cacheRead:m.usage.cacheRead,cacheWrite:m.usage.cacheWrite,nominalCost:m.usage.cost?.total}:undefined});
    if(m.provider==='openrouter')await reconcile(ctx);
    if(m.stopReason==='error'){
      state.providerFailed=true;
      // Two different facts, two different lifetimes. A model the upstream
      // does not serve is PERMANENT: it can never answer, so it is blocked
      // outright. Everything else —
      // timeouts, dropped connections, 5xx — is TRANSIENT: it steers
      // automatic allocation away for a few minutes but must never refuse an
      // attempt, or one network blip strands a session with no route at all.
      const permanent=unsupportedModel(m.error??m.errorMessage);
      if(permanent){
        if(actual){
          state.blockedModels={...state.blockedModels,[actual]:Date.now()+86_400_000};
          delete state.unavailableModels?.[actual];
        }
        log('model-unsupported',{model:actual});
        notify(`Routing: ${actual} não é servido pelo upstream; rota bloqueada.`,'warning');
      }
      // An unidentifiable responder cannot be backed off by ref; the profile path still applies.
      else if(m.provider==='anthropic'&&state.claudeProfile){state.unavailableProfiles={...state.unavailableProfiles,[state.claudeProfile]:Date.now()+180000};}
      else if(actual)state.unavailableModels={...state.unavailableModels,[actual]:Date.now()+180_000};
      save();
    } else if(m.stopReason==='stop'||m.stopReason==='toolUse'){
      state.providerFailed=false;
      if(actual&&state.unavailableModels)delete state.unavailableModels[actual];
      if(actual&&state.blockedModels)delete state.blockedModels[actual];
      if(m.provider==='anthropic'&&state.claudeProfile&&state.unavailableProfiles)delete state.unavailableProfiles[state.claudeProfile];
      save();
    }
  });
  // Retries do not emit message_end, so a permanent "model not supported" must
  // be recognized here or the host spends its whole retry budget on it. The
  // block lands before the next before_provider_request, which then refuses.
  pi.on('auto_retry_start',(event:any)=>{
    if(!unsupportedModel(event?.errorMessage))return;
    const target=lastActual;
    if(!target)return;
    state.blockedModels={...state.blockedModels,[target]:Date.now()+86_400_000};
    log('model-unsupported',{model:target,duringRetry:true});
    notify(`Routing: ${target} não é servido pelo upstream; rota bloqueada.`,'warning');
    save();
  });
  pi.on('agent_end',()=>{
    releaseUndispatched();
    status();
  });
  pi.on('session_shutdown',()=>{
    try{const agentId=ownAgentId(ctxCurrent);if(agentId)removeFanout(fanoutDir,agentId);}catch{}
    nineRouter.dispose();guard.dispose();releaseUndispatched();ledger?.close();ledger=undefined;});

  pi.registerCommand('route',{
    description:'Routing: status | roster | key [status|clear] | why | feedback fail/success | handoff | usage | refresh | reconcile. Auto = pick "Router (auto)" in /model; any concrete model is manual. "use strong/opus/..." in a prompt overrides for that turn.',
    handler:async(args:string,ctx:any)=>{
      ctxCurrent=ctx;
      const normalized=args.trim();
      const [cmd,...rest]=(normalized?normalized:'status').split(/\s+/);
      if(cmd==='feedback'){
        state.failedQualityChecks=rest[0]==='fail'?(state.failedQualityChecks??0)+1:0;notify(`Falhas de aceite registradas: ${state.failedQualityChecks}.`);
      // A handoff ends the phase but not the work: keep the goal, new epoch.
      }else if(cmd==='handoff'){state.handoffReady=true;state.phase=undefined;state.episode=advanceDecisionEpoch(state.episode);notify('Estado de trabalho preparado; próxima solicitação pode mudar de modelo/família.');}
      else if(cmd==='usage'){notify(JSON.stringify({gateway:nineRouter.enabled,gatewayUsage:usageSummary(readGatewayUsage())},null,2));return;}
      else if(cmd==='refresh'){
        if(!nineRouter.enabled){notify('Telemetria 9Router indisponível.','warning');return;}
        usageRefreshAt=0;
        try{gatewayUsage=await refreshNineRouterUsage(root,{timeoutMs:15000,force:true});log('ninerouter-usage-refreshed',usageSummary(gatewayUsage));notify(JSON.stringify(usageSummary(gatewayUsage),null,2));}
        catch(error:any){log('ninerouter-usage-refresh-error',{errorType:error?.name??'Error'});notify('Telemetria 9Router indisponível.','warning');}
        return;
      }
      else if(cmd==='roster'){
        // Review catalog findings and vet candidates by actually running them.
        // Only models the gateway serves are probeable; models.dev lists more
        // than the transport can reach, and probing an unsupported id makes the
        // upstream 401 the whole account for a cooldown.
        const servable=new Set<string>();
        const wireById=new Map<string,string>();
        if(nineRouter.enabled){
          for(const m of nineRouter.models){
            const wire=`${m.provider}/${m.id}`;
            const bare=String(m.id).split('/').pop()!;
            servable.add(bare);
            if(!wireById.has(bare))wireById.set(bare,String(m.id));
          }
        }
        let gatewayCreds:{baseUrl:string;apiKey:string}|undefined;
        try{
          const key=readFileSync(join(root,'9router-key'),'utf8').trim();
          const baseUrl=settings().gateway?.baseUrl;
          if(key&&typeof baseUrl==='string')gatewayCreds={baseUrl,apiKey:key};
        }catch{}
        await showRoster({
          ui:{select:(t,o)=>ctx.ui.select(t,o),confirm:(t,m)=>ctx.ui.confirm(t,m),notify:(m,l)=>notify(m,l??'info')},
          root,
          gateway:gatewayCreds,
          servable,
          wireRefFor:(id)=>wireById.get(id),
          log,
        });
        return;
      }
      else if(cmd==='key'){
        // One-time setup. The key is read straight from 1Password (`op`) into
        // omp's credential store, the same place every other provider key
        // lives, so it survives shells and restarts. It is deliberately NOT a
        // command argument: omp persists slash commands verbatim in history.db,
        // so `/route key <secret>` would write the secret to disk forever.
        const auth=ctx.modelRegistry?.authStorage;
        if(!auth?.set){notify('Cofre de credenciais indisponível nesta sessão.','warning');return;}
        const sub=rest[0];
        if(sub==='clear'){await auth.remove(TYPESAFE_PROVIDER);assessmentCache.clear();notify('Chave TypeSafe removida do cofre.');log('command',{command:'key',action:'clear'});return;}
        if(sub==='status'){const present=!!(await typesafeKey());notify(present?'Chave TypeSafe presente.':'Nenhuma chave TypeSafe.');return;}
        if(sub!==undefined){notify('Uso: /route key | status | clear. A chave vem do 1Password, nunca do argumento.','warning');return;}
        let key='';
        try{key=(await readTypesafeKeyFromOp()).trim();}
        catch(error:any){log('command',{command:'key',action:'import-failed',errorType:error?.name??'Error'});notify('Não consegui ler a chave do 1Password (item "AgentKit - Typesafe"). O 1Password pode pedir Touch ID.','warning');return;}
        if(!/^apikey_[A-Za-z0-9_-]{20,}$/.test(key)){notify('Chave lida do 1Password tem formato inesperado; nada gravado.','warning');return;}
        await auth.set(TYPESAFE_PROVIDER,{type:'api_key',key,source:'login'});
        assessmentCache.clear();
        notify(`Chave TypeSafe importada (${key.slice(0,10)}…, ${key.length} chars). Auto agora é regras + Jev.`);
        log('command',{command:'key',action:'import',prefix:key.slice(0,7),length:key.length});
        return;
      }
      else if(cmd==='reconcile'){await reconcile(ctx);notify(JSON.stringify(budget().snapshot(),null,2));return;}
      else if(cmd==='why'||cmd==='explain'){
        // One deterministic sentence built from validated fields; nothing generated.
        if(!isAuto(ctx.models.current())){notify(`Manual: ${ref(ctx.models.current())} escolhido em /model; routing automático não se aplica.`);return;}
        const d=lastStatus;
        if(!d){notify('Auto: nenhuma decisão ainda nesta sessão.');return;}
        const trace=lastSemanticTrace;
        const jev=trace?.result==='assessed'?`Jev avaliou ${trace.tierAssessed}/${trace.phaseAssessed}${trace.truncated?' (contexto truncado)':''}`:trace?.result?`Jev indisponível (${trace.result})`:semanticMode==='off'?'Jev sem chave (/route key liga)':'Jev não consultado';
        const origin=lastSource==='override'?'; o prompt nomeou o tier':lastSource==='jev'?'e a avaliação moldou a decisão':lastSource==='rules'&&trace?.result==='assessed'?'mas as regras prevaleceram':'; regras determinísticas decidiram';
        const chosen=d.model?`${d.model.split('/').pop()} (${d.tier}, ${d.phase})`:'nenhuma rota';
        const quota=d.quotaState?`, quota ${d.quotaState}`:'';
        notify(`Auto: ${chosen}${quota}. ${jev} ${origin}. ${d.reason}`);
        return;
      }
      else {notify(JSON.stringify({version:VERSION,auto:isAuto(ctx.models.current()),route:state.route,childFloor:state.childFloor,child,current:ref(ctx.models.current()),decision:lastStatus,source:lastSource,providerFailure:diagnostics.failure,quota:lastQuota?.quota,gateway:nineRouter.enabled,gatewayUsage:usageSummary(readGatewayUsage()),semantic:{mode:semanticSettings().mode,effective:semanticMode,last:lastSemanticTrace},blocked,budget:budget().snapshot(),logs:join(root,'events.jsonl')},null,2));return;}
      save();status();log('command',{command:cmd});
    }
  });
}
