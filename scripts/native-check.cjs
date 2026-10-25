const {NativeService}=require('../desktop/native/service.cjs');
(async()=>{const service=new NativeService();try{console.log(JSON.stringify(await service.diagnose({mode:'dual',filters:[{vendorId:0x303a,productId:0x1001}]}),null,2));}finally{await service.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
