import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unsubscribeConfig } from "./unsubscribe-client.mjs";

const match=readFileSync("C:/Users/Dallan/.codex/s6e5c3r8e2c9t9s","utf8").match(/^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.*?)\s*$/m);
const key=match?.[1]?.replace(/^['"]|['"]$/g,"");
if(!key) throw new Error("Missing CLOUDFLARE_API_TOKEN");
async function api(path,method="GET",body) {
  const response=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers:{Authorization:`Bearer ${key}`,...(body instanceof FormData?{}:{"Content-Type":"application/json"})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const result=await response.json();
  if(!response.ok || !result.success) throw new Error(`Cloudflare ${method} ${path} failed (${response.status}): ${result.errors?.map(e=>e.code).join(",")}`);
  return result.result;
}
const accounts=await api("/accounts");
const account=accounts.find(a=>a.id==="e4814c5745539569e6145ceab9dc8474");
if(!account) throw new Error("Expected Cloudflare account unavailable");
const base=`/accounts/${account.id}`;
const name="daily-yield-unsubscribe";
const subdomain=await api(`${base}/workers/subdomain`);
const databases=await api(`${base}/d1/database?name=${name}`);
let database=databases.find(d=>d.name===name);
if(!database) database=await api(`${base}/d1/database`,"POST",{name});
await api(`${base}/d1/database/${database.uuid}/query`,"POST",{sql:"CREATE TABLE IF NOT EXISTS unsubscribes (id TEXT PRIMARY KEY, unsubscribed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"});
const config=existsSync("data/unsubscribe-config.json")?unsubscribeConfig():{url:`https://${name}.${subdomain.subdomain}.workers.dev`,tokenKey:randomBytes(32).toString("hex"),statusKey:randomBytes(32).toString("hex")};
const metadata={main_module:"unsubscribe-worker.mjs",compatibility_date:"2026-10-10",bindings:[{type:"d1",name:"DB",id:database.uuid},{type:"secret_text",name:"TOKEN_KEY",text:config.tokenKey},{type:"secret_text",name:"STATUS_KEY",text:config.statusKey}]};
const form=new FormData(); form.set("metadata",JSON.stringify(metadata));form.set("unsubscribe-worker.mjs",new Blob([readFileSync("unsubscribe-worker.mjs","utf8")],{type:"application/javascript+module"}),"unsubscribe-worker.mjs");
await api(`${base}/workers/scripts/${name}`,"PUT",form);
await api(`${base}/workers/scripts/${name}/subdomain`,"POST",{enabled:true});
if(!existsSync("data/unsubscribe-config.json")) {
  const protectedResult=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command","$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:JSON.stringify(config),encoding:"utf8",windowsHide:true});
  if(protectedResult.status!==0) throw new Error("Cannot protect local unsubscribe configuration");
  mkdirSync("data",{recursive:true});writeFileSync("data/unsubscribe-config.json",JSON.stringify({protected:protectedResult.stdout}));
}
console.log(`Unsubscribe endpoint deployed: ${config.url}`);
