async function call(action,payload){const r=await window.ringhi.backupFiles(action,payload);if(!r.ok){const e=new Error(r.error.message);e.name=r.error.code==='ENOENT'?'NotFoundError':r.error.name||'Error';throw e;}return r.data;}
class Directory {
 constructor(root,parts=[]){this.root=root;this.parts=parts;this.kind='directory';this.name=parts.at(-1)||root.name;this.path=root.path+(parts.length?'/'+parts.join('/'): '');}
 async getDirectoryHandle(name,{create=false}={}){const parts=[...this.parts,name];await call('directory',{token:this.root.token,parts,create});return new Directory(this.root,parts);}
 async getFileHandle(name,{create=false}={}){
  const parts=[...this.parts,name],payload={token:this.root.token,parts};await call('file',{...payload,create});
  return {kind:'file',name,getFile:async()=>new File([new Uint8Array(await call('read',payload))],name),createWritable:async()=>{let bytes=null,closed=false;return {write:async data=>{if(closed)throw Error('备份写入已关闭');bytes=data instanceof Blob?new Uint8Array(await data.arrayBuffer()):typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data);},close:async()=>{if(closed)throw Error('备份写入已关闭');await call('write',{...payload,bytes:bytes||new Uint8Array()});closed=true;},abort:async()=>{closed=true;bytes=null;}};}};
 }
}
export async function pickBackupDirectory(options={}){const root=await call('select',{remember:options.id!=='ml307h-recovery'});if(!root)throw new DOMException('已取消选择，保留原备份目录','AbortError');return new Directory(root);}
export async function defaultBackupDirectory(){return new Directory(await call('default'));}
